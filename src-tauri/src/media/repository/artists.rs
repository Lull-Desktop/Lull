//! 艺术家 / 专辑实体的解析与创建。
//!
//! 名称匹配使用 NFKC + 小写 + 空白折叠后的 alias，而不是直接比较展示名；
//! 合并后的实体通过 `merged_into_id` 保留，查询默认只返回未合并实体。

use sqlx::SqliteConnection;
use unicode_normalization::UnicodeNormalization;

use super::{new_id, now_ms};
use crate::media::api::errors::MediaError;

/// 名称规范化：NFKC、去首尾空白、合并连续空白、转小写。
#[must_use]
pub fn normalize_name(value: &str) -> String {
  value
    .nfkc()
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

/// 保守拆分多艺术家：只认分号/斜杠（与 Folia 的规则一致），不按逗号或
/// “feat.” 粗暴拆，避免把艺名拆坏。
#[must_use]
pub fn split_artists(value: &str) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  value
    .split([';', '；', '/', '／'])
    .map(str::trim)
    .filter(|part| !part.is_empty())
    .filter(|part| seen.insert(normalize_name(part)))
    .map(str::to_string)
    .collect()
}

pub async fn ensure_artist(
  conn: &mut SqliteConnection,
  name: &str,
  kind: &str,
) -> Result<String, MediaError> {
  let normalized = normalize_name(name);
  if normalized.is_empty() {
    return Err(MediaError::invalid("艺术家名称不能为空"));
  }
  if let Some(id) = find_artist(&mut *conn, &normalized).await? {
    return Ok(id);
  }

  let id = new_id("art");
  let now = now_ms();
  let kind = match kind {
    "person" | "group" | "various" => kind,
    _ => "unknown",
  };
  sqlx::query(
    "INSERT INTO music_artists \
     (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(name.trim())
  .bind(kind)
  .bind(now)
  .bind(now)
  .execute(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("创建艺术家失败：{error}")))?;

  sqlx::query(
    "INSERT OR IGNORE INTO music_artist_aliases \
     (artist_id, alias, normalized_alias, source) VALUES (?, ?, ?, 'import')",
  )
  .bind(&id)
  .bind(name.trim())
  .bind(&normalized)
  .execute(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("创建艺术家别名失败：{error}")))?;

  Ok(id)
}

pub async fn find_artist(
  conn: &mut SqliteConnection,
  normalized: &str,
) -> Result<Option<String>, MediaError> {
  sqlx::query_scalar::<_, String>(
    "SELECT a.id FROM music_artists a \
     JOIN music_artist_aliases aa ON aa.artist_id = a.id \
     WHERE aa.normalized_alias = ? AND a.merged_into_id IS NULL \
     ORDER BY a.id LIMIT 1",
  )
  .bind(normalized)
  .fetch_optional(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("查询艺术家失败：{error}")))
}

pub async fn ensure_album(
  conn: &mut SqliteConnection,
  title: &str,
  album_artist_id: Option<&str>,
  year: Option<i64>,
) -> Result<Option<String>, MediaError> {
  let normalized = normalize_name(title);
  if normalized.is_empty() {
    return Ok(None);
  }
  if let Some(id) = find_album(&mut *conn, &normalized, album_artist_id).await? {
    return Ok(Some(id));
  }

  let id = new_id("alb");
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_albums \
     (id, title, year, album_artist_id, kind, created_at, updated_at) \
     VALUES (?, ?, ?, ?, 'album', ?, ?)",
  )
  .bind(&id)
  .bind(title.trim())
  .bind(year)
  .bind(album_artist_id)
  .bind(now)
  .bind(now)
  .execute(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("创建专辑失败：{error}")))?;

  sqlx::query(
    "INSERT OR IGNORE INTO music_album_aliases \
     (album_id, alias, normalized_alias, source) VALUES (?, ?, ?, 'import')",
  )
  .bind(&id)
  .bind(title.trim())
  .bind(&normalized)
  .execute(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("创建专辑别名失败：{error}")))?;

  Ok(Some(id))
}

pub async fn find_album(
  conn: &mut SqliteConnection,
  normalized: &str,
  album_artist_id: Option<&str>,
) -> Result<Option<String>, MediaError> {
  sqlx::query_scalar::<_, String>(
    "SELECT al.id FROM music_albums al \
     JOIN music_album_aliases aa ON aa.album_id = al.id \
     WHERE aa.normalized_alias = ? \
       AND (al.album_artist_id IS ? OR ? IS NULL) \
       AND al.merged_into_id IS NULL \
     ORDER BY al.id LIMIT 1",
  )
  .bind(normalized)
  .bind(album_artist_id)
  .bind(album_artist_id)
  .fetch_optional(&mut *conn)
  .await
  .map_err(|error| MediaError::internal(format!("查询专辑失败：{error}")))
}
