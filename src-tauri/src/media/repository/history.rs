//! 播放历史仓储。
//!
//! 历史是“播放尝试”日志，不参与播放状态；按 played_at DESC 分页。

use sqlx::{FromRow, SqlitePool};

use super::{new_id, now_ms};
use crate::media::api::errors::MediaError;

const HISTORY_LIMIT: i64 = 2_000;

#[derive(Debug, Clone, FromRow)]
pub struct HistoryRow {
  pub id: String,
  pub track_id: String,
  pub played_at: i64,
  pub completed: i64,
}

pub async fn record(
  pool: &SqlitePool,
  track_id: &str,
  duration_ms: Option<i64>,
  completed: bool,
) -> Result<String, MediaError> {
  let id = new_id("history");
  sqlx::query(
    "INSERT INTO music_play_history \
     (id, track_id, played_at, duration_ms, completed, source) \
     VALUES (?, ?, ?, ?, ?, 'play')",
  )
  .bind(&id)
  .bind(track_id)
  .bind(now_ms())
  .bind(duration_ms)
  .bind(if completed { 1_i64 } else { 0_i64 })
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("写入播放历史失败：{error}")))?;
  let _ = sqlx::query(
    "DELETE FROM music_play_history WHERE id IN (\
       SELECT id FROM music_play_history ORDER BY played_at DESC LIMIT -1 OFFSET ?\
     )",
  )
  .bind(HISTORY_LIMIT)
  .execute(pool)
  .await;
  Ok(id)
}

pub async fn list(
  pool: &SqlitePool,
  page: u32,
  page_size: u32,
) -> Result<(Vec<HistoryRow>, i64), MediaError> {
  let page = page.max(1);
  let page_size = page_size.clamp(1, 200);
  let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);
  let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_play_history")
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("统计播放历史失败：{error}")))?;
  let rows = sqlx::query_as::<_, HistoryRow>(
    "SELECT id, track_id, played_at, completed FROM music_play_history \
     ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?",
  )
  .bind(i64::from(page_size))
  .bind(offset)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取播放历史失败：{error}")))?;
  Ok((rows, total))
}

pub async fn clear(pool: &SqlitePool) -> Result<u64, MediaError> {
  let result = sqlx::query("DELETE FROM music_play_history")
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("清空播放历史失败：{error}")))?;
  Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  #[test]
  fn history_records_and_pages_newest_first() {
    let path = std::env::temp_dir().join(format!("lull-history-test-{}.db", uuid::Uuid::now_v7()));
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

      record(&pool, "track-a", Some(1000), false)
        .await
        .expect("record 1");
      record(&pool, "track-a", Some(1000), true)
        .await
        .expect("record 2");
      let (rows, total) = list(&pool, 1, 10).await.expect("list");
      assert_eq!(total, 2);
      assert_eq!(rows.len(), 2);
      assert!(rows[0].played_at >= rows[1].played_at);

      assert_eq!(clear(&pool).await.expect("clear"), 2);
      let (rows, total) = list(&pool, 1, 10).await.expect("list");
      assert_eq!(total, 0);
      assert!(rows.is_empty());
      db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
