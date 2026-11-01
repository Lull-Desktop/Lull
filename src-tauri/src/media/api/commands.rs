//! Media API 的 Tauri 命令入口。
//!
//! P2：`settings` 可访问资料库与播放；`player` 可访问播放/队列/资料库读取；
//! `noise` 可访问噪声与资料库读取。引擎命令只允许 `media-engine` 窗口。
//! N1 起 `media_connect` 的订阅与快照由 `events` + `snapshot` 统一处理。

use serde_json::Value;
use tauri::{Manager, WebviewWindow};

use super::errors::MediaError;
use super::permissions;
use super::protocol::{MediaRequest, MediaResponse, PROTOCOL_VERSION};
use super::snapshot;
use crate::media::engine::{self, EngineEvent, ENGINE_LABEL};
use crate::media::events::{self, ConnectRequest};
use crate::media::{library, noise, output, playback};

fn media_window(label: &str) -> Result<(), MediaError> {
  if matches!(label, "settings" | "player" | "noise" | "library")
    || crate::widget_package::is_plugin_label(label)
  {
    Ok(())
  } else {
    Err(MediaError::new("capability.denied", "当前窗口没有媒体权限"))
  }
}

fn require_widget_token(label: &str, token: Option<&str>) -> Result<(), MediaError> {
  if crate::widget_package::verify_bridge_token(label, token) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "Widget bridge token 无效",
    ))
  }
}

fn widget_id(label: &str) -> Result<&str, MediaError> {
  label
    .strip_prefix(crate::widget_package::LABEL_PREFIX)
    .filter(|id| crate::widget_package::manifest::valid_id(id))
    .ok_or_else(|| MediaError::new("capability.denied", "Widget label 非法"))
}

fn require_widget_capability(
  app: &tauri::AppHandle,
  label: &str,
  capability: &str,
) -> Result<(), MediaError> {
  let id = widget_id(label)?;
  crate::widget_package::store::require_grant(app, id, capability)
    .map_err(|message| MediaError::new("capability.denied", message))
}

fn p3_access(namespace: &str, method: &str, label: &str) -> Result<(), MediaError> {
  if !matches!(namespace, "playlists" | "favorites" | "history") {
    return Ok(());
  }
  if matches!(label, "settings" | "library") {
    return Ok(());
  }
  if label == "player" {
    let allowed = match namespace {
      "favorites" => true,
      "playlists" => matches!(method, "list" | "get"),
      _ => false,
    };
    if allowed {
      return Ok(());
    }
  }
  Err(MediaError::new(
    "capability.denied",
    "当前窗口没有该媒体库权限",
  ))
}

fn host_only(namespace: &str, method: &str, label: &str) -> Result<(), MediaError> {
  if namespace == "folders" && !matches!(label, "settings" | "library") {
    return Err(MediaError::new(
      "capability.denied",
      "当前窗口没有音乐目录权限",
    ));
  }
  if namespace == "library" && label != "settings" {
    // 播放器/白噪音只需要曲目读取；来源列表含 rootPath，扫描/增删只属于 host。
    if !matches!(
      method,
      "listTracks" | "getTrack" | "getCoverUrl" | "listArtists" | "listAlbums" | "listDirectory"
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
  let is_widget = crate::widget_package::is_plugin_label(&label);
  if is_widget {
    if let Err(error) = require_widget_token(&label, request.bridge_token.as_deref()) {
      return MediaResponse::error(&request_id, &error, 0);
    }
    if let Err(error) = require_widget_capability(window.app_handle(), &label, "widget.media") {
      return MediaResponse::error(&request_id, &error, 0);
    }
    let Some(capability) = permissions::widget_capability(&request.namespace, &request.method)
    else {
      return MediaResponse::error(
        &request_id,
        &MediaError::new("capability.denied", "Widget 不能调用该媒体方法"),
        0,
      );
    };
    if let Err(error) = require_widget_capability(window.app_handle(), &label, capability) {
      return MediaResponse::error(&request_id, &error, 0);
    }
  } else {
    if let Err(error) = host_only(&request.namespace, &request.method, &label) {
      return MediaResponse::error(&request_id, &error, 0);
    }
    if let Err(error) = p3_access(&request.namespace, &request.method, &label) {
      return MediaResponse::error(&request_id, &error, 0);
    }
    if request.namespace == "noise" {
      if let Err(error) = permissions::official_noise_allowed(&label, &request.method) {
        return MediaResponse::error(&request_id, &error, 0);
      }
    }
  }

  if matches!(
    request.namespace.as_str(),
    "library" | "folders" | "playlists" | "favorites" | "history"
  ) {
    return library::call_media(
      window.clone(),
      &request_id,
      &request.namespace,
      &request.method,
      &request.args,
    )
    .await;
  }

  if request.namespace == "system" {
    let result = system_call(&window, &request.method, &request.args).await;
    return match result {
      Ok(value) => MediaResponse::ok(&request_id, value, snapshot::revision()),
      Err(error) => MediaResponse::error(&request_id, &error, snapshot::revision()),
    };
  }

  if request.namespace == "noise" {
    let result = noise::call(
      window.app_handle().clone(),
      &label,
      &request.method,
      &request.args,
    )
    .await;
    return match result {
      Ok(value) => MediaResponse::ok(&request_id, value, snapshot::revision()),
      Err(error) => MediaResponse::error(&request_id, &error, snapshot::revision()),
    };
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
    Ok(value) => MediaResponse::ok(&request_id, value, snapshot::revision()),
    Err(error) => MediaResponse::error(&request_id, &error, snapshot::revision()),
  }
}

async fn system_call(
  window: &WebviewWindow,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  match method {
    "snapshot" => {
      snapshot::snapshot().map(|snapshot| serde_json::to_value(snapshot).unwrap_or(Value::Null))
    }
    "getOutput" => Ok(serde_json::to_value(output::view()).unwrap_or(Value::Null)),
    "setOutput" => {
      let volume = args.get("volume").and_then(Value::as_f64);
      let muted = args.get("muted").and_then(Value::as_bool);
      if volume.is_none() && muted.is_none() {
        return Err(MediaError::invalid("缺少 volume 或 muted"));
      }
      let pool = library::pool()?;
      output::set(&window.app_handle().clone(), pool, volume, muted)
        .await
        .map(|view| serde_json::to_value(view).unwrap_or(Value::Null))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的媒体系统方法：{method}"),
    )),
  }
}

#[tauri::command]
pub fn media_connect(window: WebviewWindow, request: ConnectRequest) -> MediaResponse {
  if let Err(error) = media_window(window.label()) {
    return MediaResponse::error("connect", &error, 0);
  }
  let label = window.label().to_string();
  let is_widget = crate::widget_package::is_plugin_label(&label);
  let widget_grants: Vec<String> = if is_widget {
    if let Err(error) = require_widget_token(&label, request.bridge_token.as_deref()) {
      return MediaResponse::error("connect", &error, 0);
    }
    if let Err(error) = require_widget_capability(window.app_handle(), &label, "widget.media") {
      return MediaResponse::error("connect", &error, 0);
    }
    let granted = crate::widget_package::store::granted(
      window.app_handle(),
      widget_id(&label).unwrap_or_default(),
    );
    if !permissions::WIDGET_READ_CAPABILITIES
      .iter()
      .any(|capability| granted.iter().any(|item| item == capability))
    {
      return MediaResponse::error(
        "connect",
        &MediaError::new("capability.denied", "Widget 至少需要一项媒体读能力才能连接"),
        0,
      );
    }
    let allowed = permissions::widget_topics_for(&granted);
    events::register_with_topics(&label, request, &allowed, &allowed);
    granted
  } else {
    let allowed = permissions::official_topics(&label);
    if allowed.is_empty() {
      events::register(&label, request);
    } else {
      events::register_with_topics(&label, request, allowed, allowed);
    }
    Vec::new()
  };
  let app = window.app_handle().clone();
  if playback::is_engine_ready() {
    engine::send(
      &app,
      engine::meters(
        events::any_progress(),
        events::any_levels(),
        events::min_progress_ms(),
      ),
    );
  }
  let result = if is_widget {
    snapshot::widget_snapshot(&widget_grants).and_then(|value| {
      serde_json::to_value(value)
        .map_err(|error| MediaError::internal(format!("序列化 Widget 快照失败：{error}")))
    })
  } else {
    snapshot::snapshot().and_then(|value| {
      serde_json::to_value(value)
        .map_err(|error| MediaError::internal(format!("序列化媒体快照失败：{error}")))
    })
  };
  match result {
    Ok(value) => MediaResponse::ok(
      "connect",
      value,
      if is_widget {
        snapshot::widget_revision(&widget_grants)
      } else {
        snapshot::revision()
      },
    ),
    Err(error) => {
      events::disconnect(&label);
      MediaResponse::error(
        "connect",
        &error,
        if is_widget {
          snapshot::widget_revision(&widget_grants)
        } else {
          snapshot::revision()
        },
      )
    }
  }
}

#[tauri::command]
pub fn media_disconnect(window: WebviewWindow, bridge_token: Option<String>) {
  let label = window.label();
  if crate::widget_package::is_plugin_label(label)
    && !crate::widget_package::verify_bridge_token(label, bridge_token.as_deref())
  {
    return;
  }
  events::disconnect(label);
}

#[tauri::command]
pub fn media_engine_ready(window: WebviewWindow) -> Result<(), String> {
  if window.label() != ENGINE_LABEL {
    return Err("只有媒体引擎窗口可以上报 ready".to_string());
  }
  let app = window.app_handle().clone();
  playback::on_engine_ready(&app);
  noise::on_engine_ready(&app);
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
  fn media_gateway_accepts_official_and_widget_labels() {
    assert!(media_window("settings").is_ok());
    assert!(media_window("player").is_ok());
    assert!(media_window("noise").is_ok());
    assert!(media_window("library").is_ok());
    assert!(media_window("wallpaper-0").is_err());
    assert!(media_window("widget-rain").is_ok());
    assert!(media_window("widget-").is_err());
  }

  #[test]
  fn p3_access_is_window_scoped() {
    assert!(p3_access("playlists", "create", "library").is_ok());
    assert!(p3_access("playlists", "list", "player").is_ok());
    assert!(p3_access("playlists", "create", "player").is_err());
    assert!(p3_access("favorites", "set", "player").is_ok());
    assert!(p3_access("history", "clear", "player").is_err());
    assert!(p3_access("history", "list", "noise").is_err());
  }

  #[test]
  fn non_host_windows_only_read_track_views() {
    for method in [
      "listTracks",
      "getTrack",
      "getCoverUrl",
      "listArtists",
      "listAlbums",
    ] {
      assert!(host_only("library", method, "player").is_ok());
    }
    for method in ["listSources", "addSource", "removeSource", "startScan"] {
      assert!(host_only("library", method, "player").is_err());
    }
    assert!(host_only("library", "listSources", "settings").is_ok());
    assert!(host_only("folders", "list", "library").is_ok());
    assert!(host_only("folders", "add", "settings").is_ok());
    assert!(host_only("folders", "list", "player").is_err());
    assert!(host_only("folders", "getTracks", "noise").is_err());
  }
}
