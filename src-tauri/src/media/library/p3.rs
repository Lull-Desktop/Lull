//! P3 Media API：playlists / favorites / history 三个命名空间的分发。
//!
//! 与 `library` 一样，这里只解析参数、调用业务函数并包成 `MediaResponse`；
//! 不直接写 SQL。

use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

use super::{events, favorites, history, playlists};
use crate::media::api::errors::MediaError;
use crate::media::api::protocol::MediaResponse;

pub async fn call(
  window: WebviewWindow,
  request_id: &str,
  namespace: &str,
  method: &str,
  args: &Value,
) -> MediaResponse {
  let app = window.app_handle().clone();
  let result = match (namespace, method) {
    ("playlists", "list") => playlists::list()
      .await
      .map(|items| serde_json::to_value(items).unwrap_or(Value::Null)),
    ("playlists", "get") => {
      with_string(args, "playlistId", |playlist_id| async move {
        playlists::get(&playlist_id)
          .await
          .map(|detail| serde_json::to_value(detail).unwrap_or(Value::Null))
      })
      .await
    }
    ("playlists", "create") => {
      let name = args
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 name"));
      let description = args.get("description").and_then(Value::as_str);
      match name {
        Ok(name) => playlists::create(&app, name, description)
          .await
          .map(|detail| serde_json::to_value(detail).unwrap_or(Value::Null)),
        Err(error) => Err(error),
      }
    }
    ("playlists", "update") => {
      let playlist_id = args
        .get("playlistId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 playlistId"));
      let name = args.get("name").and_then(Value::as_str);
      let description = args.get("description").and_then(Value::as_str);
      if name.is_none() && description.is_none() {
        return MediaResponse::error(
          request_id,
          &MediaError::invalid("缺少 name 或 description"),
          events::revision(),
        );
      }
      match playlist_id {
        Ok(playlist_id) => playlists::update(&app, playlist_id, name, description)
          .await
          .map(|detail| serde_json::to_value(detail).unwrap_or(Value::Null)),
        Err(error) => Err(error),
      }
    }
    ("playlists", "delete") => {
      with_string(args, "playlistId", |playlist_id| async move {
        playlists::remove(&app, &playlist_id)
          .await
          .map(|removed| json!({ "removed": removed }))
      })
      .await
    }
    ("playlists", "addTrack") => {
      let playlist_id = args
        .get("playlistId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 playlistId"));
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      match (playlist_id, track_id) {
        (Ok(playlist_id), Ok(track_id)) => playlists::add_track(&app, playlist_id, track_id)
          .await
          .map(|()| json!({ "ok": true })),
        (Err(error), _) | (_, Err(error)) => Err(error),
      }
    }
    ("playlists", "removeTrack") => {
      let playlist_id = args
        .get("playlistId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 playlistId"));
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      match (playlist_id, track_id) {
        (Ok(playlist_id), Ok(track_id)) => playlists::remove_track(&app, playlist_id, track_id)
          .await
          .map(|removed| json!({ "removed": removed })),
        (Err(error), _) | (_, Err(error)) => Err(error),
      }
    }
    ("playlists", "reorder") => {
      let playlist_id = args
        .get("playlistId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 playlistId"));
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      let position = args
        .get("position")
        .and_then(Value::as_u64)
        .ok_or_else(|| MediaError::invalid("缺少 position"));
      match (playlist_id, track_id, position) {
        (Ok(playlist_id), Ok(track_id), Ok(position)) => playlists::reorder(
          &app,
          playlist_id,
          track_id,
          usize::try_from(position).unwrap_or(usize::MAX),
        )
        .await
        .map(|moved| json!({ "moved": moved })),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
      }
    }
    ("playlists", "importM3u") => playlists::import_m3u(&app)
      .await
      .map(|result| serde_json::to_value(result).unwrap_or(Value::Null)),
    ("playlists", "exportM3u") => {
      with_string(args, "playlistId", |playlist_id| async move {
        playlists::export_m3u(&playlist_id)
          .await
          .map(|result| serde_json::to_value(result).unwrap_or(Value::Null))
      })
      .await
    }
    ("favorites", "list") => {
      let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
      let page_size = args.get("pageSize").and_then(Value::as_u64).unwrap_or(50);
      favorites::list(
        u32::try_from(page).unwrap_or(1),
        u32::try_from(page_size).unwrap_or(50),
      )
      .await
      .map(|page| serde_json::to_value(page).unwrap_or(Value::Null))
    }
    ("favorites", "set") => {
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      let favorite = args
        .get("favorite")
        .and_then(Value::as_bool)
        .ok_or_else(|| MediaError::invalid("缺少 favorite"));
      match (track_id, favorite) {
        (Ok(track_id), Ok(favorite)) => favorites::set(&app, track_id, favorite)
          .await
          .map(|view| serde_json::to_value(view).unwrap_or(Value::Null)),
        (Err(error), _) | (_, Err(error)) => Err(error),
      }
    }
    ("history", "list") => {
      let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
      let page_size = args.get("pageSize").and_then(Value::as_u64).unwrap_or(50);
      history::list(
        u32::try_from(page).unwrap_or(1),
        u32::try_from(page_size).unwrap_or(50),
      )
      .await
      .map(|page| serde_json::to_value(page).unwrap_or(Value::Null))
    }
    ("history", "clear") => history::clear(&app)
      .await
      .map(|cleared| json!({ "cleared": cleared })),
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的媒体方法：{namespace}.{method}"),
    )),
  };

  let revision = events::revision();
  match result {
    Ok(value) => MediaResponse::ok(request_id, value, revision),
    Err(error) => MediaResponse::error(request_id, &error, revision),
  }
}

async fn with_string<F, Fut>(args: &Value, key: &str, action: F) -> Result<Value, MediaError>
where
  F: FnOnce(String) -> Fut,
  Fut: std::future::Future<Output = Result<Value, MediaError>>,
{
  let value = args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))?;
  action(value.to_string()).await
}
