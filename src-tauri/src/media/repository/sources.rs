//! 音乐来源（用户授权的物理目录 + 内置曲目来源）。
//!
//! `kind = 'local'` 的行就是对外的 MusicFolder：root_path 唯一、包含显示名、
//! 递归开关、扫描状态与最近扫描时间。内置曲来源仍保留在同一个表里，但
//! `folders` API 只暴露 local 行。

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
  pub recursive: i64,
  #[allow(dead_code)]
  pub created_at: i64,
  #[allow(dead_code)]
  pub updated_at: i64,
}

/// `folders` API 的读取行：只包含 local 目录，并带实时曲目数。
#[derive(Debug, Clone, FromRow)]
pub struct FolderRow {
  pub id: String,
  pub name: String,
  pub root_path: String,
  pub recursive: i64,
  pub status: String,
  pub last_scan_at: Option<i64>,
  pub last_scan_error: Option<String>,
  pub created_at: i64,
  pub updated_at: i64,
  pub track_count: i64,
}

const SELECT: &str = "\
SELECT id, kind, name, root_path, status, last_scan_at, last_scan_error, recursive, \
       created_at, updated_at \
FROM music_sources";

const FOLDER_SELECT: &str = "\
SELECT s.id, s.name, s.root_path, s.recursive, s.status, s.last_scan_at, s.last_scan_error, \
       s.created_at, s.updated_at, \
       (SELECT COUNT(*) FROM music_tracks t WHERE t.folder_id = s.id) AS track_count \
FROM music_sources s \
WHERE s.kind = 'local' AND s.root_path IS NOT NULL";

pub async fn list(pool: &SqlitePool) -> Result<Vec<SourceRow>, MediaError> {
  sqlx::query_as::<_, SourceRow>(&format!("{SELECT} ORDER BY kind, name COLLATE NOCASE, id"))
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取音乐来源失败：{error}")))
}

/// 所有已导入的物理目录（不含内置来源）。
pub async fn list_folders(pool: &SqlitePool) -> Result<Vec<FolderRow>, MediaError> {
  sqlx::query_as::<_, FolderRow>(&format!(
    "{FOLDER_SELECT} ORDER BY s.name COLLATE NOCASE, s.id"
  ))
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取音乐目录失败：{error}")))
}

pub async fn get_folder(pool: &SqlitePool, id: &str) -> Result<Option<FolderRow>, MediaError> {
  sqlx::query_as::<_, FolderRow>(&format!("{FOLDER_SELECT} AND s.id = ?"))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取音乐目录失败：{error}")))
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

/// 目录重叠检查所需的 (folder id, root_path) 列表。
pub async fn list_local_roots(pool: &SqlitePool) -> Result<Vec<(String, String)>, MediaError> {
  sqlx::query_as::<_, (String, String)>(
    "SELECT id, root_path FROM music_sources \
     WHERE kind = 'local' AND root_path IS NOT NULL \
     ORDER BY id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取音乐目录失败：{error}")))
}

pub async fn insert_local(
  pool: &SqlitePool,
  name: &str,
  root_path: &str,
  recursive: bool,
) -> Result<SourceRow, MediaError> {
  if find_by_root(pool, root_path).await?.is_some() {
    return Err(MediaError::new("folders.duplicate", "这个目录已经导入过了"));
  }
  let id = new_id("src");
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_sources \
     (id, kind, name, root_path, status, recursive, created_at, updated_at) \
     VALUES (?, 'local', ?, ?, 'active', ?, ?, ?)",
  )
  .bind(&id)
  .bind(name)
  .bind(root_path)
  .bind(if recursive { 1_i64 } else { 0_i64 })
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("添加音乐目录失败：{error}")))?;
  get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::internal("添加音乐目录后读取失败"))
}

pub async fn rename(pool: &SqlitePool, id: &str, name: &str) -> Result<bool, MediaError> {
  let result = sqlx::query(
    "UPDATE music_sources SET name = ?, updated_at = ? WHERE id = ? AND kind = 'local'",
  )
  .bind(name)
  .bind(now_ms())
  .bind(id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("重命名音乐目录失败：{error}")))?;
  Ok(result.rows_affected() > 0)
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
  .map_err(|error| MediaError::internal(format!("更新音乐目录状态失败：{error}")))?;
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
  .map_err(|error| MediaError::internal(format!("更新音乐目录扫描时间失败：{error}")))?;
  Ok(())
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<bool, MediaError> {
  // 目录级联删除其 Track；磁盘文件不动。扫描中的目录不在这里删除。
  let result = sqlx::query(
    "DELETE FROM music_sources WHERE id = ? AND kind = 'local' AND status <> 'scanning'",
  )
  .bind(id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("删除音乐目录失败：{error}")))?;
  Ok(result.rows_affected() > 0)
}
