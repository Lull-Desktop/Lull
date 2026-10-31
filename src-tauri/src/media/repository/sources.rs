//! 音乐来源（用户授权的根目录 + 内置曲目来源）。

use sqlx::{FromRow, SqlitePool};

use super::{new_id, now_ms};
use crate::media::api::errors::MediaError;

#[derive(Debug, Clone, FromRow)]
pub struct SourceRow {
  pub id: String,
  pub kind: String,
  pub name: String,
  pub root_path: Option<String>,
  pub status: String,
  pub last_scan_at: Option<i64>,
  pub last_scan_error: Option<String>,
  #[allow(dead_code)]
  pub created_at: i64,
  #[allow(dead_code)]
  pub updated_at: i64,
}

const SELECT: &str = "\
SELECT id, kind, name, root_path, status, last_scan_at, last_scan_error, created_at, updated_at \
FROM music_sources";

pub async fn list(pool: &SqlitePool) -> Result<Vec<SourceRow>, MediaError> {
  sqlx::query_as::<_, SourceRow>(&format!("{SELECT} ORDER BY kind, name COLLATE NOCASE, id"))
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取音乐来源失败：{error}")))
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<SourceRow>, MediaError> {
  sqlx::query_as::<_, SourceRow>(&format!("{SELECT} WHERE id = ?"))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取音乐来源失败：{error}")))
}

pub async fn find_by_root(
  pool: &SqlitePool,
  root_path: &str,
) -> Result<Option<SourceRow>, MediaError> {
  sqlx::query_as::<_, SourceRow>(&format!("{SELECT} WHERE root_path = ?"))
    .bind(root_path)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取音乐来源失败：{error}")))
}

pub async fn insert_local(
  pool: &SqlitePool,
  name: &str,
  root_path: &str,
) -> Result<SourceRow, MediaError> {
  if let Some(existing) = find_by_root(pool, root_path).await? {
    return Ok(existing);
  }
  let id = new_id("src");
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_sources \
     (id, kind, name, root_path, status, created_at, updated_at) \
     VALUES (?, 'local', ?, ?, 'active', ?, ?)",
  )
  .bind(&id)
  .bind(name)
  .bind(root_path)
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("添加音乐来源失败：{error}")))?;
  get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::internal("添加音乐来源后读取失败"))
}

pub async fn set_status(
  pool: &SqlitePool,
  id: &str,
  status: &str,
  error: Option<&str>,
) -> Result<(), MediaError> {
  let now = now_ms();
  sqlx::query(
    "UPDATE music_sources SET status = ?, last_scan_error = ?, updated_at = ? WHERE id = ?",
  )
  .bind(status)
  .bind(error)
  .bind(now)
  .bind(id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新音乐来源状态失败：{error}")))?;
  Ok(())
}

pub async fn mark_scanned(pool: &SqlitePool, id: &str) -> Result<(), MediaError> {
  let now = now_ms();
  sqlx::query(
    "UPDATE music_sources \
     SET status = 'active', last_scan_at = ?, last_scan_error = NULL, updated_at = ? \
     WHERE id = ?",
  )
  .bind(now)
  .bind(now)
  .bind(id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新音乐来源扫描时间失败：{error}")))?;
  Ok(())
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<bool, MediaError> {
  let result = sqlx::query("DELETE FROM music_sources WHERE id = ?")
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除音乐来源失败：{error}")))?;
  Ok(result.rows_affected() > 0)
}
