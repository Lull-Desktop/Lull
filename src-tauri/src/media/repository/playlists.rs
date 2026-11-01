//! 歌单仓储：歌单元数据与 Track 引用顺序。

use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};

use super::tracks::{TrackRow, TRACK_SELECT};
use super::{new_id, now_ms};
use crate::media::api::errors::MediaError;

#[derive(Debug, Clone, FromRow)]
pub struct PlaylistRow {
  pub id: String,
  pub name: String,
  pub description: Option<String>,
  pub track_count: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

const SELECT: &str = "\
SELECT p.id, p.name, p.description, \
  (SELECT COUNT(*) FROM music_playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count, \
  p.created_at, p.updated_at \
FROM music_playlists p";

pub async fn list(pool: &SqlitePool) -> Result<Vec<PlaylistRow>, MediaError> {
  sqlx::query_as::<_, PlaylistRow>(&format!("{SELECT} ORDER BY p.name COLLATE NOCASE, p.id"))
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取歌单失败：{error}")))
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<PlaylistRow>, MediaError> {
  sqlx::query_as::<_, PlaylistRow>(&format!("{SELECT} WHERE p.id = ?"))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取歌单失败：{error}")))
}

pub async fn create(
  pool: &SqlitePool,
  name: &str,
  description: Option<&str>,
) -> Result<PlaylistRow, MediaError> {
  let id = new_id("playlist");
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_playlists (id, name, description, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(name)
  .bind(description)
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建歌单失败：{error}")))?;
  get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::internal("创建歌单后读取失败"))
}

/// `description = Some("")` 会清空描述；`None` 表示保留。
pub async fn update(
  pool: &SqlitePool,
  id: &str,
  name: Option<&str>,
  description: Option<&str>,
) -> Result<PlaylistRow, MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启歌单事务失败：{error}")))?;
  if let Some(name) = name {
    sqlx::query("UPDATE music_playlists SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name)
      .bind(now_ms())
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("更新歌单名称失败：{error}")))?;
  }
  if let Some(description) = description {
    sqlx::query("UPDATE music_playlists SET description = ?, updated_at = ? WHERE id = ?")
      .bind(description)
      .bind(now_ms())
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("更新歌单描述失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交歌单事务失败：{error}")))?;
  get(pool, id)
    .await?
    .ok_or_else(|| MediaError::new("playlist.not-found", "歌单不存在"))
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<bool, MediaError> {
  let result = sqlx::query("DELETE FROM music_playlists WHERE id = ?")
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除歌单失败：{error}")))?;
  Ok(result.rows_affected() > 0)
}

pub async fn entries(pool: &SqlitePool, playlist_id: &str) -> Result<Vec<TrackRow>, MediaError> {
  let sql = format!(
    "{TRACK_SELECT} \
     JOIN music_playlist_tracks pt ON pt.track_id = t.id \
     WHERE pt.playlist_id = ? \
     ORDER BY pt.position, t.id"
  );
  sqlx::query_as::<_, TrackRow>(&sql)
    .bind(playlist_id)
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取歌单曲目失败：{error}")))
}

/// 添加 Track；已存在时返回 false，保持位置不变。
pub async fn add_track(
  pool: &SqlitePool,
  playlist_id: &str,
  track_id: &str,
) -> Result<bool, MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启歌单事务失败：{error}")))?;
  let exists: Option<i64> = sqlx::query_scalar(
    "SELECT 1 FROM music_playlist_tracks WHERE playlist_id = ? AND track_id = ?",
  )
  .bind(playlist_id)
  .bind(track_id)
  .fetch_optional(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("检查歌单曲目失败：{error}")))?;
  if exists.is_some() {
    return Ok(false);
  }
  let position: i64 = sqlx::query_scalar(
    "SELECT COALESCE(MAX(position), -1) + 1 FROM music_playlist_tracks WHERE playlist_id = ?",
  )
  .bind(playlist_id)
  .fetch_one(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("计算歌单位置失败：{error}")))?;
  sqlx::query(
    "INSERT INTO music_playlist_tracks (playlist_id, track_id, position, added_at) \
     VALUES (?, ?, ?, ?)",
  )
  .bind(playlist_id)
  .bind(track_id)
  .bind(position)
  .bind(now_ms())
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("添加歌单曲目失败：{error}")))?;
  touch(&mut tx, playlist_id).await?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交歌单事务失败：{error}")))?;
  Ok(true)
}

pub async fn remove_track(
  pool: &SqlitePool,
  playlist_id: &str,
  track_id: &str,
) -> Result<bool, MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启歌单事务失败：{error}")))?;
  let result =
    sqlx::query("DELETE FROM music_playlist_tracks WHERE playlist_id = ? AND track_id = ?")
      .bind(playlist_id)
      .bind(track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("移除歌单曲目失败：{error}")))?;
  if result.rows_affected() == 0 {
    return Ok(false);
  }
  renumber(&mut tx, playlist_id).await?;
  touch(&mut tx, playlist_id).await?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交歌单事务失败：{error}")))?;
  Ok(true)
}

/// 将 Track 移到从 0 开始的 position；越界会被夹到两端。
pub async fn reorder(
  pool: &SqlitePool,
  playlist_id: &str,
  track_id: &str,
  position: usize,
) -> Result<bool, MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启歌单事务失败：{error}")))?;
  let mut ids: Vec<String> = sqlx::query_scalar(
    "SELECT track_id FROM music_playlist_tracks \
     WHERE playlist_id = ? ORDER BY position, track_id",
  )
  .bind(playlist_id)
  .fetch_all(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("读取歌单顺序失败：{error}")))?;
  let Some(current) = ids.iter().position(|id| id == track_id) else {
    return Ok(false);
  };
  let item = ids.remove(current);
  let target = position.min(ids.len());
  ids.insert(target, item);
  for (index, id) in ids.iter().enumerate() {
    sqlx::query(
      "UPDATE music_playlist_tracks SET position = ? \
       WHERE playlist_id = ? AND track_id = ?",
    )
    .bind(i64::try_from(index).unwrap_or(i64::MAX))
    .bind(playlist_id)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("更新歌单顺序失败：{error}")))?;
  }
  touch(&mut tx, playlist_id).await?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交歌单事务失败：{error}")))?;
  Ok(true)
}

async fn renumber(tx: &mut Transaction<'_, Sqlite>, playlist_id: &str) -> Result<(), MediaError> {
  let ids: Vec<String> = sqlx::query_scalar(
    "SELECT track_id FROM music_playlist_tracks \
     WHERE playlist_id = ? ORDER BY position, track_id",
  )
  .bind(playlist_id)
  .fetch_all(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("读取歌单顺序失败：{error}")))?;
  for (index, id) in ids.iter().enumerate() {
    sqlx::query(
      "UPDATE music_playlist_tracks SET position = ? \
       WHERE playlist_id = ? AND track_id = ?",
    )
    .bind(i64::try_from(index).unwrap_or(i64::MAX))
    .bind(playlist_id)
    .bind(id)
    .execute(&mut **tx)
    .await
    .map_err(|error| MediaError::internal(format!("更新歌单顺序失败：{error}")))?;
  }
  Ok(())
}

async fn touch(tx: &mut Transaction<'_, Sqlite>, playlist_id: &str) -> Result<(), MediaError> {
  sqlx::query("UPDATE music_playlists SET updated_at = ? WHERE id = ?")
    .bind(now_ms())
    .bind(playlist_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| MediaError::internal(format!("更新歌单时间失败：{error}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  #[test]
  fn playlist_tracks_keep_order_and_renumber() {
    let path = std::env::temp_dir().join(format!("lull-playlist-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      let now = now_ms();
      for id in ["track-a", "track-b"] {
        sqlx::query(
          "INSERT INTO music_tracks (id, kind, title, added_at, updated_at) \
           VALUES (?, 'builtin', ?, ?, ?)",
        )
        .bind(id)
        .bind(id)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert track");
      }

      let playlist = create(&pool, "Mix", None).await.expect("create");
      assert!(add_track(&pool, &playlist.id, "track-a")
        .await
        .expect("add a"));
      assert!(add_track(&pool, &playlist.id, "track-b")
        .await
        .expect("add b"));
      assert!(!add_track(&pool, &playlist.id, "track-a")
        .await
        .expect("duplicate"));

      let rows = entries(&pool, &playlist.id).await.expect("entries");
      assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["track-a", "track-b"]
      );

      assert!(reorder(&pool, &playlist.id, "track-b", 0)
        .await
        .expect("reorder"));
      let rows = entries(&pool, &playlist.id).await.expect("entries");
      assert_eq!(rows[0].id, "track-b");

      assert!(remove_track(&pool, &playlist.id, "track-a")
        .await
        .expect("remove a"));
      let rows = entries(&pool, &playlist.id).await.expect("entries");
      assert_eq!(rows.len(), 1);
      assert_eq!(rows[0].id, "track-b");

      let positions: Vec<i64> = sqlx::query_scalar(
        "SELECT position FROM music_playlist_tracks WHERE playlist_id = ? ORDER BY position",
      )
      .bind(&playlist.id)
      .fetch_all(&pool)
      .await
      .expect("positions");
      assert_eq!(positions, [0]);

      assert!(remove(&pool, &playlist.id).await.expect("delete"));
      assert!(list(&pool).await.expect("list").is_empty());
      db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
