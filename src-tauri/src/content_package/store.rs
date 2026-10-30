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
use crate::content_trust::{
  verify_installed, PackageClaim, PackageKind, SignatureInfo, TrustPolicy,
};
use crate::extension::install;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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
  /// 社区发布者签名状态；与摘要校验是两条独立的链。
  pub signature: SignatureInfo,
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
  let policy = crate::content_trust::policy::load(app);
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
    packages.push(inspect_with_policy(&path, dir_name, &policy));
  }
  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

/// 读取单个 bundle 并校验摘要 + 发布签名。
#[must_use]
fn inspect_with_policy(
  bundle: &Path,
  fallback_id: &str,
  policy: &TrustPolicy,
) -> ContentPackageInfo {
  let registration = match manifest::parse(bundle) {
    Ok(registration) => registration,
    Err(error) => return invalid_info(fallback_id, &error),
  };

  let package = bundle.join(&registration.package_rel);
  let computed = digest::compute(&registration.id, &registration.version, &package);
  let (verified, digest_error) = match (&registration.integrity, &computed) {
    (Some(expected), Ok(actual)) if actual == expected => (true, None),
    (Some(expected), Ok(actual)) => (
      false,
      Some(format!("内容包摘要不匹配：声明 {expected}，实际 {actual}")),
    ),
    (Some(_), Err(error)) => (false, Some(error.clone())),
    // 手动放置的包允许不带摘要：可用，但标记为「未校验」。
    (None, _) => (false, None),
  };

  let signature = match &computed {
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
    signature,
    manifest: registration.manifest,
  }
}

/// 读取单个 bundle（默认宽松策略）；安装路径由 `extension` 层先做门禁。
#[must_use]
fn inspect(bundle: &Path, fallback_id: &str) -> ContentPackageInfo {
  inspect_with_policy(bundle, fallback_id, &TrustPolicy::default())
}

fn optional_string(manifest: &Value, key: &str) -> Option<String> {
  manifest
    .get(key)
    .and_then(Value::as_str)
    .map(str::to_string)
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
    signature: SignatureInfo::unsigned(&TrustPolicy::default(), "manifest-invalid"),
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
    if copy_dir_all(&official, &scene_dir).is_err() {
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

    let installed = install_into(&root, &source);
    assert!(installed.is_ok(), "官方示例包安装失败：{installed:?}");
    if let Ok(info) = installed {
      assert_eq!(info.id, "community.mist");
      assert!(info.verified);
      assert_eq!(info.status, "ready");
      assert_eq!(info.license.as_deref(), Some("CC-BY-4.0"));
    }
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
}
