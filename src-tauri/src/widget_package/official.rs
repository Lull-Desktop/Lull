//! 官方（随应用分发）Widget：只读资源根、保留 id 与启动授权协调。
//!
//! 官方包与第三方包格式相同，区别只在来源、默认授权与升级策略；
//! 来源由解析到的目录判定，不读取清单里的 `builtin` 字段。

use crate::widget_package::manifest::{valid_id, PackageManifest};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 官方保留 id。用户从文件安装命中这些 id 时拒绝，避免遮挡随包分发的工具。
pub(crate) const RESERVED_IDS: [&str; 3] = ["echo", "noise", "player"];

const EXTENSIONS_DIR: &str = "extensions";
const ENV_DIR: &str = "LULL_EXTENSIONS_DIR";

#[derive(Debug, Clone)]
pub(crate) struct OfficialPackage {
  pub id: String,
  pub dir: PathBuf,
  pub manifest: PackageManifest,
}

/// 资源根：`LULL_EXTENSIONS_DIR` → debug 构建优先仓库 `extensions/dist`，
/// release 优先安装目录 `resource_dir()/extensions`。debug 优先仓库目录可以避免
/// Tauri 只在 Rust 构建时复制资源，导致改了官方包后仍加载旧的
/// `target/debug/extensions`。
pub(crate) fn root(app: &AppHandle) -> Option<PathBuf> {
  let env_dir = std::env::var_os(ENV_DIR).map(PathBuf::from);
  let resource_dir = app
    .path()
    .resource_dir()
    .ok()
    .map(|dir| dir.join(EXTENSIONS_DIR));
  let dev_dir = Some(dev_fallback());
  let candidates = if cfg!(debug_assertions) {
    [env_dir, dev_dir, resource_dir]
  } else {
    [env_dir, resource_dir, dev_dir]
  };
  pick_root(candidates)
}

fn dev_fallback() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("..")
    .join("extensions")
    .join("dist")
}

fn pick_root(candidates: [Option<PathBuf>; 3]) -> Option<PathBuf> {
  candidates.into_iter().flatten().find(|path| path.is_dir())
}

pub(crate) fn is_reserved(id: &str) -> bool {
  RESERVED_IDS.contains(&id)
}

/// 解析官方包目录；不存在或清单缺失时返回 `None`。
pub(crate) fn resolve(app: &AppHandle, id: &str) -> Option<PathBuf> {
  if !valid_id(id) {
    return None;
  }
  let dir = root(app)?.join(id);
  (dir.is_dir() && dir.join("widget.json").is_file()).then_some(dir)
}

/// 扫描并校验官方包；坏包只记日志，不阻断其它包。
pub(crate) fn packages(app: &AppHandle) -> Vec<OfficialPackage> {
  root(app).map_or_else(Vec::new, |dir| packages_from(&dir))
}

pub(crate) fn packages_from(root: &Path) -> Vec<OfficialPackage> {
  let Ok(entries) = std::fs::read_dir(root) else {
    return Vec::new();
  };
  let mut packages = Vec::new();
  for entry in entries.filter_map(Result::ok) {
    let dir = entry.path();
    if !dir.is_dir() {
      continue;
    }
    let Some(id) = dir.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    if id.starts_with('.') || !valid_id(id) || !dir.join("widget.json").is_file() {
      continue;
    }
    match PackageManifest::load(&dir, id) {
      Ok(manifest) => packages.push(OfficialPackage {
        id: id.to_string(),
        dir,
        manifest,
      }),
      Err(error) => eprintln!("[official] 跳过 {id}：{error}"),
    }
  }
  packages.sort_by(|left, right| left.id.cmp(&right.id));
  packages
}

/// 启动时协调官方包的授权：首次默认启用，升级补授新增能力，保留用户撤销。
pub(crate) fn reconcile(app: &AppHandle) {
  let packages = packages(app);
  if packages.is_empty() {
    return;
  }
  if let Err(error) = crate::widget_package::store::reconcile_official(app, &packages) {
    eprintln!("[official] 协调授权失败：{error}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn temp_dir(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-official-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_package(root: &Path, id: &str) -> std::io::Result<()> {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
      dir.join("widget.json"),
      format!(
        r#"{{
          "schemaVersion": 2,
          "type": "widget",
          "id": "{id}",
          "name": "Official {id}",
          "version": "1.0.0",
          "license": "GPL-3.0-or-later",
          "builtin": false,
          "hostApi": 1,
          "entry": "index.html",
          "capabilities": ["widget.ui"],
          "window": {{
            "width": 420,
            "height": 320,
            "minWidth": 360,
            "minHeight": 260,
            "resizable": false,
            "transparent": false,
            "chrome": "host"
          }}
        }}"#
      ),
    )?;
    std::fs::write(dir.join("index.html"), b"<!doctype html>")?;
    Ok(())
  }

  #[test]
  fn root_prefers_first_existing_candidate() {
    let Some(base) = temp_dir("root") else {
      return;
    };
    let first = base.join("missing");
    let second = base.join("resource-extensions");
    if std::fs::create_dir_all(&second).is_err() {
      let _ = std::fs::remove_dir_all(&base);
      return;
    }
    let picked = pick_root([Some(first.clone()), Some(second.clone()), None]);
    assert_eq!(picked.as_deref(), Some(second.as_path()));
    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn packages_from_skips_broken_and_dot_dirs() {
    let Some(root) = temp_dir("packages") else {
      return;
    };
    if write_package(&root, "echo").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let _ = std::fs::create_dir_all(root.join(".git"));
    let _ = std::fs::create_dir_all(root.join("Broken"));
    let packages = packages_from(&root);
    assert_eq!(packages.len(), 1);
    assert_eq!(
      packages.first().map(|package| package.id.as_str()),
      Some("echo")
    );
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn reserved_ids_cover_migrated_tools() {
    assert!(is_reserved("noise"));
    assert!(is_reserved("player"));
    assert!(!is_reserved("community-noise"));
  }
}
