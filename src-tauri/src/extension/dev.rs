//! 开发模式：把本地目录挂进扩展中心，不复制文件、不锁摘要。
//!
//! 配置 `%APPDATA%\app.lull.desktop\extensions.json`；开发包仍走同一套清单校验、
//! 授权模型与 iframe 沙箱。关闭开发模式只销毁窗口与隐藏条目，不删除目录与授权账本。

use crate::widget_package::manifest::{valid_id, PackageManifest};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "extensions.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPackage {
  pub id: String,
  /// canonicalized 绝对路径；只在本机使用。
  pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevConfig {
  #[serde(default = "schema_version")]
  pub schema_version: u32,
  #[serde(default)]
  pub dev_mode: bool,
  #[serde(default)]
  pub dev_packages: Vec<DevPackage>,
}

fn schema_version() -> u32 {
  SCHEMA_VERSION
}

impl Default for DevConfig {
  fn default() -> Self {
    Self {
      schema_version: SCHEMA_VERSION,
      dev_mode: false,
      dev_packages: Vec::new(),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevState {
  pub dev_mode: bool,
  pub packages: Vec<DevPackage>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join(CONFIG_FILE))
    .map_err(|error| error.to_string())
}

pub fn load(app: &AppHandle) -> DevConfig {
  let Ok(path) = config_path(app) else {
    return DevConfig::default();
  };
  load_at(&path)
}

fn load_at(path: &Path) -> DevConfig {
  let Ok(text) = std::fs::read_to_string(path) else {
    return DevConfig::default();
  };
  serde_json::from_str(&text).unwrap_or_else(|error| {
    eprintln!("[extensions] 读取 {} 失败：{error}", path.display());
    DevConfig::default()
  })
}

fn save(app: &AppHandle, config: &DevConfig) -> Result<(), String> {
  let path = config_path(app)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, json).map_err(|error| error.to_string())?;
  if path.exists() {
    std::fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temp, &path).map_err(|error| error.to_string())
}

pub fn state(app: &AppHandle) -> DevState {
  let config = load(app);
  DevState {
    dev_mode: config.dev_mode,
    packages: config.dev_packages,
  }
}

pub fn enabled(app: &AppHandle) -> bool {
  load(app).dev_mode
}

pub fn contains(app: &AppHandle, id: &str) -> bool {
  load(app).dev_packages.iter().any(|package| package.id == id)
}

pub fn packages(app: &AppHandle) -> Vec<DevPackage> {
  load(app).dev_packages
}

/// 解析开发包目录；未开启开发模式或未挂载时返回 `None`。
pub fn resolve(app: &AppHandle, id: &str) -> Option<PathBuf> {
  let config = load(app);
  if !config.dev_mode {
    return None;
  }
  resolve_in(&config, id)
}

fn resolve_in(config: &DevConfig, id: &str) -> Option<PathBuf> {
  if !config.dev_mode {
    return None;
  }
  config
    .dev_packages
    .iter()
    .find(|package| package.id == id)
    .map(|package| PathBuf::from(&package.path))
}

/// 切换开发模式；关闭时销毁所有开发窗口，但保留配置与授权。
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<DevState, String> {
  let mut config = load(app);
  config.dev_mode = enabled;
  save(app, &config)?;
  if !enabled {
    for package in &config.dev_packages {
      let _ = crate::widget_package::stop(app, &package.id);
    }
  }
  Ok(state(app))
}

/// 挂载本地目录；id 与正式包冲突时拒绝。
pub fn add(app: &AppHandle, path: &Path) -> Result<PackageManifest, String> {
  if !enabled(app) {
    return Err("开发模式未开启".to_string());
  }
  let dir = std::fs::canonicalize(path)
    .map_err(|error| format!("本地目录不可用：{error}"))?;
  if !dir.is_dir() {
    return Err("只能挂载目录".to_string());
  }
  let manifest = PackageManifest::from_dir(&dir)?;
  if !valid_id(&manifest.id) {
    return Err(format!("id 非法：{}", manifest.id));
  }
  if !dir.join(&manifest.entry).is_file() {
    return Err(format!("entry 指向的文件不存在：{}", manifest.entry));
  }
  let installed = crate::widget_package::store::package_dir(app, &manifest.id)?;
  if installed.exists() {
    return Err(format!(
      "已安装同 id 的正式包 {}，请先卸载再挂载开发包",
      manifest.id
    ));
  }

  let mut config = load(app);
  if let Some(existing) = config
    .dev_packages
    .iter()
    .find(|package| package.id == manifest.id)
  {
    if Path::new(&existing.path) != dir {
      return Err(format!(
        "开发包 id={} 已指向 {}",
        manifest.id, existing.path
      ));
    }
  } else {
    config.dev_packages.push(DevPackage {
      id: manifest.id.clone(),
      path: dir.to_string_lossy().into_owned(),
    });
  }
  save(app, &config)?;
  Ok(manifest)
}

/// 取消挂载（不删除目录、不动授权账本；调用方负责撤销授权）。
pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
  let mut config = load(app);
  let before = config.dev_packages.len();
  config.dev_packages.retain(|package| package.id != id);
  if config.dev_packages.len() == before {
    return Err(format!("没有挂载 id={id} 的开发包"));
  }
  save(app, &config)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolve_requires_dev_mode_and_matching_id() {
    let config = DevConfig {
      schema_version: SCHEMA_VERSION,
      dev_mode: false,
      dev_packages: vec![DevPackage {
        id: "community-test".to_string(),
        path: "F:\\dev\\widget".to_string(),
      }],
    };
    assert!(resolve_in(&config, "community-test").is_none());
    let enabled = DevConfig {
      dev_mode: true,
      ..config
    };
    assert_eq!(
      resolve_in(&enabled, "community-test"),
      Some(PathBuf::from("F:\\dev\\widget"))
    );
    assert!(resolve_in(&enabled, "other").is_none());
  }

  #[test]
  fn load_corrupt_config_falls_back() {
    let dir = std::env::temp_dir().join(format!(
      "lull-dev-config-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    if std::fs::create_dir_all(&dir).is_err() {
      return;
    }
    let path = dir.join(CONFIG_FILE);
    let _ = std::fs::write(&path, "{not json");
    let config = load_at(&path);
    assert!(!config.dev_mode);
    assert!(config.dev_packages.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
