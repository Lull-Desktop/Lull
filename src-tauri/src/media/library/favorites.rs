//! 曲目收藏业务门面。

use tauri::AppHandle;

use super::events;
use super::pool;
use crate::media::api::dto::{FavoriteView, Page, TrackQuery, TrackSummary};
use crate::media::api::errors::MediaError;
use crate::media::repository::favorites;

pub async fn list(page: u32, page_size: u32) -> Result<Page<TrackSummary>, MediaError> {
  let query = TrackQuery {
    page: Some(page),
    page_size: Some(page_size),
    favorite_only: Some(true),
    ..TrackQuery::default()
  };
  super::list_tracks(&query).await
}

pub async fn set(
  app: &AppHandle,
  track_id: &str,
  favorite: bool,
) -> Result<FavoriteView, MediaError> {
  let pool = pool()?;
  ensure_track(pool, track_id).await?;
  favorites::set(pool, track_id, favorite).await?;
  events::emit(
    app,
    "favorites.changed",
    serde_json::json!({ "trackId": track_id, "favorite": favorite }),
  );
  Ok(FavoriteView {
    track_id: track_id.to_string(),
    favorite,
  })
}

async fn ensure_track(pool: &sqlx::SqlitePool, track_id: &str) -> Result<(), MediaError> {
  let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM music_tracks WHERE id = ?")
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("检查曲目失败：{error}")))?;
  if exists.is_none() {
    return Err(MediaError::new("track.not-found", "曲目不存在"));
  }
  Ok(())
}
