//! 内容包目录：官方随包场景与用户内容包的发现、安装、卸载、打开目录。
//!
//! 目录布局与官方内容根同构（见 `manifest` 模块文档）：
//! ```text
//! %APPDATA%\app.lull.desktop\content\<scene-id>\catalog.json
//! %APPDATA%\app.lull.desktop\content\<scene-id>\scenes\<name>\index.html
//! ```
//! 官方场景随安装包位于 `extensions/`（`LULL_EXTENSIONS_DIR` 可覆盖）：
//! ```text
//! extensions\<scene-id>\catalog.json
//! extensions\<scene-id>\scenes\<name>\index.html
//! ```
//! `LULL_CONTENT_DIR` 可覆盖用户根目录（开发/测试）。安装器只接受**文件夹或 zip**：
//! 解压到 `.staging-*` → 校验清单 → 复核整包摘要 → 通过后才 rename 进根目录；
//! 任何一步失败都只清 staging，不碰已安装内容。

use super::digest;
use super::manifest::{self, MANIFEST_FILE};
use crate::content_trust::{
  verify_installed, PackageClaim, PackageKind, SignatureInfo, TrustPolicy,
};
use crate::extension::install;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 官方场景保留 id：用户不能从文件安装同 id 的内容包来遮挡随包壁纸。
const RESERVED_IDS: [&str; 1] = ["lull.bamboo"];

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
  /// 社区发布者签名状态；与摘要校验是两条独立的链。官方包固定为未签名。
  pub signature: SignatureInfo,
  /// `bundled`（随应用分发）或 `user`（用户安装）。
  pub origin: String,
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

/// 官方扩展资源根（与 widget 共用同一套解析顺序），用于发现随包场景。
fn official_root(app: &AppHandle) -> Option<PathBuf> {
  crate::widget_package::official::root(app)
}

fn official_dir(app: &AppHandle, id: &str) -> Option<PathBuf> {
  if !manifest::valid_id(id) {
    return None;
  }
  let dir = official_root(app)?.join(id);
  (dir.is_dir() && dir.join(MANIFEST_FILE).is_file()).then_some(dir)
}

/// 官方场景按目录优先、用户内容目录兜底；资源协议与目录扫描共用这一处解析。
pub fn package_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if let Some(dir) = official_dir(app, id) {
    return Ok(dir);
  }
  Ok(root(app)?.join(id))
}

pub fn is_official(app: &AppHandle, id: &str) -> bool {
  official_dir(app, id).is_some()
}

pub(crate) fn is_reserved(id: &str) -> bool {
  RESERVED_IDS.contains(&id)
}

pub fn entry_url(id: &str, entry: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullcontent.localhost";
  #[cfg(not(windows))]
  let origin = "lullcontent://localhost";
  format!("{origin}/{id}/{}", entry.trim_start_matches('/'))
}

/// 扫描官方随包场景与用户内容包；官方在前，单个包坏掉不影响其它包。
pub fn list(app: &AppHandle) -> Vec<ContentPackageInfo> {
  let policy = crate::content_trust::policy::load(app);
  let mut packages = official_root(app)
    .map(|root| list_packages(&root, "bundled", &policy, true))
    .unwrap_or_default();
  if let Ok(root) = root(app) {
    packages.extend(list_packages(&root, "user", &policy, false));
  }
  packages
}

fn list_packages(
  dir: &Path,
  origin: &str,
  policy: &TrustPolicy,
  require_dir_id: bool,
) -> Vec<ContentPackageInfo> {
  let Ok(entries) = std::fs::read_dir(dir) else {
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
    if origin == "user" && is_reserved(dir_name) {
      eprintln!("[official] 忽略用户内容包 {dir_name}：与官方场景 id 冲突");
      continue;
    }
    let info = inspect_with_policy(&path, dir_name, policy, origin);
    if require_dir_id && info.id != dir_name {
      eprintln!(
        "[official] 忽略场景 {dir_name}：清单 id={} 与目录名不一致",
        info.id
      );
      continue;
    }
    packages.push(info);
  }
  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

/// 读取单个 bundle 并校验摘要 + 发布签名。官方包只做摘要校验，不参与社区签名策略。
#[must_use]
fn inspect_with_policy(
  bundle: &Path,
  fallback_id: &str,
  policy: &TrustPolicy,
  origin: &str,
) -> ContentPackageInfo {
  let registration = match manifest::parse(bundle) {
    Ok(registration) => registration,
    Err(error) => return invalid_info(fallback_id, &error, origin),
  };
  let official = origin == "bundled";

  let package = bundle.join(&registration.package_rel);
  let computed = digest::compute(&registration.id, &registration.version, &package);
  let missing_integrity = official && registration.integrity.is_none();
  let (verified, digest_error) = match (&registration.integrity, &computed) {
    (Some(expected), Ok(actual)) if actual == expected => (true, None),
    (Some(expected), Ok(actual)) => (
      false,
      Some(format!("内容包摘要不匹配：声明 {expected}，实际 {actual}")),
    ),
    (Some(_), Err(error)) => (false, Some(error.clone())),
    // 手动放置的用户包允许不带摘要：可用，但标记为「未校验」。
    // 官方包必须带摘要锁，缺锁按 invalid 处理。
    (None, _) => (false, None),
  };

  let signature = if official {
    // 官方包由安装包承载分发信任；不读取社区发布者签名。
    SignatureInfo::unsigned(&TrustPolicy::default(), "official-bundle")
  } else {
    match &computed {
      Ok(actual) => verify_installed(
        bundle,
        &PackageClaim {
          kind: PackageKind::Scene,
          id: registration.id.clone(),
          version: registration.version.clone(),
          digest: actual.clone(),
        },
        policy,
      ),
      Err(_) => SignatureInfo::unsigned(policy, "digest-unavailable"),
    }
  };

  let (status, error) = if missing_integrity {
    (
      "invalid",
      Some("官方扩展缺少摘要锁，请重装应用".to_string()),
    )
  } else if verified || (!official && registration.integrity.is_none()) {
    ("ready", digest_error)
  } else {
    ("tampered", digest_error)
  };

  ContentPackageInfo {
    id: registration.id.clone(),
    name: registration.name.clone(),
    version: registration.version.clone(),
    description: optional_string(&registration.manifest, "description"),
    author: optional_string(&registration.manifest, "author"),
    license: optional_string(&registration.manifest, "license"),
    status: status.to_string(),
    error,
    entry_url: entry_url(&registration.id, &registration.entry),
    verified,
    signature,
    origin: origin.to_string(),
    manifest: registration.manifest,
  }
}

/// 读取单个 bundle（默认宽松策略）；安装路径由 `extension` 层先做门禁。
#[must_use]
fn inspect(bundle: &Path, fallback_id: &str) -> ContentPackageInfo {
  inspect_with_policy(bundle, fallback_id, &TrustPolicy::default(), "user")
}

fn optional_string(manifest: &Value, key: &str) -> Option<String> {
  manifest
    .get(key)
    .and_then(Value::as_str)
    .map(str::to_string)
}

fn invalid_info(id: &str, error: &str, origin: &str) -> ContentPackageInfo {
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
    signature: SignatureInfo::unsigned(&TrustPolicy::default(), "manifest-invalid"),
    origin: origin.to_string(),
    manifest: Value::Null,
  }
}

/// 从文件夹或 zip 安装；仅测试与旧调用路径使用，正式入口是 `extensions_install`。
#[cfg(test)]
fn install_into(root: &Path, source: &Path) -> Result<ContentPackageInfo, String> {
  let staged = install::stage(root, source).map_err(|error| error.to_string())?;
  install_staged(root, &staged)
}

/// 复用共享 staging：调用方负责 `Staged` 的生命周期。
pub fn install_staged(root: &Path, staged: &install::Staged) -> Result<ContentPackageInfo, String> {
  let registration = manifest::parse(staged.bundle())?;
  if is_reserved(&registration.id) {
    return Err(format!(
      "{} 是官方保留 id，不能作为用户内容包安装",
      registration.id
    ));
  }
  let expected = registration.integrity.clone().ok_or_else(|| {
    "catalog.json 缺少 integrity 摘要：安装器只接受声明了整包摘要的内容包".to_string()
  })?;
  let package = staged.bundle().join(&registration.package_rel);
  let actual = digest::compute(&registration.id, &registration.version, &package)?;
  if actual != expected {
    return Err(format!("内容包摘要不匹配：声明 {expected}，实际 {actual}"));
  }
  let target = staged
    .commit_replace(root, &registration.id)
    .map_err(|error| error.to_string())?;
  Ok(inspect(&target, &registration.id))
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
    write_bundle_version(dir, id, "1.0.0", entry_html)
  }

  fn write_bundle_version(
    dir: &Path,
    id: &str,
    version: &str,
    entry_html: &str,
  ) -> Result<(), String> {
    let scene_dir = dir.join("scenes/test");
    std::fs::create_dir_all(&scene_dir).map_err(|error| error.to_string())?;
    std::fs::write(scene_dir.join("index.html"), entry_html).map_err(|error| error.to_string())?;
    let digest = digest::compute(id, version, &scene_dir)?;
    let manifest = format!(
      r#"{{
        "schemaVersion": 1,
        "scenes": [
          {{
            "schemaVersion": 1,
            "type": "scene",
            "id": "{id}",
            "name": "测试场景",
            "version": "{version}",
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

  fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
      let entry = entry?;
      let path = entry.path();
      let destination = target.join(entry.file_name());
      if entry.file_type()?.is_dir() {
        copy_dir_all(&path, &destination)?;
      } else {
        std::fs::copy(&path, &destination)?;
      }
    }
    Ok(())
  }

  #[test]
  fn installs_bundle_and_detects_tampering() {
    let Some(root) = temp_root("install") else {
      return;
    };
    let source = root.join("source-bundle");
    if write_bundle(&source, "community.test", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let installed = install_into(&root, &source);
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
    let _ = std::fs::write(
      target.join("scenes/test/index.html"),
      "<html>changed</html>",
    );
    let inspected = inspect(&target, "community.test");
    assert_eq!(inspected.status, "tampered");
    assert!(inspected.error.is_some());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn reinstalls_same_scene_id_with_new_version() {
    let Some(root) = temp_root("replace") else {
      return;
    };
    let v1 = root.join("v1");
    if write_bundle_version(&v1, "community.up", "1.0.0", "<html>v1</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let first = install_into(&root, &v1);
    assert!(first.is_ok(), "首次安装失败：{first:?}");
    if let Ok(info) = &first {
      assert_eq!(info.version, "1.0.0");
    }

    let v2 = root.join("v2");
    if write_bundle_version(&v2, "community.up", "1.1.0", "<html>v2</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let second = install_into(&root, &v2);
    assert!(second.is_ok(), "覆盖安装失败：{second:?}");
    if let Ok(info) = second {
      assert_eq!(info.version, "1.1.0");
      assert!(info.verified);
    }
    let installed =
      std::fs::read_to_string(root.join("community.up/scenes/test/index.html")).unwrap_or_default();
    assert!(installed.contains("v2"));

    let leftovers = std::fs::read_dir(&root)
      .ok()
      .into_iter()
      .flatten()
      .filter_map(Result::ok)
      .filter(|entry| {
        entry
          .file_name()
          .to_string_lossy()
          .starts_with(".replaced-")
      })
      .count();
    assert_eq!(leftovers, 0, "成功覆盖后不应留下备份目录");
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

    assert!(install_into(&root, &source).is_err());
    let _ = std::fs::remove_dir_all(&root);
  }

  /// 端到端：Three.js 示例（WebGL + 参数）按文档构建后可直接安装。
  #[test]
  fn installs_three_scene_example_bundle() {
    let Some(root) = temp_root("three-scene-dir") else {
      return;
    };
    let source = root.join("three-scene");
    let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/scenes/three-scene");
    if copy_dir_all(&example, &source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let installed = install_into(&root, &source);
    assert!(installed.is_ok(), "Three.js 示例安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "demo.three-scene");
      assert_eq!(info.version, "1.0.0");
      assert!(info.verified);
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  /// 端到端：示例脚本场景（wallpaper.script + params）按文档构建后可直接安装。
  #[test]
  fn installs_scripted_param_demo_bundle() {
    let Some(root) = temp_root("param-demo") else {
      return;
    };
    let source = root.join("param-demo");
    let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/scenes/param-demo");
    if copy_dir_all(&example, &source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let installed = install_into(&root, &source);
    assert!(installed.is_ok(), "示例脚本场景安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "demo.param-scene");
      assert!(info.verified);
      assert_eq!(info.status, "ready");
      assert_eq!(
        info
          .manifest
          .get("capabilities")
          .and_then(Value::as_array)
          .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        Some(vec![
          "wallpaper.viewport",
          "wallpaper.canvas",
          "wallpaper.params",
          "wallpaper.script"
        ])
      );
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

    let installed = install_into(&root, &archive_path);
    assert!(installed.is_ok(), "zip 安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "community.zipped");
      assert!(info.verified);
    }
    assert!(root
      .join("community.zipped/scenes/test/index.html")
      .is_file());
    let _ = std::fs::remove_dir_all(&root);
  }

  /// Windows 压缩工具会写反斜杠条目；安装器必须拒绝，避免路径语义分歧。
  #[test]
  fn rejects_zip_entries_with_backslashes() {
    use std::io::Write;

    let Some(root) = temp_root("zip-backslash") else {
      return;
    };
    let archive_path = root.join("bad.zip");
    let Ok(file) = std::fs::File::create(&archive_path) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    if writer
      .start_file("scenes\\param-demo\\index.html", options)
      .is_err()
      || writer.write_all(b"x").is_err()
      || writer.finish().is_err()
    {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staged = install::stage(&root, &archive_path);
    assert_eq!(
      staged.err().map(|error| error.code).as_deref(),
      Some("package.unsafe-entry")
    );
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
    if writer.start_file("../escaped.txt", options).is_err() || writer.write_all(b"nope").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    if writer.finish().is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }

    let staged = install::stage(&root, &archive_path);
    assert_eq!(
      staged.err().map(|error| error.code).as_deref(),
      Some("package.unsafe-entry")
    );
    assert!(!root.join("escaped.txt").exists());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn lists_official_scene_with_bundled_origin() {
    let Some(root) = temp_root("official-list") else {
      return;
    };
    let packages = root.join("extensions");
    let bundle = packages.join("lull.bamboo");
    if write_bundle_version(&bundle, "lull.bamboo", "1.2.0", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let policy = crate::content_trust::TrustPolicy::default();
    let listed = list_packages(&packages, "bundled", &policy, true);
    assert_eq!(listed.len(), 1);
    if let Some(info) = listed.first() {
      assert_eq!(info.id, "lull.bamboo");
      assert_eq!(info.origin, "bundled");
      assert_eq!(info.status, "ready");
      assert!(info.verified);
      assert!(info
        .entry_url
        .contains("/lull.bamboo/scenes/test/index.html"));
      assert_eq!(
        info.signature.status,
        crate::content_trust::verify::SignatureStatus::Unsigned
      );
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_scene_requires_and_verifies_integrity() {
    let Some(root) = temp_root("official-integrity") else {
      return;
    };
    let packages = root.join("extensions");
    let bundle = packages.join("lull.bamboo");
    if write_bundle_version(&bundle, "lull.bamboo", "1.2.0", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let policy = crate::content_trust::TrustPolicy::default();

    // 摘要不符：tampered
    let _ = std::fs::write(
      bundle.join("scenes/test/index.html"),
      "<html>changed</html>",
    );
    let tampered = list_packages(&packages, "bundled", &policy, true);
    assert_eq!(
      tampered.first().map(|info| info.status.as_str()),
      Some("tampered")
    );

    // 缺摘要锁：官方包 invalid，用户包仍 ready
    let mut catalog: Value = serde_json::from_str(
      &std::fs::read_to_string(bundle.join(MANIFEST_FILE)).unwrap_or_default(),
    )
    .unwrap_or(Value::Null);
    if let Some(scene) = catalog
      .get_mut("scenes")
      .and_then(|scenes| scenes.get_mut(0))
      .and_then(Value::as_object_mut)
    {
      scene.remove("integrity");
    }
    let _ = std::fs::write(bundle.join(MANIFEST_FILE), format!("{catalog}\n"));
    let official = list_packages(&packages, "bundled", &policy, true);
    assert_eq!(
      official.first().map(|info| info.status.as_str()),
      Some("invalid")
    );

    // 用户包不带摘要仍可手动放置：status=ready、verified=false。
    let user_packages = root.join("user");
    let user_bundle = user_packages.join("community.test");
    if write_bundle_version(&user_bundle, "community.test", "1.0.0", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let mut user_catalog: Value = serde_json::from_str(
      &std::fs::read_to_string(user_bundle.join(MANIFEST_FILE)).unwrap_or_default(),
    )
    .unwrap_or(Value::Null);
    if let Some(scene) = user_catalog
      .get_mut("scenes")
      .and_then(|scenes| scenes.get_mut(0))
      .and_then(Value::as_object_mut)
    {
      scene.remove("integrity");
    }
    let _ = std::fs::write(user_bundle.join(MANIFEST_FILE), format!("{user_catalog}\n"));
    let user = list_packages(&user_packages, "user", &policy, false);
    assert_eq!(user.first().map(|info| info.status.as_str()), Some("ready"));
    assert_eq!(user.first().map(|info| info.verified), Some(false));

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_scene_requires_dir_id_match_and_reserves_bamboo() {
    let Some(root) = temp_root("official-reserved") else {
      return;
    };
    let packages = root.join("extensions");
    let mismatch = packages.join("lull.bamboo");
    if write_bundle_version(&mismatch, "demo.other", "1.0.0", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let policy = crate::content_trust::TrustPolicy::default();
    assert!(list_packages(&packages, "bundled", &policy, true).is_empty());

    // 用户目录里同 id 的包被跳过，不能遮挡随包场景。
    let user_bamboo = packages.join("lull.bamboo");
    let _ = std::fs::remove_dir_all(&user_bamboo);
    if write_bundle_version(&user_bamboo, "lull.bamboo", "1.0.0", "<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    assert!(list_packages(&packages, "user", &policy, false).is_empty());
    assert!(is_reserved("lull.bamboo"));
    assert!(!is_reserved("community.mist"));

    let _ = std::fs::remove_dir_all(&root);
  }
}
