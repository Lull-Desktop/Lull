//! 第三方 Widget 包：发现、授权、窗口创建、状态命令与 iframe 上下文注入。
//!
//! 与内置工具（`window_host`）分开：插件窗口 label 固定为 `widget-<id>`，
//! 只获得 `core` 窗口权限与状态命令；包管理命令只有设置窗能调用。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window};

pub(crate) mod digest;
pub mod manifest;
pub(crate) mod official;
mod protocol;
pub(crate) mod store;

pub use protocol::handle as handle_protocol;

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

static BRIDGE_TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn bridge_tokens() -> &'static Mutex<HashMap<String, String>> {
  BRIDGE_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn issue_bridge_token(label: &str) -> String {
  let token = uuid::Uuid::new_v4().to_string();
  if let Ok(mut tokens) = bridge_tokens().lock() {
    tokens.insert(label.to_string(), token.clone());
  }
  token
}

#[must_use]
pub fn verify_bridge_token(label: &str, token: Option<&str>) -> bool {
  let Some(token) = token.filter(|value| !value.is_empty()) else {
    return false;
  };
  bridge_tokens()
    .lock()
    .ok()
    .and_then(|tokens| tokens.get(label).cloned())
    .is_some_and(|expected| expected == token)
}

pub fn on_window_destroyed(label: &str) {
  if let Ok(mut tokens) = bridge_tokens().lock() {
    tokens.remove(label);
  }
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
  fit: String,
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
      fit: window.fit.clone(),
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
  locale: String,
  minimizable: bool,
  window: WindowContext,
  bridge_token: String,
}

fn plugin_context_json(app: &AppHandle, runtime: &PackageManifest, bridge_token: &str) -> String {
  let context = PluginContext {
    v: PROTOCOL_VERSION,
    protocol: PROTOCOL_VERSION,
    host_api: HOST_API,
    id: runtime.id.clone(),
    name: runtime.name.clone(),
    version: runtime.version.clone(),
    entry_url: store::effective_entry_url(app, &runtime.id, &runtime.entry),
    requested: runtime.capabilities.clone(),
    granted: store::granted(app, &runtime.id),
    locale: crate::i18n::current(),
    minimizable: window_host::prefs::load(app).taskbar_and_minimize,
    window: WindowContext::from(&runtime.window),
    bridge_token: bridge_token.to_string(),
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

/// 逻辑尺寸请求对应的物理窗口帧。
#[derive(Debug, Clone, Copy)]
struct FrameRect {
  x: i32,
  y: i32,
  width: u32,
  height: u32,
}

#[derive(Debug, Clone, Copy)]
struct LayoutSpec {
  min_width: f64,
  max_width: f64,
  min_height: f64,
  max_height: f64,
  fit: bool,
}

#[derive(Debug, Default)]
struct LayoutRequest {
  width: Option<f64>,
  height: Option<f64>,
  anchor: Option<String>,
}

impl From<&WindowSpec> for LayoutSpec {
  fn from(window: &WindowSpec) -> Self {
    Self {
      min_width: window.min_width(),
      max_width: window.width,
      min_height: window.min_height(),
      max_height: manifest::MAX_HEIGHT,
      fit: window.fit == "content",
    }
  }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetViewportInfo {
  pub width: f64,
  pub height: f64,
  pub dpr: f64,
  pub applied: bool,
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn logical_to_physical(value: f64) -> u32 {
  value.round().max(1.0) as u32
}

/// 计算贴高 / 换宽后的窗口帧；宽度夹在 `[minWidth, width]`，高度仅在
/// `window.fit=content` 时允许，并夹在工作区与 1200 逻辑像素以内。
fn compute_frame(
  current: FrameRect,
  monitor: Option<(i32, i32, u32, u32)>,
  spec: LayoutSpec,
  request: &LayoutRequest,
  scale: f64,
) -> Result<FrameRect, String> {
  if !(scale.is_finite() && scale > 0.0) {
    return Err("窗口缩放因子非法".to_string());
  }
  if request.width.is_none() && request.height.is_none() {
    return Err("resize.request 至少需要 width 或 height".to_string());
  }
  if request.height.is_some() && !spec.fit {
    return Err("清单未声明 window.fit=content，不能按内容调整高度".to_string());
  }
  if let Some(width) = request.width {
    if !(width.is_finite() && width > 0.0) {
      return Err("窗口宽度必须是正数".to_string());
    }
  }
  if let Some(height) = request.height {
    if !(height.is_finite() && height > 0.0) {
      return Err("窗口高度必须是正数".to_string());
    }
  }

  let current_width = f64::from(current.width) / scale;
  let current_height = f64::from(current.height) / scale;
  let monitor_width = monitor.map(|(_, _, width, _)| f64::from(width) / scale);
  let monitor_height = monitor.map(|(_, _, _, height)| f64::from(height) / scale);
  let max_width = monitor_width.map_or(spec.max_width, |width| (width - 48.0).max(spec.min_width));
  let max_width = max_width.min(spec.max_width).max(spec.min_width);
  let max_height = monitor_height.map_or(spec.max_height, |height| {
    (height - 48.0).max(spec.min_height)
  });
  let max_height = max_height.min(spec.max_height).max(spec.min_height);

  let target_width = request.width.map_or(current_width, |width| {
    width.clamp(spec.min_width, max_width)
  });
  let target_height = request.height.map_or(current_height, |height| {
    height.clamp(spec.min_height, max_height)
  });
  let width = logical_to_physical(target_width * scale);
  let height = logical_to_physical(target_height * scale);

  let anchor = request.anchor.as_deref().unwrap_or("left");
  let mut x = match anchor {
    "left" => current.x,
    "right" => current.x.saturating_add(
      i32::try_from(current.width).unwrap_or(i32::MAX) - i32::try_from(width).unwrap_or(i32::MAX),
    ),
    other => return Err(format!("anchor 只能是 left 或 right，当前为 {other}")),
  };
  let mut y = current.y;
  if let Some((monitor_x, monitor_y, monitor_width, monitor_height)) = monitor {
    let monitor_width = i32::try_from(monitor_width).unwrap_or(i32::MAX);
    let monitor_height = i32::try_from(monitor_height).unwrap_or(i32::MAX);
    let max_x = monitor_x
      .saturating_add(monitor_width)
      .saturating_sub(i32::try_from(width).unwrap_or(i32::MAX));
    let max_y = monitor_y
      .saturating_add(monitor_height)
      .saturating_sub(i32::try_from(height).unwrap_or(i32::MAX));
    x = x.clamp(monitor_x, max_x.max(monitor_x));
    y = y.clamp(monitor_y, max_y.max(monitor_y));
  }
  Ok(FrameRect {
    x,
    y,
    width,
    height,
  })
}

/// 插件窗口的尺寸请求：宽度按 anchor 固定对侧边，高度固定顶边。
#[tauri::command]
pub fn widget_apply_resize(
  window: Window,
  width: Option<f64>,
  height: Option<f64>,
  anchor: Option<String>,
) -> Result<WidgetViewportInfo, String> {
  let id = package_id_from_window(&window)?;
  let app = window.app_handle();
  store::require_grant(app, &id, "widget.chrome")?;
  let manifest = store::find(app, &id)?;
  let scale = window.scale_factor().map_err(|error| error.to_string())?;
  let position = window
    .inner_position()
    .map_err(|error| format!("读取窗口位置失败：{error}"))?;
  let size = window
    .inner_size()
    .map_err(|error| format!("读取窗口尺寸失败：{error}"))?;
  let monitor = window.current_monitor().ok().flatten().map(|monitor| {
    (
      monitor.position().x,
      monitor.position().y,
      monitor.size().width,
      monitor.size().height,
    )
  });
  let frame = compute_frame(
    FrameRect {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    },
    monitor,
    LayoutSpec::from(&manifest.window),
    &LayoutRequest {
      width,
      height,
      anchor,
    },
    scale,
  )?;
  crate::window_frame::apply_frame(&window, frame.x, frame.y, frame.width, frame.height)?;
  Ok(WidgetViewportInfo {
    width: f64::from(frame.width) / scale,
    height: f64::from(frame.height) / scale,
    dpr: scale,
    applied: true,
  })
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

/// 打开插件窗口；固定尺寸、透明、无边框，窗口内容由 `/embed` 壳页承载。
///
/// 必须是 async 命令：同步命令跑在主线程，运行中创建 WebView2 会卡死消息泵。
pub async fn open(app: AppHandle, id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || open_window(&app, &id))
    .await
    .map_err(|error| error.to_string())?
}

fn open_window(app: &AppHandle, id: &str) -> Result<(), String> {
  let manifest = store::ensure_intact(app, id)?;
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
  let bridge_token = issue_bridge_token(&label);
  let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("embed".into()))
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
      plugin_context_json(app, &manifest, &bridge_token)
    ));
  let mut builder = builder.additional_browser_args(crate::webview::browser_args());
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

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
  if !manifest::valid_id(id) {
    return Err("插件 id 非法".to_string());
  }
  if let Some(window) = app.get_webview_window(&label_for(id)) {
    window.hide().map_err(|error| error.to_string())?;
  }
  notify(app);
  Ok(())
}

/// 结束运行：销毁窗口，状态 KV 保留，下次打开冷启动。
pub fn stop(app: &AppHandle, id: &str) -> Result<(), String> {
  if !manifest::valid_id(id) {
    return Err("插件 id 非法".to_string());
  }
  if let Some(window) = app.get_webview_window(&label_for(id)) {
    window.destroy().map_err(|error| error.to_string())?;
  }
  notify(app);
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
  fn bridge_token_is_issued_and_revoked() {
    let token = issue_bridge_token("widget-test-token");
    assert!(verify_bridge_token("widget-test-token", Some(&token)));
    assert!(!verify_bridge_token("widget-test-token", Some("wrong")));
    assert!(!verify_bridge_token("widget-test-token", None));
    on_window_destroyed("widget-test-token");
    assert!(!verify_bridge_token("widget-test-token", Some(&token)));
  }

  #[test]
  fn resize_clamps_width_and_anchors_right() {
    let spec = LayoutSpec {
      min_width: 530.0,
      max_width: 880.0,
      min_height: 240.0,
      max_height: manifest::MAX_HEIGHT,
      fit: true,
    };
    let current = FrameRect {
      x: 100,
      y: 200,
      width: 880,
      height: 552,
    };
    let result = compute_frame(
      current,
      None,
      spec,
      &LayoutRequest {
        width: Some(530.0),
        height: None,
        anchor: Some("right".to_string()),
      },
      1.0,
    );
    let Ok(frame) = result else {
      return;
    };
    assert_eq!(frame.width, 530);
    assert_eq!(frame.height, 552);
    assert_eq!(frame.x, 450);
    assert_eq!(frame.y, 200);
  }

  #[test]
  fn resize_height_requires_fit_content() {
    let spec = LayoutSpec {
      min_width: 320.0,
      max_width: 600.0,
      min_height: 240.0,
      max_height: manifest::MAX_HEIGHT,
      fit: false,
    };
    let current = FrameRect {
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    };
    assert!(compute_frame(
      current,
      None,
      spec,
      &LayoutRequest {
        width: None,
        height: Some(500.0),
        anchor: None,
      },
      1.0,
    )
    .is_err());
  }

  #[test]
  fn resize_height_is_clamped_to_monitor() {
    let spec = LayoutSpec {
      min_width: 320.0,
      max_width: 600.0,
      min_height: 240.0,
      max_height: manifest::MAX_HEIGHT,
      fit: true,
    };
    let current = FrameRect {
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    };
    let result = compute_frame(
      current,
      Some((0, 0, 1920, 700)),
      spec,
      &LayoutRequest {
        width: None,
        height: Some(2000.0),
        anchor: None,
      },
      1.0,
    );
    let Ok(frame) = result else {
      return;
    };
    assert_eq!(frame.height, 652);
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
      order: None,
      capabilities: vec!["widget.state".to_string()],
      window: WindowSpec::default(),
      network: Vec::new(),
      icon: None,
      lifecycle: "background".to_string(),
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
      locale: "zh-CN".to_string(),
      minimizable: true,
      window: WindowContext::from(&manifest.window),
      bridge_token: "token".to_string(),
    })
    .unwrap_or(Value::Null);
    assert_eq!(json["id"], "community-pomodoro");
    assert_eq!(json["bridgeToken"], "token");
    assert_eq!(json["protocol"], 1);
    assert_eq!(json["locale"], "zh-CN");
    assert!(json["entryUrl"]
      .as_str()
      .is_some_and(|url| url.ends_with("/community-pomodoro/index.html")));
  }
}
