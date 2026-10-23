//! 用户内容包目录：扫描、安装、卸载、打开目录。
//!
//! 目录布局与官方内容根同构（见 `manifest` 模块文档）：
//! ```text
//! %APPDATA%\app.lull.desktop\content\<scene-id>\catalog.json
//! %APPDATA%\app.lull.desktop\content\<scene-id>\scenes\<name>\index.html
//! ```
//! `LULL_CONTENT_DIR` 可覆盖根目录（开发/测试）。安装器只接受**文件夹或 zip**：
//! 解压到 `.staging-*` → 校验清单 → 复核整包摘要 → 通过后才 rename 进根目录；
//! 任何一步失败都只清 staging，不碰已安装内容。

use super::digest;
use super::manifest::{self, MANIFEST_FILE};
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 单包文件数上限。
const MAX_FILES: usize = 512;
/// 单文件上限。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 整个 bundle 解压后上限（含清单与资源）。
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const STAGING_PREFIX: &str = ".staging-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPackageInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: Option<String>,
  pub author: Option<String>,
  pub license: Option<String>,
  /// `ready`（可用）/ `invalid`（清单不可用）/ `tampered`（摘要不匹配）。
  pub status: String,
  pub error: Option<String>,
  pub entry_url: String,
  /// 是否通过整包摘要校验；手动放置且未声明摘要的包为 false。
  pub verified: bool,
  /// 单条 scene 清单原文，前端用 `parseSceneManifest()` 再校验一次。
  pub manifest: Value,
}

/// 内容包根目录：`LULL_CONTENT_DIR` 优先，否则 app_data_dir/content。
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("LULL_CONTENT_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("content"))
    .map_err(|error| error.to_string())
}

pub fn package_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(root(app)?.join(id))
}

pub fn entry_url(id: &str, entry: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullcontent.localhost";
  #[cfg(not(windows))]
  let origin = "lullcontent://localhost";
  format!("{origin}/{id}/{}", entry.trim_start_matches('/'))
}

/// 扫描已安装内容包；单个包坏掉不影响其它包。
pub fn list(app: &AppHandle) -> Vec<ContentPackageInfo> {
  let Ok(root) = root(app) else {
    return Vec::new();
  };
  let Ok(entries) = std::fs::read_dir(&root) else {
    return Vec::new();
  };
  let mut packages: Vec<ContentPackageInfo> = Vec::new();
  for entry in entries.filter_map(Result::ok) {
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    if dir_name.starts_with('.') || !path.join(MANIFEST_FILE).is_file() {
      continue;
    }
    packages.push(inspect(&path, dir_name));
  }
  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

/// 读取单个 bundle 并校验摘要。
fn inspect(bundle: &Path, fallback_id: &str) -> ContentPackageInfo {
  let registration = match manifest::parse(bundle) {
    Ok(registration) => registration,
    Err(error) => return invalid_info(fallback_id, &error),
  };

  let (verified, digest_error) = match &registration.integrity {
    Some(expected) => {
      let package = bundle.join(&registration.package_rel);
      match digest::compute(&registration.id, &registration.version, &package) {
        Ok(actual) if actual == *expected => (true, None),
        Ok(actual) => (
          false,
          Some(format!("内容包摘要不匹配：声明 {expected}，实际 {actual}")),
        ),
        Err(error) => (false, Some(error)),
      }
    }
    // 手动放置的包允许不带摘要：可用，但标记为「未校验」。
    None => (false, None),
  };

  let status = if verified || registration.integrity.is_none() {
    "ready"
  } else {
    "tampered"
  };

  ContentPackageInfo {
    id: registration.id.clone(),
    name: registration.name.clone(),
    version: registration.version.clone(),
    description: optional_string(&registration.manifest, "description"),
    author: optional_string(&registration.manifest, "author"),
    license: optional_string(&registration.manifest, "license"),
    status: status.to_string(),
    error: digest_error,
    entry_url: entry_url(&registration.id, &registration.entry),
    verified,
    manifest: registration.manifest,
  }
}

fn optional_string(manifest: &Value, key: &str) -> Option<String> {
  manifest.get(key).and_then(Value::as_str).map(str::to_string)
}

fn invalid_info(id: &str, error: &str) -> ContentPackageInfo {
  ContentPackageInfo {
    id: id.to_string(),
    name: id.to_string(),
    version: "-".to_string(),
    description: None,
    author: None,
    license: None,
    status: "invalid".to_string(),
    error: Some(error.to_string()),
    entry_url: String::new(),
    verified: false,
    manifest: Value::Null,
  }
}

/// 从文件夹或 zip 安装；成功后返回新包状态。
pub fn install(app: &AppHandle, source: &Path) -> Result<ContentPackageInfo, String> {
  let root = root(app)?;
  std::fs::create_dir_all(&root).map_err(|error| format!("创建内容目录失败：{error}"))?;
  let staging = root.join(format!("{STAGING_PREFIX}{}", unique_suffix()));
  std::fs::create_dir_all(&staging).map_err(|error| format!("创建安装暂存目录失败：{error}"))?;

  let result = install_staged(&root, &staging, source);
  // 无论成功失败都清掉暂存区：失败时不能留下半成品，成功时也已 rename 走。
  let _ = std::fs::remove_dir_all(&staging);
  result
}

fn install_staged(root: &Path, staging: &Path, source: &Path) -> Result<ContentPackageInfo, String> {
  let metadata = std::fs::metadata(source)
    .map_err(|error| format!("找不到内容包 {}：{error}", source.display()))?;

  if metadata.is_dir() {
    copy_tree(source, &staging.join("bundle"))?;
  } else if is_zip(source) {
    extract_zip(source, staging)?;
  } else {
    return Err("只支持文件夹或 .zip 内容包".to_string());
  }

  let bundle_dir = locate_bundle(staging)?;
  let registration = manifest::parse(&bundle_dir)?;
  let expected = registration.integrity.clone().ok_or_else(|| {
    "catalog.json 缺少 integrity 摘要：安装器只接受声明了整包摘要的内容包".to_string()
  })?;
  let package = bundle_dir.join(&registration.package_rel);
  let actual = digest::compute(&registration.id, &registration.version, &package)?;
  if actual != expected {
    return Err(format!("内容包摘要不匹配：声明 {expected}，实际 {actual}"));
  }

  let target = root.join(&registration.id);
  if target.exists() {
    return Err(format!(
      "已安装 id={} 的内容包，请先卸载再安装",
      registration.id
    ));
  }
  std::fs::rename(&bundle_dir, &target).map_err(|error| format!("安装失败：{error}"))?;
  Ok(inspect(&target, &registration.id))
}

fn is_zip(path: &Path) -> bool {
  path
    .extension()
    .and_then(|extension| extension.to_str())
    .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

/// zip 里可能套一层目录；找到真正含 `catalog.json` 的那一层。
fn locate_bundle(staging: &Path) -> Result<PathBuf, String> {
  if staging.join(MANIFEST_FILE).is_file() {
    return Ok(staging.to_path_buf());
  }
  let mut dirs: Vec<PathBuf> = Vec::new();
  if let Ok(entries) = std::fs::read_dir(staging) {
    for entry in entries.filter_map(Result::ok) {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      if name.starts_with('.') {
        continue;
      }
      if entry.path().is_dir() {
        dirs.push(entry.path());
      }
    }
  }
  if dirs.len() == 1 {
    if let Some(candidate) = dirs.pop() {
      if candidate.join(MANIFEST_FILE).is_file() {
        return Ok(candidate);
      }
    }
  }
  Err("内容包里没有找到 catalog.json".to_string())
}

/// 复制目录（拒绝符号链接，带体积与数量上限）。
fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
  let mut budget = Budget::default();
  copy_dir(source, target, &mut budget)
}

fn copy_dir(source: &Path, target: &Path, budget: &mut Budget) -> Result<(), String> {
  std::fs::create_dir_all(target).map_err(|error| format!("创建目录失败：{error}"))?;
  let entries = std::fs::read_dir(source)
    .map_err(|error| format!("读取 {} 失败：{error}", source.display()))?;
  for entry in entries {
    let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
    let path = entry.path();
    let file_type = entry
      .file_type()
      .map_err(|error| format!("读取文件类型失败：{error}"))?;
    if file_type.is_symlink() {
      return Err(format!("内容包不允许符号链接：{}", path.display()));
    }
    let Some(name) = path.file_name() else {
      continue;
    };
    let destination = target.join(name);
    if file_type.is_dir() {
      copy_dir(&path, &destination, budget)?;
      continue;
    }
    if !file_type.is_file() {
      continue;
    }
    let size = entry
      .metadata()
      .map_err(|error| format!("读取文件大小失败：{error}"))?
      .len();
    if size > MAX_FILE_BYTES {
      return Err(format!(
        "单个文件超过 {} MiB：{}",
        MAX_FILE_BYTES / (1024 * 1024),
        path.display()
      ));
    }
    budget.take(size)?;
    std::fs::copy(&path, &destination)
      .map_err(|error| format!("复制 {} 失败：{error}", path.display()))?;
  }
  Ok(())
}

/// 解压 zip 到暂存目录（拒绝 `..`、反斜杠、符号链接，带体积上限）。
fn extract_zip(source: &Path, staging: &Path) -> Result<(), String> {
  let file = std::fs::File::open(source)
    .map_err(|error| format!("打开 {} 失败：{error}", source.display()))?;
  let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("解析 zip 失败：{error}"))?;
  let mut budget = Budget::default();

  for index in 0..archive.len() {
    let mut entry = archive
      .by_index(index)
      .map_err(|error| format!("读取 zip 条目失败：{error}"))?;
    if entry.name().contains('\\') {
      return Err("zip 内含反斜杠路径，已拒绝".to_string());
    }
    if entry
      .unix_mode()
      .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
    {
      return Err("zip 内含符号链接，已拒绝".to_string());
    }
    let Some(relative) = entry.enclosed_name() else {
      return Err(format!("zip 内含不安全路径：{}", entry.name()));
    };
    if relative
      .components()
      .any(|component| !matches!(component, Component::Normal(_)))
    {
      return Err(format!("zip 内含不安全路径：{}", entry.name()));
    }

    let destination = staging.join(&relative);
    if entry.is_dir() {
      std::fs::create_dir_all(&destination).map_err(|error| format!("创建目录失败：{error}"))?;
      continue;
    }
    if let Some(parent) = destination.parent() {
      std::fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let size = entry.size();
    if size > MAX_FILE_BYTES {
      return Err(format!(
        "zip 内单个文件超过 {} MiB：{}",
        MAX_FILE_BYTES / (1024 * 1024),
        entry.name()
      ));
    }
    budget.take(size)?;

    let mut output = std::fs::File::create(&destination)
      .map_err(|error| format!("写入 {} 失败：{error}", destination.display()))?;
    // 再兜一层：按上限截断读取，避免 zip 头谎报大小。
    let copied = std::io::copy(&mut (&mut entry).take(MAX_FILE_BYTES + 1), &mut output)
      .map_err(|error| format!("解压 {} 失败：{error}", entry.name()))?;
    if copied > MAX_FILE_BYTES {
      return Err(format!(
        "zip 内单个文件超过 {} MiB：{}",
        MAX_FILE_BYTES / (1024 * 1024),
        entry.name()
      ));
    }
  }
  Ok(())
}

/// 卸载：只删除内容根目录下的直接子目录。
pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
  if !manifest::valid_id(id) {
    return Err("内容包 id 非法".to_string());
  }
  let root = root(app)?;
  let target = root.join(id);
  if !target.is_dir() {
    return Err(format!("没有安装 id={id} 的内容包"));
  }
  let canonical_root =
    std::fs::canonicalize(&root).map_err(|error| format!("内容目录不可用：{error}"))?;
  let canonical_target =
    std::fs::canonicalize(&target).map_err(|error| format!("内容包目录不可用：{error}"))?;
  if canonical_target.parent() != Some(canonical_root.as_path()) {
    return Err("拒绝删除内容目录之外的路径".to_string());
  }
  std::fs::remove_dir_all(&canonical_target).map_err(|error| format!("卸载失败：{error}"))
}

/// 在资源管理器里打开内容目录；返回路径供前端提示。
pub fn open_dir(app: &AppHandle) -> Result<String, String> {
  let root = root(app)?;
  std::fs::create_dir_all(&root).map_err(|error| format!("创建内容目录失败：{error}"))?;
  let display = root.to_string_lossy().to_string();
  app
    .opener()
    .open_path(display.clone(), None::<&str>)
    .map_err(|error| format!("打开内容目录失败：{error}"))?;
  Ok(display)
}

/// 安装预算：文件数 + 累计字节。
#[derive(Default)]
struct Budget {
  files: usize,
  bytes: u64,
}

impl Budget {
  fn take(&mut self, size: u64) -> Result<(), String> {
    self.files = self.files.saturating_add(1);
    self.bytes = self.bytes.saturating_add(size);
    if self.files > MAX_FILES {
      return Err(format!("内容包文件数超过上限 {MAX_FILES}"));
    }
    if self.bytes > MAX_TOTAL_BYTES {
      return Err(format!(
        "内容包解压后超过 {} MiB",
        MAX_TOTAL_BYTES / (1024 * 1024)
      ));
    }
    Ok(())
  }
}

fn unique_suffix() -> String {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|value| value.as_nanos())
    .unwrap_or_default();
  format!("{nanos:x}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-content-store-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  /// 造一个最小内容包：`<dir>/scenes/test/index.html` + `catalog.json`。
  fn write_bundle(dir: &Path, id: &str, entry_html: &str) -> Result<(), String> {
    let scene_dir = dir.join("scenes/test");
    std::fs::create_dir_all(&scene_dir).map_err(|error| error.to_string())?;
    std::fs::write(scene_dir.join("index.html"), entry_html).map_err(|error| error.to_string())?;
    let digest = digest::compute(id, "1.0.0", &scene_dir)?;
    let manifest = format!(
      r#"{{
        "schemaVersion": 1,
        "scenes": [
          {{
            "schemaVersion": 1,
            "type": "scene",
            "id": "{id}",
            "name": "测试场景",
            "version": "1.0.0",
            "license": "CC-BY-4.0",
            "entry": "scenes/test/index.html",
            "capabilities": ["wallpaper.viewport"],
            "integrity": {{"algorithm": "sha256", "scope": "package", "digest": "{digest}"}}
          }}
        ]
      }}"#
    );
    std::fs::write(dir.join(MANIFEST_FILE), manifest).map_err(|error| error.to_string())
  }

  #[test]
  fn installs_bundle_and_detects_tampering() {
    let Some(root) = temp_root("install") else {
      return;
    };
    let source = root.join("source-bundle");    if write_bundle(&source, "community.test", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staging = root.join(".staging-test");
    if std::fs::create_dir_all(&staging).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let installed = install_staged(&root, &staging, &source);
    assert!(installed.is_ok(), "安装失败：{installed:?}");
    if let Ok(info) = &installed {
      assert_eq!(info.id, "community.test");
      assert_eq!(info.status, "ready");
      assert!(info.verified);
      assert!(info
        .entry_url
        .ends_with("/community.test/scenes/test/index.html"));
    }
    let target = root.join("community.test");
    assert!(target.join(MANIFEST_FILE).is_file());
    assert!(target.join("scenes/test/index.html").is_file());

    // 改动包内容后，运行时检查必须判为 tampered。
    let _ = std::fs::write(target.join("scenes/test/index.html"), "<html>changed</html>");
    let inspected = inspect(&target, "community.test");
    assert_eq!(inspected.status, "tampered");
    assert!(inspected.error.is_some());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn rejects_bundle_without_integrity() {
    let Some(root) = temp_root("reject") else {
      return;
    };
    let source = root.join("source-bundle");
    if write_bundle(&source, "community.dup", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let manifest_path = source.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path).unwrap_or_default();
    let stripped: String = text
      .lines()
      .filter(|line| !line.contains("\"integrity\""))
      .collect::<Vec<_>>()
      .join("\n");
    let _ = std::fs::write(&manifest_path, stripped);

    let staging = root.join(".staging-test");
    let _ = std::fs::create_dir_all(&staging);
    assert!(install_staged(&root, &staging, &source).is_err());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn locate_bundle_digs_into_single_wrapped_directory() {
    let Some(staging) = temp_root("locate") else {
      return;
    };
    let inner = staging.join("community.test");
    let _ = std::fs::create_dir_all(&inner);
    let _ = std::fs::write(inner.join(MANIFEST_FILE), "{}");
    assert_eq!(locate_bundle(&staging).ok(), Some(inner));
    let _ = std::fs::remove_dir_all(&staging);
  }

  /// 端到端：用官方 `scenes/mist` 真实资源 + 官方摘要装一遍，
  /// 验证「创作者按文档打包 → 客户端可安装」这条链路。
  #[test]
  fn installs_official_mist_bundle() {
    let Some(root) = temp_root("mist") else {
      return;
    };
    let source = root.join("mist-bundle");
    let scene_dir = source.join("scenes/mist");
    let official = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/content/scenes/mist");
    if copy_tree(&official, &scene_dir).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let catalog = r#"{
      "schemaVersion": 1,
      "scenes": [
        {
          "schemaVersion": 1,
          "type": "scene",
          "id": "community.mist",
          "name": "雾岚",
          "version": "1.0.0",
          "license": "CC-BY-4.0",
          "entry": "scenes/mist/index.html",
          "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
          "integrity": {
            "algorithm": "sha256",
            "scope": "package",
            "digest": "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb"
          }
        }
      ]
    }"#;
    if std::fs::write(source.join(MANIFEST_FILE), catalog).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staging = root.join(".staging-mist");
    let _ = std::fs::create_dir_all(&staging);
    let installed = install_staged(&root, &staging, &source);
    assert!(installed.is_ok(), "官方示例包安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "community.mist");
      assert!(info.verified);
      assert_eq!(info.status, "ready");
      assert_eq!(info.license.as_deref(), Some("CC-BY-4.0"));
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  /// 用 zip 写作器造一个包再安装，覆盖 `extract_zip` 这条真实入口。
  #[test]
  fn installs_from_zip_archive() {
    use std::io::Write;

    let Some(root) = temp_root("zip") else {
      return;
    };
    // 先造好目录形态，拿到正确摘要，再把同样的字节塞进 zip。
    let source = root.join("source-bundle");
    if write_bundle(&source, "community.zipped", "<html>zipped</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let archive_path = root.join("bundle.zip");
    let Ok(file) = std::fs::File::create(&archive_path) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let entries = [
      ("catalog.json", source.join(MANIFEST_FILE)),
      (
        "scenes/test/index.html",
        source.join("scenes/test/index.html"),
      ),
    ];
    for (name, path) in entries {
      let Ok(bytes) = std::fs::read(&path) else {
        let _ = std::fs::remove_dir_all(&root);
        return;
      };
      if writer.start_file(name, options).is_err() || writer.write_all(&bytes).is_err() {
        let _ = std::fs::remove_dir_all(&root);
        return;
      }
    }
    if writer.finish().is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staging = root.join(".staging-zip");
    let _ = std::fs::create_dir_all(&staging);
    let installed = install_staged(&root, &staging, &archive_path);
    assert!(installed.is_ok(), "zip 安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "community.zipped");
      assert!(info.verified);
    }
    assert!(root.join("community.zipped/scenes/test/index.html").is_file());
    let _ = std::fs::remove_dir_all(&root);
  }

  /// zip 条目带 `..` 时必须整体拒绝，且不能在暂存区外落下任何文件。
  #[test]
  fn rejects_zip_slip_entries() {
    use std::io::Write;

    let Some(root) = temp_root("zipslip") else {
      return;
    };
    let archive_path = root.join("evil.zip");
    let Ok(file) = std::fs::File::create(&archive_path) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    if writer.start_file("../escaped.txt", options).is_err()
      || writer.write_all(b"nope").is_err()
    {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    if writer.finish().is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staging = root.join(".staging-slip");
    let _ = std::fs::create_dir_all(&staging);
    assert!(extract_zip(&archive_path, &staging).is_err());
    assert!(!root.join("escaped.txt").exists());
    let _ = std::fs::remove_dir_all(&root);
  }
}
