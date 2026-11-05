//! Authority 隐藏窗口：创建、注入上下文、下发命令/生命周期、销毁。
//!
//! 窗口页面是宿主壳 `/game-authority`，游戏代码再跑在它的 sandbox iframe 里。
//! 运行时创建 WebView2 必须离开主线程；调用方（`lifecycle`）在 blocking 线程里。

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::error::{codes, GameError, GameResult};
use super::instance::GameInstance;
use super::protocol::{GameCommandEnvelope, GameLifecycle, GameLimits, HOST_API, PROTOCOL_VERSION};

pub const ROUTE: &str = "game-authority";

#[must_use]
pub fn label_for(instance_id: &str) -> String {
  format!("game-authority-{instance_id}")
}

fn authority_context(
  instance: &GameInstance,
  entry_url: &str,
  limits: &GameLimits,
) -> serde_json::Value {
  json!({
    "protocol": PROTOCOL_VERSION,
    "hostApi": HOST_API,
    "gameId": instance.game_id,
    "instanceId": instance.instance_id,
    "authorityId": instance.authority_id,
    "authorityEpoch": instance.epoch(),
    "role": "authority",
    "mode": instance.spec.authority_mode,
    "entryUrl": entry_url,
    "token": instance.lease.token,
    "limits": limits,
    "locale": crate::i18n::current(),
  })
}

fn visible_for_debug() -> bool {
  std::env::var("LULL_GAME_AUTHORITY_VISIBLE").as_deref() == Ok("1")
}

/// 强制隐藏（对照组）：用于验证"隐藏 WebView 会暂停游戏页面 timer/rAF"。
fn hidden_forced() -> bool {
  std::env::var("LULL_GAME_AUTHORITY_HIDDEN").as_deref() == Ok("1")
}

/// self-loop 权威窗默认放到屏幕外但保持 visible。
///
/// 跨源 iframe 在 hidden 窗口里可能被 Chromium 当成不可见页面，timer/rAF 被挂起；
/// host-tick 由 Rust 驱动不受影响。P3 的对照方案是"可见但离屏 1×1"。
/// 用 `LULL_GAME_AUTHORITY_HIDDEN=1` 可强制隐藏做基线实验。
fn authority_window_placement(self_loop: bool) -> (bool, bool) {
  let debug_visible = visible_for_debug();
  let visible = debug_visible || (self_loop && !hidden_forced());
  let offscreen = self_loop && !debug_visible && !hidden_forced();
  (visible, offscreen)
}

/// 创建（或复用）权威窗口；已存在时直接返回。
pub fn create(
  app: &AppHandle,
  instance: &GameInstance,
  entry_url: &str,
  limits: &GameLimits,
) -> GameResult<()> {
  let label = label_for(&instance.instance_id);
  if app.get_webview_window(&label).is_some() {
    return Ok(());
  }
  let context = authority_context(instance, entry_url, limits);
  let context_json = serde_json::to_string(&context)
    .map_err(|error| GameError::new(codes::AUTHORITY_NOT_READY, error.to_string()))?;
  let locale = serde_json::to_string(&crate::i18n::current())
    .map_err(|error| GameError::new(codes::AUTHORITY_NOT_READY, error.to_string()))?;
  let script =
    format!("window.__LULL_LOCALE__ = {locale};\nwindow.__LULL_GAME_AUTHORITY__ = {context_json};");
  let self_loop = instance.spec.authority_mode == "self-loop";
  let (visible, offscreen) = authority_window_placement(self_loop);
  let width = if offscreen {
    1.0
  } else if self_loop {
    320.0
  } else {
    640.0
  };
  let height = if offscreen {
    1.0
  } else if self_loop {
    240.0
  } else {
    480.0
  };
  let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(ROUTE.into()))
    .title("Lull Game Authority")
    .inner_size(width, height)
    .visible(visible)
    .skip_taskbar(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .additional_browser_args(crate::webview::browser_args())
    .initialization_script(script)
    .devtools(crate::window_host::devtools_enabled());
  if offscreen {
    // 可见但 1×1 的屏幕角落：探索隐藏 WebView 下 timer/rAF 被挂起的问题。
    builder = builder.position(0.0, 0.0).focused(false);
  }
  builder.build().map_err(|error| {
    GameError::new(
      codes::AUTHORITY_NOT_READY,
      format!("创建游戏权威窗口失败：{error}"),
    )
    .with_detail(label)
  })?;
  Ok(())
}

pub fn destroy(app: &AppHandle, instance_id: &str) {
  if let Some(window) = app.get_webview_window(&label_for(instance_id)) {
    let _ = window.destroy();
  }
}

pub fn send_lifecycle(app: &AppHandle, instance_id: &str, lifecycle: &GameLifecycle) {
  super::manager::emit_to_authority(
    app,
    instance_id,
    super::manager::EVENT_LIFECYCLE,
    lifecycle.clone(),
  );
}

pub fn send_command(app: &AppHandle, instance_id: &str, command: &GameCommandEnvelope) {
  super::manager::emit_to_authority(
    app,
    instance_id,
    super::manager::EVENT_COMMAND,
    command.clone(),
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn labels_are_scoped_by_instance() {
    assert_eq!(
      label_for("0192f3a0000000000000000000000001"),
      "game-authority-0192f3a0000000000000000000000001"
    );
  }

  #[test]
  fn host_csp_allows_game_authority_iframe() {
    // authority 宿主壳通过 iframe 加载 http://lullgame.localhost/...；
    // 若 tauri.conf 的 frame-src 漏掉该源，所有游戏都会在 10s 后报 authority.not_ready。
    let raw = include_str!("../../tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(raw).expect("tauri.conf.json");
    for key in ["csp", "devCsp"] {
      let csp = config["app"]["security"][key]
        .as_str()
        .unwrap_or_else(|| panic!("app.security.{key} 缺失"));
      assert!(
        csp.contains("http://lullgame.localhost"),
        "{key} 的 frame-src 必须允许 lullgame.localhost，否则权威 iframe 被 CSP 拦截"
      );
      assert!(csp.contains("lullgame:"), "{key} 必须允许 lullgame: 协议");
    }
  }
}
