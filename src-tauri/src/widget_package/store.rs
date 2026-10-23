//! 插件包发现、授权记录与按插件隔离的状态 KV。

use super::digest;
use super::manifest::{PackageManifest, WindowSpec, HOST_API};
use crate::extension::install;
use crate::extension::ExtensionError;
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
  /// `ready` / `invalid` / `tampered`
  pub status: String,
  pub error: Option<String>,
  pub requested: Vec<String>,
  pub granted: Vec<String>,
  pub enabled: bool,
  pub running: bool,
  pub verified: bool,
  /// `declared` / `computed` / `none`
  pub integrity: String,
  pub tampered: bool,
  pub window: PackageWindow,
  pub lifecycle: String,
  pub network: Vec<String>,
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

pub fn resolve_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  package_dir(app, id)
}

pub fn find(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let dir = resolve_dir(app, id)?;
  PackageManifest::load(&dir, id)
}

/// 打开/启用前复核摘要：有锁且不匹配就阻止加载。
pub fn ensure_intact(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let dir = resolve_dir(app, id)?;
  let manifest = PackageManifest::load(&dir, id)?;
  if let Err(error) = digest::check(&dir, &manifest.id, &manifest.version) {
    return Err(format!("内容包摘要不匹配，已阻止加载：{error}"));
  }
  Ok(manifest)
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
    let running = is_running(app, dir_name);
    match PackageManifest::load(&path, dir_name) {
      Ok(manifest) => packages.push(info_from(
        &path,
        &manifest,
        grants.widgets.get(dir_name),
        running,
      )),
      Err(error) => packages.push(invalid_info(dir_name, &error)),
    }
  }
  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

fn info_from(
  dir: &Path,
  manifest: &PackageManifest,
  grant: Option<&GrantRecord>,
  running: bool,
) -> PackageInfo {
  let enabled = grant.is_some_and(|record| record.enabled);
  let granted = if enabled {
    grant
      .map(|record| record.granted.clone())
      .unwrap_or_default()
  } else {
    Vec::new()
  };
  let (verified, integrity, tampered, integrity_error) =
    match digest::check(dir, &manifest.id, &manifest.version) {
      Ok(Some(record)) => (true, record.source, false, None),
      Ok(None) => (false, "none".to_string(), false, None),
      Err(error) => (false, "none".to_string(), true, Some(error)),
    };
  PackageInfo {
    id: manifest.id.clone(),
    name: manifest.name.clone(),
    version: manifest.version.clone(),
    description: manifest.description.clone(),
    author: manifest.author.clone(),
    license: manifest.license.clone(),
    status: if tampered {
      "tampered".to_string()
    } else {
      "ready".to_string()
    },
    error: integrity_error,
    requested: manifest.capabilities.clone(),
    granted,
    enabled,
    running,
    verified,
    integrity,
    tampered,
    window: PackageWindow::from(&manifest.window),
    lifecycle: manifest.lifecycle.clone(),
    network: manifest.network.clone(),
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
    running: false,
    verified: false,
    integrity: "none".to_string(),
    tampered: false,
    window: PackageWindow::from(&WindowSpec::default()),
    lifecycle: "background".to_string(),
    network: Vec::new(),
    entry_url: String::new(),
    host_api: HOST_API,
  }
}

fn is_running(app: &AppHandle, id: &str) -> bool {
  app
    .get_webview_window(&format!("{}{}", super::LABEL_PREFIX, id))
    .is_some()
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
  let manifest = if enabled {
    ensure_intact(app, id)?
  } else {
    find(app, id)?
  };
  if enabled {
    // 手动放置的包在首次启用时补一把本地锁；目录只读则保持“未校验”，不阻断启用。
    let dir = resolve_dir(app, id)?;
    if digest::read(&dir)?.is_none() {
      let _ = digest::seal(&dir, &manifest.id, &manifest.version, "computed");
    }
  }
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
    destroy_window(app, id);
  }
  Ok(())
}

/// 逐能力授权；运行中拒绝修改，避免撤销 `widget.chrome` 后窗口无法关闭。
pub fn set_capability(
  app: &AppHandle,
  id: &str,
  capability: &str,
  granted: bool,
) -> Result<(), String> {
  let manifest = find(app, id)?;
  if !manifest
    .capabilities
    .iter()
    .any(|item| item == capability)
  {
    return Err(format!("插件没有声明能力：{capability}"));
  }
  if is_running(app, id) {
    return Err("运行中不能修改权限，请先结束运行".to_string());
  }
  let mut grants = load_grants(app)?;
  let record = grants
    .widgets
    .get_mut(id)
    .ok_or_else(|| "插件未启用".to_string())?;
  if !record.enabled {
    return Err("插件未启用".to_string());
  }
  if granted {
    if !record.granted.iter().any(|item| item == capability) {
      record.granted.push(capability.to_string());
    }
  } else {
    record.granted.retain(|item| item != capability);
  }
  save_grants(app, &grants)
}

pub fn revoke(app: &AppHandle, id: &str) -> Result<(), String> {
  let mut grants = load_grants(app)?;
  grants.widgets.remove(id);
  save_grants(app, &grants)?;
  clear_state(app, id)?;
  destroy_window(app, id);
  Ok(())
}

/// 卸载：销毁窗口、删授权、删状态、删目录。
pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
  if !super::manifest::valid_id(id) {
    return Err("插件 id 非法".to_string());
  }
  let dir = resolve_dir(app, id)?;
  if !dir.is_dir() {
    return Err(format!("没有安装 id={id} 的插件"));
  }
  revoke(app, id)?;

  let root = root(app)?;
  let canonical_root =
    std::fs::canonicalize(&root).map_err(|error| format!("插件目录不可用：{error}"))?;
  let canonical_dir =
    std::fs::canonicalize(&dir).map_err(|error| format!("插件目录不可用：{error}"))?;
  if canonical_dir.parent() != Some(canonical_root.as_path()) {
    return Err("拒绝删除插件目录之外的路径".to_string());
  }
  std::fs::remove_dir_all(&canonical_dir).map_err(|error| format!("卸载失败：{error}"))
}

/// 安装：共享 staging + widget 清单/摘要校验 + 原子落地。
pub fn install_from_staged(
  root: &Path,
  staged: &install::Staged,
) -> Result<PackageInfo, ExtensionError> {
  let manifest = PackageManifest::from_dir(staged.bundle())
    .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
  if manifest
    .license
    .as_deref()
    .unwrap_or_default()
    .trim()
    .is_empty()
  {
    return Err(ExtensionError::new(
      "manifest.license-missing",
      "widget.json 必须声明 license",
    ));
  }
  if !staged.bundle().join(&manifest.entry).is_file() {
    return Err(ExtensionError::new(
      "manifest.entry-missing",
      format!("entry 指向的文件不存在：{}", manifest.entry),
    ));
  }
  crate::resource::safe_join(staged.bundle(), &manifest.entry).map_err(|error| {
    ExtensionError::new("manifest.entry-unsafe", error)
  })?;

  match digest::check(staged.bundle(), &manifest.id, &manifest.version) {
    Ok(Some(_)) => {}
    Ok(None) => {
      digest::seal(staged.bundle(), &manifest.id, &manifest.version, "computed")
        .map_err(|error| ExtensionError::new("io.error", error))?;
    }
    Err(error) => {
      return Err(ExtensionError::new("integrity.mismatch", error));
    }
  }

  let target = staged.commit(root, &manifest.id)?;
  Ok(info_from(&target, &manifest, None, false))
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

fn destroy_window(app: &AppHandle, id: &str) {
  if let Some(window) = app.get_webview_window(&format!("{}{}", super::LABEL_PREFIX, id)) {
    let _ = window.destroy();
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

  fn temp_root(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-widget-store-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_widget_package(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("assets"))?;
    std::fs::write(
      dir.join("widget.json"),
      r#"{
        "schemaVersion": 2,
        "type": "widget",
        "id": "community-test",
        "name": "测试插件",
        "version": "1.0.0",
        "license": "MIT",
        "builtin": false,
        "hostApi": 1,
        "entry": "index.html",
        "capabilities": ["widget.state"],
        "window": {
          "width": 560,
          "height": 640,
          "resizable": false,
          "transparent": true,
          "chrome": "host"
        }
      }"#,
    )?;
    std::fs::write(dir.join("index.html"), b"<html></html>")?;
    std::fs::write(dir.join("assets/app.css"), b"body{}")?;
    Ok(())
  }

  #[test]
  fn installs_widget_and_seals_integrity() {
    let Some(root) = temp_root("install") else {
      return;
    };
    let source = root.join("source");
    if write_widget_package(&source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let packages = root.join("packages");
    let Ok(staged) = install::stage(&packages, &source) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let installed = install_from_staged(&packages, &staged);
    assert!(
      installed.is_ok(),
      "安装失败：{}",
      installed
        .as_ref()
        .err()
        .map(|error| error.code.clone())
        .unwrap_or_default()
    );
    if let Ok(info) = &installed {
      assert_eq!(info.id, "community-test");
      assert!(info.verified);
      assert_eq!(info.integrity, "computed");
      assert_eq!(info.status, "ready");
    }
    let target = packages.join("community-test");
    assert!(target.join("widget.json").is_file());
    assert!(target.join(super::digest::INTEGRITY_FILE).is_file());

    // 改动包内文件后，运行时扫描必须判 tampered。
    let _ = std::fs::write(target.join("index.html"), b"<html>changed</html>");
    let Ok(manifest) = PackageManifest::load(&target, "community-test") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let info = info_from(&target, &manifest, None, false);
    assert_eq!(info.status, "tampered");
    assert!(info.error.is_some());
    let _ = std::fs::remove_dir_all(&root);
  }
}
