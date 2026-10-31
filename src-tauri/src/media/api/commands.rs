//! Media API 的 Tauri 命令入口。
//!
//! P2：`settings` 可访问资料库与播放；`player` 可访问播放/队列/资料库读取；
//! `noise` 可访问噪声与资料库读取。引擎命令只允许 `media-engine` 窗口。

use serde_json::Value;
use tauri::{Manager, WebviewWindow};

use super::errors::MediaError;
use super::protocol::{MediaRequest, MediaResponse, PROTOCOL_VERSION};
use crate::media::playback::engine::{EngineEvent, ENGINE_LABEL};
use crate::media::playback::model::ConnectRequest;
use crate::media::{library, playback};

fn media_window(label: &str) -> Result<(), MediaError> {
  if matches!(label, "settings" | "player" | "noise") {
    Ok(())
  } else {
    Err(MediaError::new("capability.denied", "当前窗口没有媒体权限"))
  }
}

fn host_only(namespace: &str, method: &str, label: &str) -> Result<(), MediaError> {
  if namespace == "library" && label != "settings" {
    // 播放器/白噪音只需要曲目读取；来源列表含 rootPath，扫描/增删只属于 host。
    if !matches!(
      method,
      "listTracks" | "getTrack" | "listArtists" | "listAlbums"
    ) {
      return Err(MediaError::new(
        "capability.denied",
        "当前窗口没有该资料库权限",
      ));
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn media_call(window: WebviewWindow, request: MediaRequest) -> MediaResponse {
  let request_id = request.request_id.clone();
  if request.protocol != PROTOCOL_VERSION {
    return MediaResponse::error(
      &request_id,
      &MediaError::new("protocol.unsupported", "不支持的媒体协议版本"),
      0,
    );
  }
  let label = window.label().to_string();
  if let Err(error) = media_window(&label) {
    return MediaResponse::error(&request_id, &error, 0);
  }
  if let Err(error) = host_only(&request.namespace, &request.method, &label) {
    return MediaResponse::error(&request_id, &error, 0);
  }

  if request.namespace == "library" {
    return library::call_media(
      window.app_handle().clone(),
      &request_id,
      &request.namespace,
      &request.method,
      &request.args,
    )
    .await;
  }

  match playback::call(
    window.app_handle().clone(),
    &label,
    &request.namespace,
    &request.method,
    &request.args,
  )
  .await
  {
    Ok(value) => MediaResponse::ok(&request_id, value, playback::revision()),
    Err(error) => MediaResponse::error(&request_id, &error, playback::revision()),
  }
}

#[tauri::command]
pub fn media_connect(window: WebviewWindow, request: ConnectRequest) -> MediaResponse {
  if let Err(error) = media_window(window.label()) {
    return MediaResponse::error("connect", &error, 0);
  }
  match playback::connect(&window.app_handle().clone(), window.label(), request) {
    Ok(snapshot) => MediaResponse::ok(
      "connect",
      serde_json::to_value(snapshot).unwrap_or(Value::Null),
      playback::revision(),
    ),
    Err(error) => MediaResponse::error("connect", &error, playback::revision()),
  }
}

#[tauri::command]
pub fn media_disconnect(window: WebviewWindow) {
  playback::disconnect(window.label());
}

#[tauri::command]
pub fn media_engine_ready(window: WebviewWindow) -> Result<(), String> {
  if window.label() != ENGINE_LABEL {
    return Err("只有媒体引擎窗口可以上报 ready".to_string());
  }
  playback::on_engine_ready(&window.app_handle().clone());
  Ok(())
}

#[tauri::command]
pub fn media_engine_event(window: WebviewWindow, event: Value) -> Result<(), String> {
  if window.label() != ENGINE_LABEL {
    return Err("只有媒体引擎窗口可以上报事件".to_string());
  }
  let event: EngineEvent = serde_json::from_value(event).map_err(|error| error.to_string())?;
  playback::handle_engine_event(&window, event).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_official_windows_reach_media_api() {
    assert!(media_window("settings").is_ok());
    assert!(media_window("player").is_ok());
    assert!(media_window("noise").is_ok());
    assert!(media_window("wallpaper-0").is_err());
    assert!(media_window("widget-rain").is_err());
  }

  #[test]
  fn non_host_windows_only_read_track_views() {
    for method in ["listTracks", "getTrack", "listArtists", "listAlbums"] {
      assert!(host_only("library", method, "player").is_ok());
    }
    for method in ["listSources", "addSource", "removeSource", "startScan"] {
      assert!(host_only("library", method, "player").is_err());
    }
    assert!(host_only("library", "listSources", "settings").is_ok());
  }
}
