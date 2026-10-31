//! 隐藏的 `media-engine` WebView：创建窗口、下发命令、解析引擎事件。
//!
//! 引擎是宿主受信任代码，不是可替换 Widget；业务状态仍由 Rust 持有。所有命令
//! 通过定向事件发送，页面通过 `media_engine_event` 上报。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static CREATING: AtomicBool = AtomicBool::new(false);

pub const ENGINE_LABEL: &str = "media-engine";
pub const COMMAND_EVENT: &str = "media-engine-command";
pub const MEDIA_EVENT: &str = "media:event";

#[derive(Debug, Clone, Deserialize)]
#[serde(
  tag = "type",
  rename_all = "camelCase",
  rename_all_fields = "camelCase"
)]
pub enum EngineEvent {
  Ready {
    #[serde(default)]
    instance_id: Option<String>,
  },
  #[serde(rename = "player.loaded")]
  PlayerLoaded {
    load_id: String,
    #[serde(default)]
    duration_ms: Option<i64>,
  },
  #[serde(rename = "player.state")]
  PlayerState {
    load_id: String,
    status: String,
    position_ms: i64,
    #[serde(default)]
    duration_ms: Option<i64>,
    #[serde(default)]
    error: Option<Value>,
  },
  #[serde(rename = "player.progress")]
  PlayerProgress {
    load_id: String,
    position_ms: i64,
  },
  Levels {
    player: f64,
    noise: f64,
  },
  Error {
    scope: String,
    code: String,
    message: String,
  },
}

/// 懒创建隐藏引擎窗口；运行时建 WebView2 必须离开主线程。
pub fn ensure_window(app: &AppHandle) {
  if app.get_webview_window(ENGINE_LABEL).is_some() {
    return;
  }
  if CREATING.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    if app.get_webview_window(ENGINE_LABEL).is_some() {
      CREATING.store(false, Ordering::SeqCst);
      return;
    }
    let result =
      WebviewWindowBuilder::new(&app, ENGINE_LABEL, WebviewUrl::App("media-engine".into()))
        .title("Lull Media Engine")
        .inner_size(320.0, 240.0)
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .additional_browser_args(crate::webview::browser_args())
        .initialization_script("window.__LULL_MEDIA_ENGINE__ = true;")
        .build();
    CREATING.store(false, Ordering::SeqCst);
    if let Err(error) = result {
      crate::wallpaper::wlog(&format!("media engine 窗口创建失败：{error}"));
    }
  });
}

/// 发送一条引擎命令；窗口不存在时忽略，ready 后会重新全量同步。
pub fn send(app: &AppHandle, command: Value) {
  if let Err(error) = app.emit_to(ENGINE_LABEL, COMMAND_EVENT, command) {
    crate::wallpaper::wlog(&format!("media engine 命令发送失败：{error}"));
  }
}

#[must_use]
pub fn player_load(
  load_id: &str,
  source: &Value,
  position_ms: i64,
  duration_ms: Option<i64>,
  autoplay: bool,
) -> Value {
  json!({
    "v": 1,
    "type": "player.load",
    "loadId": load_id,
    "source": source,
    "positionMs": position_ms,
    "durationMs": duration_ms,
    "autoplay": autoplay,
  })
}

#[must_use]
pub fn player_control(kind: &str) -> Value {
  json!({ "v": 1, "type": kind })
}

#[must_use]
pub fn player_seek(position_ms: i64) -> Value {
  json!({ "v": 1, "type": "player.seek", "positionMs": position_ms })
}

#[must_use]
pub fn player_volume(volume: f64, muted: bool) -> Value {
  json!({ "v": 1, "type": "player.volume", "volume": volume, "muted": muted })
}

#[must_use]
pub fn noise_sync(
  active: bool,
  master: f64,
  muted: bool,
  layers: &[crate::media::playback::model::NoiseLayerView],
) -> Value {
  json!({
    "v": 1,
    "type": "noise.sync",
    "active": active,
    "master": master,
    "muted": muted,
    "layers": layers,
  })
}

#[must_use]
pub fn meters(player: bool, noise: bool, interval_ms: u64) -> Value {
  json!({
    "v": 1,
    "type": "meters",
    "player": player,
    "noise": noise,
    "intervalMs": interval_ms,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_player_state_and_progress_events() {
    let state: EngineEvent = serde_json::from_value(json!({
      "type": "player.state",
      "loadId": "load-1",
      "status": "playing",
      "positionMs": 1234,
      "durationMs": 252000,
    }))
    .expect("state event");
    match state {
      EngineEvent::PlayerState {
        load_id,
        status,
        position_ms,
        ..
      } => {
        assert_eq!(load_id, "load-1");
        assert_eq!(status, "playing");
        assert_eq!(position_ms, 1234);
      }
      _ => panic!("unexpected event"),
    }

    let progress: EngineEvent = serde_json::from_value(json!({
      "type": "player.progress",
      "loadId": "load-1",
      "positionMs": 2000,
    }))
    .expect("progress event");
    assert!(matches!(
      progress,
      EngineEvent::PlayerProgress {
        position_ms: 2000,
        ..
      }
    ));
  }

  #[test]
  fn builds_commands_with_expected_wire_shape() {
    let command = player_load(
      "load-2",
      &json!({ "kind": "ambient", "preset": {} }),
      100,
      Some(200),
      true,
    );
    assert_eq!(command["type"], "player.load");
    assert_eq!(command["loadId"], "load-2");
    assert_eq!(command["autoplay"], true);
    assert_eq!(player_control("player.pause")["type"], "player.pause");
    assert_eq!(player_seek(500)["positionMs"], 500);
    assert_eq!(player_volume(0.5, true)["muted"], true);
    assert_eq!(meters(true, false, 500)["intervalMs"], 500);
  }
}
