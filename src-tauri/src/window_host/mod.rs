//! 窗口运行时：设置窗与播放器 / 番茄钟 / 白噪音三个工具窗共用同一套生命周期。
//!
//! 无边框、隐藏创建（等前端贴合内容高度）、复用唤醒、兜底显示与关闭即隐藏。
//! 窗口的静态描述在 `spec`，全局窗口偏好在 `prefs`。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub mod prefs;
mod spec;

pub use spec::{find, is_managed, WidgetSpec, ALL_WIDGETS, SETTINGS, WIDGET_HOST_API};

/// 工具窗显示/隐藏后广播；设置页据此刷新「显示/关闭」开关。
pub const WIDGETS_CHANGED_EVENT: &str = "widgets-changed";

/// 通知所有窗口：工具窗可见性可能变了。
pub(crate) fn notify_changed(app: &AppHandle) {
  let _ = app.emit(WIDGETS_CHANGED_EVENT, ());
}

/// 生产环境（以及默认的 dev）关闭 WebView DevTools。
/// 开发时确实需要调试控制台，用 `LULL_DEVTOOLS=1 pnpm dev` 临时打开；
/// release 构建（`debug_assertions` 为 false）下无论如何都返回 false。
pub(crate) fn devtools_enabled() -> bool {
  cfg!(debug_assertions) && std::env::var_os("LULL_DEVTOOLS").is_some()
}

/// 注入到工具窗的上下文：前端 SDK 据此做能力校验与状态命名空间约束。
///
/// 放在初始化脚本里（先于页面 JS 执行）；内置页面与宿主同信任级，
/// 第三方页面必须走独立源 iframe，不能依赖这个全局变量。
/// 能力清单直接来自 manifest 生成的 `WidgetSpec`，是“声明”而非“授权”的唯一来源。
fn widget_context_json(spec: &WidgetSpec) -> String {
  serde_json::json!({
    "schemaVersion": 1,
    "hostApi": WIDGET_HOST_API,
    "id": spec.kind,
    "capabilities": spec.capabilities,
    "window": {
      "label": spec.label,
      "route": spec.url,
      "title": spec.title,
      "width": spec.width,
      "height": spec.height,
      "minWidth": spec.min_width,
      "minHeight": spec.min_height,
      "resizable": spec.resizable,
      "transparent": spec.transparent,
    },
  })
  .to_string()
}

/// 打开窗口；已存在则只做唤醒（显示 / 还原 / 聚焦），不会重建 WebView。
pub fn open(app: &AppHandle, spec: &WidgetSpec) {
  if let Some(window) = app.get_webview_window(spec.label) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    notify_changed(app);
    return;
  }

  let prefs = prefs::load(app);
  let on = prefs.taskbar_and_minimize;
  let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
    .title(spec.title)
    .inner_size(spec.width, spec.height)
    .min_inner_size(spec.min_width, spec.min_height)
    // 无边框：系统标题栏隐藏，拖拽/锁定/最小化/关闭全部由前端 Topbar 接管。
    // shadow(false) 沿用壁纸窗的实测定案，避免 tao 阴影帧把客户区内缩出黑边。
    .decorations(false)
    .shadow(false)
    // 先隐藏，等前端（use-window-fit.ts）把高度贴到内容后再显示，避免空窗跳变。
    .visible(false)
    .skip_taskbar(!on)
    // 全局偏好：任务栏与最小化同开同关；前端读取 isMinimizable 决定是否渲染按钮。
    .minimizable(on)
    // 缩放与最大化：透明浮窗固定尺寸，避免拖到屏幕边缘触发 Aero Snap 改尺寸；
    // 设置窗保持可缩放（顶栏的锁定按钮会再动态关闭）。
    .resizable(spec.resizable)
    .maximizable(spec.resizable)
    // Widget SDK 上下文：先于页面脚本注入 window.__LULL_WIDGET__。
    .initialization_script(widget_context_json(spec))
    .devtools(devtools_enabled());

  if spec.transparent {
    // 播放器 / 白噪音 / 液态番茄钟是透明浮窗：WebView 页面背景 alpha 为 0，
    // 桌面内容从玻璃件之间透出（页面侧挂 lull-transparent-window）。
    builder = builder
      .transparent(true)
      .background_color(tauri::window::Color(0, 0, 0, 0));
  } else {
    // 纸色底兜住设置窗首帧白闪。
    builder = builder.background_color(tauri::window::Color(246, 243, 236, 255));
  }

  let webview = match builder.build() {
    Ok(window) => window,
    Err(error) => {
      eprintln!("[app] 创建窗口 {} 失败: {error}", spec.label);
      return;
    }
  };

  // 兜底显示：前端贴合失败（JS 报错 / 白屏）时不能让窗口永远隐藏。
  // 轮询而不是一次性延时判断——窗口只要显示过就说明前端已接管，立即退出，
  // 避免用户手动关掉窗口后又被兜底逻辑弹出来。
  let fallback = webview.clone();
  std::thread::spawn(move || {
    for _ in 0..20 {
      std::thread::sleep(std::time::Duration::from_millis(200));
      if fallback.is_visible().unwrap_or(true) {
        return;
      }
    }
    let _ = fallback.show();
    notify_changed(fallback.app_handle());
  });
}

/// 从非主线程发起打开：运行时创建 WebView2 必须走非主线程路径，
/// 否则主线程分发上下文里的嵌套消息泵会卡死（详见 wallpaper/windows 的建窗说明）。
pub fn open_async(app: &AppHandle, spec: &'static WidgetSpec) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    open(&app, spec);
  });
}

/// 前端/托盘打开窗口的入口。必须 async：同步命令跑在主线程，建 WebView2 会卡住。
#[tauri::command]
pub async fn widget_open(app: AppHandle, kind: String) -> Result<(), String> {
  let spec = find(&kind).ok_or_else(|| format!("未知窗口: {kind}"))?;
  open(&app, spec);
  Ok(())
}

#[derive(serde::Serialize)]
pub struct WidgetState {
  pub kind: &'static str,
  pub visible: bool,
  /// Widget SDK 版本；前端可以据此提示兼容性。
  pub version: &'static str,
  /// 该工具声明的能力（第一版均为内置工具）。
  pub capabilities: &'static [&'static str],
}

/// 工具窗（不含设置窗）当前的显示状态，设置页用它渲染开关。
#[tauri::command]
pub fn widget_states(app: AppHandle) -> Vec<WidgetState> {
  ALL_WIDGETS
    .iter()
    .copied()
    .filter(|spec| spec.kind != SETTINGS.kind)
    .map(|spec| WidgetState {
      kind: spec.kind,
      visible: app
        .get_webview_window(spec.label)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false),
      version: spec.version,
      capabilities: spec.capabilities,
    })
    .collect()
}

/// 隐藏工具窗（设置页「关闭」开关）；保留挂载，下次打开更快。
#[tauri::command]
pub fn widget_close(app: AppHandle, kind: String) -> Result<(), String> {
  let spec = find(&kind).ok_or_else(|| format!("未知窗口: {kind}"))?;
  if spec.kind == SETTINGS.kind {
    return Err("设置窗不能通过该命令关闭".to_string());
  }
  if let Some(window) = app.get_webview_window(spec.label) {
    window.hide().map_err(|error| error.to_string())?;
  }
  notify_changed(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::spec::{NOISE, PLAYER, POMODORO};
  use super::*;
  use serde_json::Value;

  fn context_of(spec: &WidgetSpec) -> Value {
    serde_json::from_str(&widget_context_json(spec)).unwrap_or(Value::Null)
  }

  #[test]
  fn context_carries_capabilities_and_window_limits() {
    let context = context_of(&PLAYER);
    assert_eq!(context["id"], "player");
    assert_eq!(context["hostApi"], 1);
    assert_eq!(context["schemaVersion"], 1);
    assert!(
      context["capabilities"].as_array().is_some_and(|items| items
        .iter()
        .any(|item| item.as_str() == Some("widget.chrome"))),
      "播放器需要 chrome 能力"
    );
    assert_eq!(context["window"]["label"], "player");
    let min_width = context["window"]["minWidth"].as_f64().unwrap_or_default();
    assert!((min_width - 500.0).abs() < f64::EPSILON);
  }

  #[test]
  fn tools_do_not_get_window_creation_capability() {
    for spec in [&PLAYER, &POMODORO, &NOISE] {
      let context = context_of(spec);
      let grants_window = context["capabilities"].as_array().is_some_and(|items| {
        items
          .iter()
          .any(|item| item.as_str() == Some("widget.window"))
      });
      assert!(!grants_window, "{} 不应获得 widget.window", spec.kind);
    }
  }
}
