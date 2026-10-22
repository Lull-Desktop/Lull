//! 第三方 Widget 包：发现、授权、窗口创建、状态命令与 iframe 上下文注入。
//!
//! 与内置工具（`window_host`）分开：插件窗口 label 固定为 `widget-<id>`，
//! 只获得 `core` 窗口权限与状态命令；包管理命令只有设置窗能调用。

pub mod manifest;
mod protocol;
mod store;

pub use protocol::handle as handle_protocol;
pub use store::PackageInfo;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window};

use crate::window_host;
use manifest::{PackageManifest, WindowSpec, HOST_API};

pub const LABEL_PREFIX: &str = window_host::DYNAMIC_WINDOW_PREFIX;
pub const PROTOCOL_VERSION: u32 = 1;

fn label_for(id: &str) -> String {
  format!("{LABEL_PREFIX}{id}")
}

pub fn is_plugin_label(label: &str) -> bool {
  label
    .strip_prefix(LABEL_PREFIX)
    .is_some_and(manifest::valid_id)
}

fn package_id_from_window(window: &Window) -> Result<String, String> {
  let label = window.label();
  let Some(id) = label.strip_prefix(LABEL_PREFIX) else {
    return Err("当前窗口不是插件窗口".to_string());
  };
  if !manifest::valid_id(id) {
    return Err("插件窗口 label 非法".to_string());
  }
  Ok(id.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowContext {
  width: f64,
  height: f64,
  min_width: f64,
  min_height: f64,
  resizable: bool,
  transparent: bool,
  chrome: String,
}

impl From<&WindowSpec> for WindowContext {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginContext {
  v: u32,
  protocol: u32,
  host_api: u32,
  id: String,
  name: String,
  version: String,
  entry_url: String,
  requested: Vec<String>,
  granted: Vec<String>,
  minimizable: bool,
  window: WindowContext,
}

fn plugin_context_json(app: &AppHandle, runtime: &PackageManifest) -> String {
  let context = PluginContext {
    v: PROTOCOL_VERSION,
    protocol: PROTOCOL_VERSION,
    host_api: HOST_API,
    id: runtime.id.clone(),
    name: runtime.name.clone(),
    version: runtime.version.clone(),
    entry_url: store::entry_url(&runtime.id, &runtime.entry),
    requested: runtime.capabilities.clone(),
    granted: store::granted(app, &runtime.id),
    minimizable: window_host::prefs::load(app).taskbar_and_minimize,
    window: WindowContext::from(&runtime.window),
  };
  match serde_json::to_string(&context) {
    Ok(json) => json,
    Err(_) => "null".to_string(),
  }
}

fn notify(app: &AppHandle) {
  window_host::notify_changed(app);
}

/// `#rrggbb` / `#rrggbbaa`；缺省为宿主纸张色（不透明）。
fn parse_hex_color(value: Option<&str>) -> Result<tauri::window::Color, String> {
  let Some(raw) = value else {
    return Ok(tauri::window::Color(246, 243, 236, 255));
  };
  let hex = raw.trim().trim_start_matches('#');
  if hex.len() != 6 && hex.len() != 8 {
    return Err("颜色必须是 #rrggbb 或 #rrggbbaa".to_string());
  }
  let channel = |index: usize| {
    u8::from_str_radix(&hex[index..index + 2], 16).map_err(|_| "颜色包含非法字符".to_string())
  };
  let alpha = if hex.len() == 8 { channel(6)? } else { 255 };
  Ok(tauri::window::Color(
    channel(0)?,
    channel(2)?,
    channel(4)?,
    alpha,
  ))
}

/// 运行时切换插件窗口背景：`transparent=true` 用全透明，否则用给定/默认颜色。
#[tauri::command]
pub fn widget_set_transparent(
  window: Window,
  transparent: bool,
  color: Option<String>,
) -> Result<(), String> {
  let id = package_id_from_window(&window)?;
  let webview = window
    .app_handle()
    .get_webview_window(&label_for(&id))
    .ok_or_else(|| "插件窗口不存在".to_string())?;
  let background = if transparent {
    tauri::window::Color(0, 0, 0, 0)
  } else {
    parse_hex_color(color.as_deref())?
  };
  webview
    .set_background_color(Some(background))
    .map_err(|error| format!("设置插件窗口背景失败：{error}"))
}

#[tauri::command]
pub fn widget_package_notify(window: Window) -> Result<(), String> {
  package_id_from_window(&window)?;
  window_host::notify_changed(window.app_handle());
  Ok(())
}

#[tauri::command]
pub fn widget_packages(app: AppHandle) -> Vec<PackageInfo> {
  store::list(&app)
}

#[tauri::command]
pub fn widget_package_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
  store::set_enabled(&app, &id, enabled)?;
  notify(&app);
  Ok(())
}

#[tauri::command]
pub fn widget_package_revoke(app: AppHandle, id: String) -> Result<(), String> {
  store::revoke(&app, &id)?;
  notify(&app);
  Ok(())
}

/// 打开插件窗口；固定尺寸、透明、无边框，窗口内容由 `/embed` 壳页承载。
///
/// 必须是 async 命令：同步命令跑在主线程，运行中创建 WebView2 会卡死消息泵。
#[tauri::command]
pub async fn widget_package_open(app: AppHandle, id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || open_window(&app, &id))
    .await
    .map_err(|error| error.to_string())?
}

fn open_window(app: &AppHandle, id: &str) -> Result<(), String> {
  let manifest = store::find(app, id)?;
  if !store::is_enabled(app, id) {
    return Err("插件未启用，请先在设置中授权".to_string());
  }
  let label = label_for(&manifest.id);
  if let Some(window) = app.get_webview_window(&label) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    notify(app);
    return Ok(());
  }

  let on = window_host::prefs::load(app).taskbar_and_minimize;
  let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("embed".into()))
    .title(format!("Lull {}", manifest.name))
    .inner_size(manifest.window.width, manifest.window.height)
    .min_inner_size(manifest.window.min_width(), manifest.window.min_height())
    .decorations(false)
    .shadow(false)
    .visible(false)
    .skip_taskbar(!on)
    .minimizable(on)
    .resizable(false)
    .maximizable(false)
    .initialization_script(format!(
      "window.__LULL_PLUGIN__ = {};",
      plugin_context_json(app, &manifest)
    ));
  // 插件窗口始终用透明 WebView 创建，初始背景由清单的 window.transparent 决定；
  // 运行时可通过 widget_set_transparent 在透明/不透明之间切换。
  builder = builder
    .transparent(true)
    .background_color(if manifest.window.transparent {
      tauri::window::Color(0, 0, 0, 0)
    } else {
      tauri::window::Color(246, 243, 236, 255)
    });

  let window = builder
    .build()
    .map_err(|error| format!("创建插件窗口 {} 失败：{error}", manifest.id))?;
  // builder 的 background_color 主要作用于窗口；这里再显式设置 WebView 背景，
  // 确保透明插件在 WebView2 上也是真正的桌面穿透，而不是主题底色。
  let _ = window.set_background_color(Some(if manifest.window.transparent {
    tauri::window::Color(0, 0, 0, 0)
  } else {
    tauri::window::Color(246, 243, 236, 255)
  }));
  let fallback = window.clone();
  std::thread::spawn(move || {
    for _ in 0..20 {
      std::thread::sleep(std::time::Duration::from_millis(200));
      if fallback.is_visible().unwrap_or(true) {
        return;
      }
    }
    let _ = fallback.show();
    window_host::notify_changed(fallback.app_handle());
  });
  notify(app);
  Ok(())
}

#[tauri::command]
pub fn widget_package_close(app: AppHandle, id: String) -> Result<(), String> {
  if !manifest::valid_id(&id) {
    return Err("插件 id 非法".to_string());
  }
  if let Some(window) = app.get_webview_window(&label_for(&id)) {
    window.hide().map_err(|error| error.to_string())?;
  }
  notify(&app);
  Ok(())
}

#[tauri::command]
pub fn widget_state_get(window: Window, key: String) -> Result<Option<Value>, String> {
  let id = package_id_from_window(&window)?;
  store::get_value(window.app_handle(), &id, &key)
}

#[tauri::command]
pub fn widget_state_set(window: Window, key: String, value: Value) -> Result<(), String> {
  let id = package_id_from_window(&window)?;
  store::set_value(window.app_handle(), &id, &key, value)
}

#[tauri::command]
pub fn widget_state_remove(window: Window, key: String) -> Result<(), String> {
  let id = package_id_from_window(&window)?;
  store::remove_value(window.app_handle(), &id, &key)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_hex_color_accepts_rgb_and_rgba() {
    let rgb = parse_hex_color(Some("#0b1014")).expect("rgb");
    assert_eq!((rgb.0, rgb.1, rgb.2, rgb.3), (11, 16, 20, 255));
    let rgba = parse_hex_color(Some("0b101480")).expect("rgba");
    assert_eq!((rgba.0, rgba.1, rgba.2, rgba.3), (11, 16, 20, 128));
    assert_eq!(parse_hex_color(None).expect("default").0, 246);
    assert!(parse_hex_color(Some("#12345")).is_err());
    assert!(parse_hex_color(Some("#gg1014")).is_err());
  }

  #[test]
  fn plugin_labels_are_scoped() {
    assert!(is_plugin_label("widget-community-pomodoro"));
    assert!(!is_plugin_label("player"));
    assert!(!is_plugin_label("widget-"));
    assert!(!is_plugin_label("widget-Bad"));
  }

  #[test]
  fn context_serializes_expected_fields() {
    use crate::widget_package::manifest::WindowSpec;
    let manifest = PackageManifest {
      schema_version: manifest::SCHEMA_VERSION,
      kind: "widget".to_string(),
      id: "community-pomodoro".to_string(),
      name: "番茄钟".to_string(),
      version: "1.0.0".to_string(),
      description: None,
      author: None,
      license: None,
      builtin: false,
      host_api: HOST_API,
      entry: "index.html".to_string(),
      capabilities: vec!["widget.state".to_string()],
      window: WindowSpec::default(),
      network: Vec::new(),
    };
    let json = serde_json::to_value(PluginContext {
      v: PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION,
      host_api: HOST_API,
      id: manifest.id.clone(),
      name: manifest.name.clone(),
      version: manifest.version.clone(),
      entry_url: store::entry_url(&manifest.id, &manifest.entry),
      requested: manifest.capabilities.clone(),
      granted: vec!["widget.state".to_string()],
      minimizable: true,
      window: WindowContext::from(&manifest.window),
    })
    .unwrap_or(Value::Null);
    assert_eq!(json["id"], "community-pomodoro");
    assert_eq!(json["protocol"], 1);
    assert!(json["entryUrl"]
      .as_str()
      .is_some_and(|url| url.ends_with("/community-pomodoro/index.html")));
  }
}
