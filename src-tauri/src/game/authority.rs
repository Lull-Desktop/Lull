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
  let visible = visible_for_debug();
  let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(ROUTE.into()))
    .title("Lull Game Authority")
    .inner_size(640.0, 480.0)
    .visible(visible)
    .skip_taskbar(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .additional_browser_args(crate::webview::browser_args())
    .initialization_script(script)
    .devtools(crate::window_host::devtools_enabled());
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
}
