//! 开发模式：把本地目录挂进扩展中心，不复制文件、不锁摘要。
//!
//! 配置 `%APPDATA%\app.lull.desktop\extensions.json`；开发包仍走同一套清单校验、
//! 授权模型与 iframe 沙箱。关闭开发模式只销毁窗口与隐藏条目，不删除目录与授权账本。

use crate::widget_package::manifest::{valid_id, PackageManifest};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "extensions.json";
const DEV_ENTRY_FILE: &str = ".lull-dev.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPackage {
  pub id: String,
  /// canonicalized 绝对路径；只在本机使用。
  pub path: String,
  /// `.lull-dev.json` 声明的 Vite dev server；仅 debug 构建使用。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub entry_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevEntry {
  #[serde(default = "schema_version")]
  schema_version: u32,
  server: String,
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
  load(app)
    .dev_packages
    .iter()
    .any(|package| package.id == id)
}

pub fn packages(app: &AppHandle) -> Vec<DevPackage> {
  load(app).dev_packages
}

/// 开发服务器的 iframe 地址；未开启开发模式 / 非 debug / 未声明时返回 `None`。
pub fn entry_url(app: &AppHandle, id: &str) -> Option<String> {
  if !cfg!(debug_assertions) {
    return None;
  }
  entry_url_in(&load(app), id)
}

fn entry_url_in(config: &DevConfig, id: &str) -> Option<String> {
  if !config.dev_mode {
    return None;
  }
  config
    .dev_packages
    .iter()
    .find(|package| package.id == id)
    .and_then(|package| package.entry_url.clone())
}

/// 读取并校验包内 `.lull-dev.json`；文件不存在返回 `None`。
fn read_entry_url(dir: &Path) -> Result<Option<String>, String> {
  let path = dir.join(DEV_ENTRY_FILE);
  if !path.is_file() {
    return Ok(None);
  }
  if !cfg!(debug_assertions) {
    return Err("开发服务器仅 debug 构建可用；请改用构建产物目录".to_string());
  }
  let text = std::fs::read_to_string(&path)
    .map_err(|error| format!("读取 {DEV_ENTRY_FILE} 失败：{error}"))?;
  let entry: DevEntry = serde_json::from_str(&text)
    .map_err(|error| format!("{DEV_ENTRY_FILE} 不是合法 JSON：{error}"))?;
  if entry.schema_version != SCHEMA_VERSION {
    return Err(format!(
      "{DEV_ENTRY_FILE} 的 schemaVersion 必须是 {SCHEMA_VERSION}"
    ));
  }
  validate_dev_server(&entry.server).map(Some)
}

/// 只接受 loopback 的 http 开发服务器；拒绝外部主机、userinfo 与路径穿越。
fn validate_dev_server(raw: &str) -> Result<String, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("开发服务器地址不能为空".to_string());
  }
  let rest = trimmed
    .strip_prefix("http://")
    .ok_or_else(|| "开发服务器只支持 http://127.0.0.1 或 http://localhost".to_string())?;
  let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
  let authority = &rest[..authority_end];
  if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
    return Err("开发服务器地址格式非法".to_string());
  }
  let (host, port) = authority
    .rsplit_once(':')
    .ok_or_else(|| "开发服务器必须显式带端口".to_string())?;
  let port: u16 = port.parse().map_err(|_| "开发服务器端口非法".to_string())?;
  if port < 1024 {
    return Err("开发服务器端口必须在 1024–65535 之间".to_string());
  }
  if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
    return Err("开发服务器只允许 loopback 主机".to_string());
  }
  let tail = &rest[authority_end..];
  if tail.contains("..") || tail.contains('\\') || tail.contains('\0') {
    return Err("开发服务器地址包含非法路径".to_string());
  }
  let path = if tail.is_empty() { "/" } else { tail };
  Ok(format!("http://{host}:{port}{path}"))
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
  let dir = std::fs::canonicalize(path).map_err(|error| format!("本地目录不可用：{error}"))?;
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
  let entry_url = read_entry_url(&dir)?;
  let installed = crate::widget_package::store::package_dir(app, &manifest.id)?;
  if installed.exists() {
    return Err(format!(
      "已安装同 id 的正式包 {}，请先卸载再挂载开发包",
      manifest.id
    ));
  }

  let mut config = load(app);
  if let Some(index) = config
    .dev_packages
    .iter()
    .position(|package| package.id == manifest.id)
  {
    if Path::new(&config.dev_packages[index].path) != dir {
      return Err(format!(
        "开发包 id={} 已指向 {}",
        manifest.id, config.dev_packages[index].path
      ));
    }
    config.dev_packages[index].entry_url = entry_url;
  } else {
    config.dev_packages.push(DevPackage {
      id: manifest.id.clone(),
      path: dir.to_string_lossy().into_owned(),
      entry_url,
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
        entry_url: None,
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
  fn dev_entry_url_requires_mode_and_matching_id() {
    let config = DevConfig {
      schema_version: SCHEMA_VERSION,
      dev_mode: false,
      dev_packages: vec![DevPackage {
        id: "echo".to_string(),
        path: "F:\\dev\\echo".to_string(),
        entry_url: Some("http://127.0.0.1:5272/".to_string()),
      }],
    };
    assert!(entry_url_in(&config, "echo").is_none());
    let enabled = DevConfig {
      dev_mode: true,
      ..config
    };
    assert_eq!(
      entry_url_in(&enabled, "echo"),
      Some("http://127.0.0.1:5272/".to_string())
    );
    assert!(entry_url_in(&enabled, "other").is_none());
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

  #[test]
  fn dev_server_must_be_loopback_http_with_port() {
    assert_eq!(
      validate_dev_server("http://127.0.0.1:5273"),
      Ok("http://127.0.0.1:5273/".to_string())
    );
    assert_eq!(
      validate_dev_server("http://localhost:5272/"),
      Ok("http://localhost:5272/".to_string())
    );
    assert!(validate_dev_server("https://127.0.0.1:5273").is_err());
    assert!(validate_dev_server("http://example.com:5273").is_err());
    assert!(validate_dev_server("http://127.0.0.1").is_err());
    assert!(validate_dev_server("http://127.0.0.1:80").is_err());
    assert!(validate_dev_server("http://user@127.0.0.1:5273").is_err());
    assert!(validate_dev_server("http://127.0.0.1:5273/../x").is_err());
    assert!(validate_dev_server("file:///tmp/x").is_err());
  }

  #[test]
  fn read_entry_url_reads_dotfile_and_validates_schema() {
    let dir = std::env::temp_dir().join(format!(
      "lull-dev-entry-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    if std::fs::create_dir_all(&dir).is_err() {
      return;
    }
    assert_eq!(read_entry_url(&dir), Ok(None));
    let path = dir.join(DEV_ENTRY_FILE);
    let _ = std::fs::write(
      &path,
      r#"{"schemaVersion":1,"server":"http://127.0.0.1:5273"}"#,
    );
    assert_eq!(
      read_entry_url(&dir),
      Ok(Some("http://127.0.0.1:5273/".to_string()))
    );
    let _ = std::fs::write(
      &path,
      r#"{"schemaVersion":2,"server":"http://127.0.0.1:5273"}"#,
    );
    assert!(read_entry_url(&dir).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
