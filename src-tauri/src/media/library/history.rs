//! 播放历史业务门面：记录、分页读取与清空。

use std::collections::HashMap;

use tauri::AppHandle;

use super::events;
use super::pool;
use crate::media::api::dto::HistoryEntry;
use crate::media::api::dto::Page;
use crate::media::api::dto::TrackSummary;
use crate::media::api::errors::MediaError;
use crate::media::repository::{history, tracks};

pub async fn record(
  app: &AppHandle,
  track_id: &str,
  duration_ms: Option<i64>,
) -> Result<(), MediaError> {
  history::record(pool()?, track_id, duration_ms, false).await?;
  events::emit(
    app,
    "history.changed",
    serde_json::json!({ "trackId": track_id }),
  );
  Ok(())
}

pub async fn list(page: u32, page_size: u32) -> Result<Page<HistoryEntry>, MediaError> {
  let page = page.max(1);
  let page_size = page_size.clamp(1, 200);
  let (rows, total) = history::list(pool()?, page, page_size).await?;
  let ids: Vec<String> = rows.iter().map(|row| row.track_id.clone()).collect();
  let tracks = tracks::list_by_ids(pool()?, &ids).await?;
  let mut by_id: HashMap<String, TrackSummary> = tracks
    .into_iter()
    .map(|row| (row.id.clone(), TrackSummary::from(row)))
    .collect();
  let items = rows
    .into_iter()
    .map(|row| HistoryEntry {
      id: row.id,
      track_id: row.track_id.clone(),
      track: by_id.remove(&row.track_id),
      played_at: row.played_at,
      completed: row.completed != 0,
    })
    .collect();
  Ok(Page::new(items, total, page, page_size))
}

pub async fn clear(app: &AppHandle) -> Result<u64, MediaError> {
  let cleared = history::clear(pool()?).await?;
  events::emit(
    app,
    "history.changed",
    serde_json::json!({ "cleared": cleared }),
  );
  Ok(cleared)
}
