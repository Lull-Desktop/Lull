//! 播放状态、队列与噪声混音的持久化。

use sqlx::SqlitePool;

use super::{NoiseData, PlayerData};
use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

pub async fn load(pool: &SqlitePool) -> Result<(PlayerData, Vec<String>, NoiseData), MediaError> {
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

  let noise = sqlx::query_as::<_, NoiseRow>(
    "SELECT active, master, muted, sleep_minutes, sleep_ends_at, layers_json \
     FROM noise_state WHERE id = 1",
  )
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取噪声状态失败：{error}")))?;

  let noise = noise.unwrap_or_else(NoiseRow::default);
  let mut layers: Vec<crate::media::playback::model::NoiseLayerView> =
    serde_json::from_str(&noise.layers_json).unwrap_or_default();
  if layers.is_empty() {
    layers = super::default_layers();
  }

  Ok((
    PlayerData {
      current_track_id: player.current_track_id,
      position_ms: player.position_ms.max(0),
      volume: player.volume.clamp(0.0, 1.0),
      muted: player.muted != 0,
      mode: player.mode,
    },
    queue,
    NoiseData {
      active: noise.active != 0,
      master: noise.master.clamp(0.0, 1.0),
      muted: noise.muted != 0,
      layers,
      sleep_minutes: noise.sleep_minutes.max(0),
      sleep_ends_at: noise.sleep_ends_at,
    },
  ))
}

/// 队列为空时用内置曲目填充；已有队列保持用户顺序。
pub async fn ensure_queue(pool: &SqlitePool, queue: &[String]) -> Result<Vec<String>, MediaError> {
  if !queue.is_empty() {
    return Ok(queue.to_vec());
  }
  let ids: Vec<String> = sqlx::query_scalar(
    "SELECT id FROM music_tracks WHERE kind = 'builtin' \
     ORDER BY title COLLATE NOCASE, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取内置曲目失败：{error}")))?;
  save_queue(pool, &ids).await?;
  Ok(ids)
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

pub async fn save_noise(pool: &SqlitePool, noise: &NoiseData) -> Result<(), MediaError> {
  let layers = serde_json::to_string(&noise.layers)
    .map_err(|error| MediaError::internal(format!("序列化噪声图层失败：{error}")))?;
  sqlx::query(
    "INSERT INTO noise_state \
     (id, active, master, muted, sleep_minutes, sleep_ends_at, layers_json, updated_at) \
     VALUES (1, ?, ?, ?, ?, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       active = excluded.active, master = excluded.master, muted = excluded.muted, \
       sleep_minutes = excluded.sleep_minutes, sleep_ends_at = excluded.sleep_ends_at, \
       layers_json = excluded.layers_json, updated_at = excluded.updated_at",
  )
  .bind(if noise.active { 1_i64 } else { 0_i64 })
  .bind(noise.master)
  .bind(if noise.muted { 1_i64 } else { 0_i64 })
  .bind(noise.sleep_minutes)
  .bind(noise.sleep_ends_at)
  .bind(layers)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存噪声状态失败：{error}")))?;
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

#[derive(Debug, sqlx::FromRow)]
struct NoiseRow {
  active: i64,
  master: f64,
  muted: i64,
  sleep_minutes: i64,
  sleep_ends_at: Option<i64>,
  layers_json: String,
}

impl Default for NoiseRow {
  fn default() -> Self {
    Self {
      active: 0,
      master: 0.75,
      muted: 0,
      sleep_minutes: 0,
      sleep_ends_at: None,
      layers_json: "[]".to_string(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::library::catalog;

  #[test]
  fn playback_state_roundtrips_and_queue_defaults_to_builtins() {
    let path = std::env::temp_dir().join(format!("lull-playback-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      catalog::seed(&pool).await.expect("seed catalog");
      let (player, queue, noise) = load(&pool).await.expect("load defaults");
      assert!((player.volume - 0.78).abs() < f64::EPSILON);
      assert!(queue.is_empty());
      assert!(!noise.active);
      assert_eq!(noise.layers.len(), 5);

      let queue = ensure_queue(&pool, &queue).await.expect("seed queue");
      assert_eq!(
        queue.first().map(String::as_str),
        Some("online-beyond-the-horizon")
      );

      let player = PlayerData {
        current_track_id: Some("online-beyond-the-horizon".to_string()),
        position_ms: 1234,
        volume: 0.42,
        muted: true,
        mode: "repeat-one".to_string(),
      };
      save_player(&pool, &player).await.expect("save player");
      let (restored, _, _) = load(&pool).await.expect("reload");
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
