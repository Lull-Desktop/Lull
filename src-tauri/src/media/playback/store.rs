//! 音乐播放状态与队列的持久化。
//!
//! Noise Session/Track 不落盘；Noise 偏好由 `media::noise` 自己的仓储保存。

use sqlx::SqlitePool;

use super::PlayerData;
use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

pub async fn load(pool: &SqlitePool) -> Result<(PlayerData, Vec<String>), MediaError> {
  let player = sqlx::query_as::<_, PlayerRow>(
    "SELECT current_track_id, position_ms, volume, muted, mode \
     FROM player_state WHERE id = 1",
  )
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取播放状态失败：{error}")))?;

  let player = player.unwrap_or_else(|| PlayerRow {
    current_track_id: None,
    position_ms: 0,
    volume: 0.78,
    muted: 0,
    mode: "sequence".to_string(),
  });

  let queue: Vec<String> =
    sqlx::query_scalar("SELECT track_id FROM player_queue ORDER BY position")
      .fetch_all(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取播放队列失败：{error}")))?;

  Ok((
    PlayerData {
      current_track_id: player.current_track_id,
      position_ms: player.position_ms.max(0),
      volume: player.volume.clamp(0.0, 1.0),
      muted: player.muted != 0,
      mode: player.mode,
    },
    queue,
  ))
}

pub async fn save_player(pool: &SqlitePool, player: &PlayerData) -> Result<(), MediaError> {
  sqlx::query(
    "INSERT INTO player_state \
     (id, current_track_id, position_ms, volume, muted, mode, updated_at) \
     VALUES (1, ?, ?, ?, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       current_track_id = excluded.current_track_id, position_ms = excluded.position_ms, \
       volume = excluded.volume, muted = excluded.muted, mode = excluded.mode, \
       updated_at = excluded.updated_at",
  )
  .bind(&player.current_track_id)
  .bind(player.position_ms)
  .bind(player.volume)
  .bind(if player.muted { 1_i64 } else { 0_i64 })
  .bind(&player.mode)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存播放状态失败：{error}")))?;
  Ok(())
}

pub async fn save_queue(pool: &SqlitePool, ids: &[String]) -> Result<(), MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启队列事务失败：{error}")))?;
  sqlx::query("DELETE FROM player_queue")
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清空播放队列失败：{error}")))?;
  for (position, id) in ids.iter().enumerate() {
    sqlx::query("INSERT INTO player_queue (position, track_id) VALUES (?, ?)")
      .bind(i64::try_from(position).unwrap_or(i64::MAX))
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入播放队列失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交播放队列失败：{error}")))?;
  Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct PlayerRow {
  current_track_id: Option<String>,
  position_ms: i64,
  volume: f64,
  muted: i64,
  mode: String,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn playback_state_roundtrips_with_empty_queue() {
    let path = std::env::temp_dir().join(format!("lull-playback-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      let (player, queue) = load(&pool).await.expect("load defaults");
      assert!((player.volume - 0.78).abs() < f64::EPSILON);
      assert!(player.current_track_id.is_none());
      assert!(queue.is_empty());

      sqlx::query(
        "INSERT INTO music_tracks (id, kind, title, status, added_at, updated_at) \
         VALUES ('track-a', 'file', 'A', 'active', 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("track");
      let player = PlayerData {
        current_track_id: Some("track-a".to_string()),
        position_ms: 1234,
        volume: 0.42,
        muted: true,
        mode: "repeat-one".to_string(),
      };
      save_player(&pool, &player).await.expect("save player");
      let (restored, _) = load(&pool).await.expect("reload");
      assert_eq!(restored.current_track_id, player.current_track_id);
      assert_eq!(restored.position_ms, 1234);
      assert!(restored.muted);
      assert_eq!(restored.mode, "repeat-one");
      crate::media::repository::db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
