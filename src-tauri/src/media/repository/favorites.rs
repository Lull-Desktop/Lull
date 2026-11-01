//! 曲目收藏仓储。

use sqlx::SqlitePool;

use super::now_ms;
use crate::media::api::errors::MediaError;

pub async fn set(pool: &SqlitePool, track_id: &str, favorite: bool) -> Result<bool, MediaError> {
  if favorite {
    sqlx::query(
      "INSERT INTO music_favorites (track_id, created_at) VALUES (?, ?) \
       ON CONFLICT(track_id) DO NOTHING",
    )
    .bind(track_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("收藏曲目失败：{error}")))?;
  } else {
    sqlx::query("DELETE FROM music_favorites WHERE track_id = ?")
      .bind(track_id)
      .execute(pool)
      .await
      .map_err(|error| MediaError::internal(format!("取消收藏失败：{error}")))?;
  }
  Ok(favorite)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::api::dto::TrackQuery;
  use crate::media::repository::{db, tracks};

  #[test]
  fn favorites_filter_track_list() {
    let path =
      std::env::temp_dir().join(format!("lull-favorites-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      let now = now_ms();
      sqlx::query(
        "INSERT INTO music_tracks (id, kind, title, added_at, updated_at) \
         VALUES ('track-a', 'builtin', 'A', ?, ?)",
      )
      .bind(now)
      .bind(now)
      .execute(&pool)
      .await
      .expect("insert track");

      set(&pool, "track-a", true).await.expect("favorite");
      let query = TrackQuery {
        favorite_only: Some(true),
        ..TrackQuery::default()
      };
      let (rows, total) = tracks::list(&pool, &query).await.expect("list favorites");
      assert_eq!(total, 1);
      assert_eq!(rows[0].favorite, 1);

      set(&pool, "track-a", false).await.expect("unfavorite");
      let (rows, total) = tracks::list(&pool, &query).await.expect("list favorites");
      assert_eq!(total, 0);
      assert!(rows.is_empty());
      db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
