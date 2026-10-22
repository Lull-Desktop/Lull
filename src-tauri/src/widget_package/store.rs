//! 插件包发现、授权记录与按插件隔离的状态 KV。

use super::manifest::{PackageManifest, WindowSpec, HOST_API};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const GRANTS_FILE: &str = ".grants.json";
const STATE_DIR: &str = ".state";
const STATE_VERSION: u32 = 1;
const GRANTS_VERSION: u32 = 1;
const MAX_STATE_BYTES: usize = 256 * 1024;
const MAX_VALUE_BYTES: usize = 32 * 1024;
const MAX_KEY_LEN: usize = 64;

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageWindow {
  pub width: f64,
  pub height: f64,
  pub min_width: f64,
  pub min_height: f64,
  pub resizable: bool,
  pub transparent: bool,
  pub chrome: String,
}

impl From<&WindowSpec> for PackageWindow {
  fn from(window: &WindowSpec) -> Self {
    Self {
      width: window.width,
      height: window.height,
      min_width: window.min_width(),
      min_height: window.min_height(),
      resizable: window.resizable,
      transparent: window.transparent,
      chrome: window.chrome.clone(),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: Option<String>,
  pub author: Option<String>,
  pub license: Option<String>,
  /// `ready` / `invalid`
  pub status: String,
  pub error: Option<String>,
  pub requested: Vec<String>,
  pub granted: Vec<String>,
  pub enabled: bool,
  pub window: PackageWindow,
  pub entry_url: String,
  pub host_api: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct GrantRecord {
  #[serde(default)]
  enabled: bool,
  #[serde(default)]
  granted: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GrantsFile {
  #[serde(default = "grants_version")]
  version: u32,
  #[serde(default)]
  widgets: BTreeMap<String, GrantRecord>,
}

impl Default for GrantsFile {
  fn default() -> Self {
    Self {
      version: GRANTS_VERSION,
      widgets: BTreeMap::new(),
    }
  }
}

fn grants_version() -> u32 {
  GRANTS_VERSION
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StateFile {
  #[serde(default = "state_version")]
  version: u32,
  #[serde(default)]
  values: BTreeMap<String, Value>,
}

impl Default for StateFile {
  fn default() -> Self {
    Self {
      version: STATE_VERSION,
      values: BTreeMap::new(),
    }
  }
}

fn state_version() -> u32 {
  STATE_VERSION
}

/// 插件根目录：`LULL_WIDGETS_DIR` 优先（开发/测试），否则 app_data_dir/widgets。
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("LULL_WIDGETS_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("widgets"))
    .map_err(|error| error.to_string())
}

pub fn package_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(root(app)?.join(id))
}

pub fn entry_url(id: &str, entry: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullwidget.localhost";
  #[cfg(not(windows))]
  let origin = "lullwidget://localhost";
  format!("{origin}/{id}/{entry}")
}

pub fn find(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let dir = package_dir(app, id)?;
  PackageManifest::load(&dir, id)
}

pub fn list(app: &AppHandle) -> Vec<PackageInfo> {
  let Ok(root) = root(app) else {
    return Vec::new();
  };
  let grants = load_grants(app).unwrap_or_default();
  let Ok(entries) = std::fs::read_dir(&root) else {
    return Vec::new();
  };
  let mut packages: Vec<PackageInfo> = Vec::new();
  for entry in entries.filter_map(Result::ok) {
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    if dir_name.starts_with('.') || !path.join("widget.json").is_file() {
      continue;
    }
    match PackageManifest::load(&path, dir_name) {
      Ok(manifest) => packages.push(info_from(&manifest, grants.widgets.get(dir_name))),
      Err(error) => packages.push(invalid_info(dir_name, &error)),
    }
  }
  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

fn info_from(manifest: &PackageManifest, grant: Option<&GrantRecord>) -> PackageInfo {
  let enabled = grant.is_some_and(|record| record.enabled);
  let granted = if enabled {
    grant
      .map(|record| record.granted.clone())
      .unwrap_or_default()
  } else {
    Vec::new()
  };
  PackageInfo {
    id: manifest.id.clone(),
    name: manifest.name.clone(),
    version: manifest.version.clone(),
    description: manifest.description.clone(),
    author: manifest.author.clone(),
    license: manifest.license.clone(),
    status: "ready".to_string(),
    error: None,
    requested: manifest.capabilities.clone(),
    granted,
    enabled,
    window: PackageWindow::from(&manifest.window),
    entry_url: entry_url(&manifest.id, &manifest.entry),
    host_api: manifest.host_api,
  }
}

fn invalid_info(id: &str, error: &str) -> PackageInfo {
  PackageInfo {
    id: id.to_string(),
    name: id.to_string(),
    version: "-".to_string(),
    description: None,
    author: None,
    license: None,
    status: "invalid".to_string(),
    error: Some(error.to_string()),
    requested: Vec::new(),
    granted: Vec::new(),
    enabled: false,
    window: PackageWindow::from(&WindowSpec::default()),
    entry_url: String::new(),
    host_api: HOST_API,
  }
}

fn grants_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root(app)?.join(GRANTS_FILE))
}

fn load_grants(app: &AppHandle) -> Result<GrantsFile, String> {
  let path = grants_path(app)?;
  let Ok(text) = std::fs::read_to_string(path) else {
    return Ok(GrantsFile::default());
  };
  Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn save_grants(app: &AppHandle, grants: &GrantsFile) -> Result<(), String> {
  let path = grants_path(app)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(grants).map_err(|error| error.to_string())?;
  write_atomic(&path, &json)
}

pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
  let manifest = find(app, id)?;
  let mut grants = load_grants(app)?;
  if enabled {
    grants.widgets.insert(
      id.to_string(),
      GrantRecord {
        enabled: true,
        granted: manifest.capabilities.clone(),
      },
    );
  } else {
    grants.widgets.insert(
      id.to_string(),
      GrantRecord {
        enabled: false,
        granted: Vec::new(),
      },
    );
  }
  save_grants(app, &grants)?;
  if !enabled {
    hide_window(app, id);
  }
  Ok(())
}

pub fn revoke(app: &AppHandle, id: &str) -> Result<(), String> {
  let mut grants = load_grants(app)?;
  grants.widgets.remove(id);
  save_grants(app, &grants)?;
  clear_state(app, id)?;
  hide_window(app, id);
  Ok(())
}

pub fn is_enabled(app: &AppHandle, id: &str) -> bool {
  load_grants(app)
    .ok()
    .and_then(|grants| grants.widgets.get(id).map(|record| record.enabled))
    .unwrap_or(false)
}

pub fn granted(app: &AppHandle, id: &str) -> Vec<String> {
  load_grants(app)
    .ok()
    .and_then(|grants| {
      grants
        .widgets
        .get(id)
        .filter(|record| record.enabled)
        .map(|record| record.granted.clone())
    })
    .unwrap_or_default()
}

pub fn require_grant(app: &AppHandle, id: &str, capability: &str) -> Result<(), String> {
  let grants = load_grants(app)?;
  let record = grants
    .widgets
    .get(id)
    .ok_or_else(|| "插件未启用".to_string())?;
  if !record.enabled {
    return Err("插件未启用".to_string());
  }
  if !record.granted.iter().any(|granted| granted == capability) {
    return Err(format!("插件未获得 {capability} 权限"));
  }
  Ok(())
}

fn hide_window(app: &AppHandle, id: &str) {
  if let Some(window) = app.get_webview_window(&format!("widget-{id}")) {
    let _ = window.hide();
  }
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root(app)?.join(STATE_DIR))
}

fn state_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(state_dir(app)?.join(format!("{id}.json")))
}

fn read_state(app: &AppHandle, id: &str) -> Result<StateFile, String> {
  let path = state_path(app, id)?;
  let Ok(text) = std::fs::read_to_string(path) else {
    return Ok(StateFile::default());
  };
  Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn write_state(app: &AppHandle, id: &str, state: &StateFile) -> Result<(), String> {
  let path = state_path(app, id)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
  if json.len() > MAX_STATE_BYTES {
    return Err(format!("插件状态超过 {} KiB 上限", MAX_STATE_BYTES / 1024));
  }
  write_atomic(&path, &json)
}

pub fn get_value(app: &AppHandle, id: &str, key: &str) -> Result<Option<Value>, String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  Ok(read_state(app, id)?.values.get(key).cloned())
}

pub fn set_value(app: &AppHandle, id: &str, key: &str, value: Value) -> Result<(), String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let encoded = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
  if encoded.len() > MAX_VALUE_BYTES {
    return Err(format!(
      "单个状态值超过 {} KiB 上限",
      MAX_VALUE_BYTES / 1024
    ));
  }
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  let mut state = read_state(app, id)?;
  state.values.insert(key.to_string(), value);
  write_state(app, id, &state)
}

pub fn remove_value(app: &AppHandle, id: &str, key: &str) -> Result<(), String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  let mut state = read_state(app, id)?;
  state.values.remove(key);
  write_state(app, id, &state)
}

pub fn clear_state(app: &AppHandle, id: &str) -> Result<(), String> {
  let path = state_path(app, id)?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn valid_key(key: &str) -> Result<(), String> {
  if key.is_empty() || key.len() > MAX_KEY_LEN {
    return Err(format!("状态键必须是 1-{MAX_KEY_LEN} 字符"));
  }
  if !key
    .chars()
    .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
  {
    return Err("状态键只允许字母、数字、点、下划线与连字符".to_string());
  }
  Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn state_keys_are_restricted() {
    assert!(valid_key("prefs").is_ok());
    assert!(valid_key("timer.v1").is_ok());
    assert!(valid_key("../x").is_err());
    assert!(valid_key("").is_err());
    assert!(valid_key(&"a".repeat(MAX_KEY_LEN + 1)).is_err());
  }

  #[test]
  fn entry_url_is_package_scoped() {
    let url = entry_url("community-pomodoro", "index.html");
    assert!(url.contains("/community-pomodoro/index.html"));
  }

  #[test]
  fn invalid_info_uses_safe_defaults() {
    let info = invalid_info("broken", "bad manifest");
    assert_eq!(info.status, "invalid");
    assert!(!info.enabled);
    assert!(info.window.width >= 320.0);
  }
}
