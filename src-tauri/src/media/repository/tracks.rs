//! 曲目、艺术家、专辑的读取查询。
//!
//! 写入与扫描在 `media::library` 中完成，这里保持查询可测试、可复用。

use std::path::{Path, PathBuf};

use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};

use super::sources;
use crate::media::api::dto::TrackQuery;
use crate::media::api::errors::MediaError;

#[derive(Debug, Clone, FromRow)]
pub struct TrackRow {
  pub id: String,
  pub title: String,
  pub duration_ms: Option<i64>,
  pub year: Option<i64>,
  pub genre: Option<String>,
  pub kind: String,
  #[allow(dead_code)]
  pub status: String,
  pub added_at: i64,
  pub artist_names: Option<String>,
  pub album_title: Option<String>,
  pub album_id: Option<String>,
  pub track_number: Option<i64>,
  pub disc_number: Option<i64>,
  pub cover_asset_id: Option<String>,
  pub tags_json: String,
  pub available: i64,
  pub favorite: i64,
  pub folder_id: Option<String>,
  pub folder_name: Option<String>,
  pub relative_path: Option<String>,
  pub file_name: Option<String>,
  pub file_size: i64,
  pub file_modified_at: Option<i64>,
  pub format: Option<String>,
  pub bitrate: Option<i64>,
  pub sample_rate: Option<i64>,
}

/// 智能随机选曲需要的轻量特征；不进入公开 DTO。
#[derive(Debug, Clone, FromRow)]
pub struct FeatureRow {
  pub id: String,
  pub genre: Option<String>,
  pub album_id: Option<String>,
  pub artist_ids: Option<String>,
  pub favorite: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct TrackMetadataRow {
  pub imported_json: String,
  pub normalized_json: String,
  pub overrides_json: String,
  pub online_json: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct LyricsRow {
  pub format: String,
  pub source: String,
  pub content: String,
  pub offset_ms: i64,
  pub language: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ArtistRow {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub track_count: i64,
  pub needs_review: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct AlbumRow {
  pub id: String,
  pub title: String,
  pub year: Option<i64>,
  pub kind: String,
  pub album_artist: Option<String>,
  pub track_count: i64,
  pub has_cover: i64,
}

pub(crate) const TRACK_SELECT: &str = "\
SELECT t.id, t.title, t.duration_ms, t.year, t.genre, t.kind, t.status, t.added_at, \
  (SELECT group_concat(a.name, char(31)) \
     FROM music_track_artists ta JOIN music_artists a ON a.id = ta.artist_id \
    WHERE ta.track_id = t.id AND ta.role IN ('primary', 'featured')) AS artist_names, \
  (SELECT al.title FROM music_track_albums taa JOIN music_albums al ON al.id = taa.album_id \
    WHERE taa.track_id = t.id AND taa.is_primary = 1 LIMIT 1) AS album_title, \
  (SELECT al.id FROM music_track_albums taa JOIN music_albums al ON al.id = taa.album_id \
    WHERE taa.track_id = t.id AND taa.is_primary = 1 LIMIT 1) AS album_id, \
  (SELECT taa.track_number FROM music_track_albums taa \
    WHERE taa.track_id = t.id AND taa.is_primary = 1 LIMIT 1) AS track_number, \
  (SELECT taa.disc_number FROM music_track_albums taa \
    WHERE taa.track_id = t.id AND taa.is_primary = 1 LIMIT 1) AS disc_number, \
  (SELECT ma.id FROM music_track_assets mta JOIN music_assets ma ON ma.id = mta.asset_id \
    WHERE mta.track_id = t.id AND mta.role = 'cover' AND mta.is_primary = 1 LIMIT 1) AS cover_asset_id, \
  COALESCE((SELECT json_group_array(json_object('id', tg.id, 'name', tg.name)) \
    FROM music_track_tags mtt JOIN music_tags tg ON tg.id = mtt.tag_id \
    WHERE mtt.track_id = t.id), '[]') AS tags_json, \
  t.folder_id, \
  (SELECT s.name FROM music_sources s WHERE s.id = t.folder_id) AS folder_name, \
  t.relative_path, t.file_name, t.file_size, t.file_modified_at, \
  t.format, t.bitrate, t.sample_rate, \
  CASE WHEN t.kind = 'builtin' THEN 1 \
       WHEN t.status <> 'active' THEN 0 \
       WHEN EXISTS (SELECT 1 FROM music_sources s \
         WHERE s.id = t.folder_id AND s.status IN ('active', 'scanning')) THEN 1 \
       ELSE 0 END AS available, \
  EXISTS (SELECT 1 FROM music_favorites fav WHERE fav.track_id = t.id) AS favorite \
FROM music_tracks t";

fn like_pattern(keyword: &str) -> String {
  let escaped = keyword
    .replace('\\', "\\\\")
    .replace('%', "\\%")
    .replace('_', "\\_");
  format!("%{escaped}%")
}

fn push_filters(builder: &mut QueryBuilder<'_, Sqlite>, query: &TrackQuery) {
  builder.push(" WHERE 1 = 1");

  if let Some(keyword) = query
    .keyword
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    let pattern = like_pattern(keyword);
    builder
      .push(" AND (t.title LIKE ")
      .push_bind(pattern.clone())
      .push(" ESCAPE '\\' OR t.sort_title LIKE ")
      .push_bind(pattern.clone())
      .push(" ESCAPE '\\' OR EXISTS (")
      .push("SELECT 1 FROM music_track_artists ta JOIN music_artists a ON a.id = ta.artist_id ")
      .push("WHERE ta.track_id = t.id AND a.name LIKE ")
      .push_bind(pattern.clone())
      .push(" ESCAPE '\\') OR EXISTS (")
      .push("SELECT 1 FROM music_track_albums taa JOIN music_albums al ON al.id = taa.album_id ")
      .push("WHERE taa.track_id = t.id AND al.title LIKE ")
      .push_bind(pattern.clone())
      .push(" ESCAPE '\\') OR EXISTS (")
      .push("SELECT 1 FROM music_search_text st WHERE st.track_id = t.id AND st.search_text LIKE ")
      .push_bind(pattern)
      .push(" ESCAPE '\\')");

    // trigram FTS5 对 >=3 个字符的查询走索引；1–2 字符仍由上面的 LIKE 覆盖。
    if keyword.chars().count() >= 3 {
      let fts_query = format!("\"{}\"", keyword.replace('"', "\"\""));
      builder
        .push(" OR EXISTS (SELECT 1 FROM music_search_fts f WHERE f.track_id = t.id AND f.search_text MATCH ")
        .push_bind(fts_query)
        .push(")");
    }
    builder.push(")");
  }

  if let Some(folder_id) = query
    .folder_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    builder
      .push(" AND t.folder_id = ")
      .push_bind(folder_id.to_string());
  }

  if let Some(source_ids) = query.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
    builder.push(" AND (");
    for (index, source_id) in source_ids.iter().enumerate() {
      if index > 0 {
        builder.push(" OR ");
      }
      if source_id == "builtin" {
        builder.push("t.kind = 'builtin'");
      } else {
        builder.push("t.folder_id = ").push_bind(source_id.clone());
      }
    }
    builder.push(")");
  }

  if let Some(artist_id) = query
    .artist_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    builder
      .push(
        " AND EXISTS (SELECT 1 FROM music_track_artists ta \
             WHERE ta.track_id = t.id AND ta.artist_id = ",
      )
      .push_bind(artist_id.to_string())
      .push(")");
  }

  if let Some(album_id) = query
    .album_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    builder
      .push(
        " AND EXISTS (SELECT 1 FROM music_track_albums taa \
             WHERE taa.track_id = t.id AND taa.album_id = ",
      )
      .push_bind(album_id.to_string())
      .push(")");
  }

  if let Some(genre) = query
    .genre
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    builder
      .push(" AND t.genre = ")
      .push_bind(genre.to_string())
      .push(" COLLATE NOCASE");
  }

  if let Some(format) = query
    .format
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    builder
      .push(" AND t.format = ")
      .push_bind(format.to_ascii_lowercase())
      .push(" COLLATE NOCASE");
  }

  if let Some(year) = query.year {
    builder.push(" AND t.year = ").push_bind(year);
  }
  if let Some(year_from) = query.year_from {
    builder.push(" AND t.year >= ").push_bind(year_from);
  }
  if let Some(year_to) = query.year_to {
    builder.push(" AND t.year <= ").push_bind(year_to);
  }

  if query.favorite_only.unwrap_or(false) {
    builder.push(" AND EXISTS (SELECT 1 FROM music_favorites fav WHERE fav.track_id = t.id)");
  }

  if let Some(tag_id) = query.tag_id.as_deref().filter(|value| !value.is_empty()) {
    builder
      .push(
        " AND EXISTS (SELECT 1 FROM music_track_tags mtt \
       WHERE mtt.track_id = t.id AND mtt.tag_id = ",
      )
      .push_bind(tag_id.to_string())
      .push(")");
  }

  if !query.include_unavailable.unwrap_or(false) {
    builder.push(
      " AND (t.kind = 'builtin' OR (t.status = 'active' AND EXISTS \
       (SELECT 1 FROM music_sources s \
        WHERE s.id = t.folder_id AND s.status IN ('active', 'scanning'))))",
    );
  }
}

fn sort_clause(query: &TrackQuery) -> (&'static str, &'static str) {
  let column = match query.sort_by.as_deref() {
    Some("addedAt" | "added_at") => "t.added_at",
    Some("year") => "t.year",
    Some("duration" | "durationMs") => "t.duration_ms",
    Some("genre") => "t.genre",
    Some("artist") => "artist_names",
    _ => "t.title",
  };
  let direction = match query.sort_order.as_deref() {
    Some("desc" | "DESC") => "DESC",
    _ => "ASC",
  };
  (column, direction)
}

pub async fn list(
  pool: &SqlitePool,
  query: &TrackQuery,
) -> Result<(Vec<TrackRow>, i64), MediaError> {
  let page = query.page();
  let page_size = query.page_size();
  let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);

  let mut count = QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM music_tracks t");
  push_filters(&mut count, query);
  let total: i64 = count
    .build_query_scalar()
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("统计曲目失败：{error}")))?;

  let (column, direction) = sort_clause(query);
  let mut builder = QueryBuilder::<Sqlite>::new(TRACK_SELECT);
  push_filters(&mut builder, query);
  builder
    .push(" ORDER BY ")
    .push(column)
    .push(" COLLATE NOCASE ")
    .push(direction)
    .push(", t.id LIMIT ")
    .push_bind(i64::from(page_size))
    .push(" OFFSET ")
    .push_bind(offset);

  let rows = builder
    .build_query_as::<TrackRow>()
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取曲目失败：{error}")))?;

  Ok((rows, total))
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<TrackRow>, MediaError> {
  sqlx::query_as::<_, TrackRow>(&format!("{TRACK_SELECT} WHERE t.id = ?"))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取曲目失败：{error}")))
}

/// 批量读取曲目；用于历史/队列等只需要一次查询的场景。
pub async fn list_by_ids(pool: &SqlitePool, ids: &[String]) -> Result<Vec<TrackRow>, MediaError> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let mut builder = QueryBuilder::<Sqlite>::new(TRACK_SELECT);
  builder.push(" WHERE t.id IN (");
  for (index, id) in ids.iter().enumerate() {
    if index > 0 {
      builder.push(", ");
    }
    builder.push_bind(id.clone());
  }
  builder.push(")");
  builder
    .build_query_as::<TrackRow>()
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("批量读取曲目失败：{error}")))
}

/// 批量读取智能随机所需的特征。
///
/// 只返回仍可用的曲目（`status = 'active'`），按 300 个 id 分块，避免
/// SQLite 的变量数量上限；艺术家只取主要/合作角色。
pub async fn features_for(
  pool: &SqlitePool,
  ids: &[String],
) -> Result<Vec<FeatureRow>, MediaError> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let mut rows = Vec::with_capacity(ids.len());
  for chunk in ids.chunks(300) {
    let mut builder = QueryBuilder::<Sqlite>::new(
      "SELECT t.id, t.genre, \
        (SELECT ta.album_id FROM music_track_albums ta \
          WHERE ta.track_id = t.id AND ta.is_primary = 1 LIMIT 1) AS album_id, \
        (SELECT group_concat(ta.artist_id, char(31)) FROM music_track_artists ta \
          WHERE ta.track_id = t.id AND ta.role IN ('primary', 'featured')) AS artist_ids, \
        EXISTS (SELECT 1 FROM music_favorites f WHERE f.track_id = t.id) AS favorite \
       FROM music_tracks t WHERE t.status = 'active' AND t.id IN (",
    );
    for (index, id) in chunk.iter().enumerate() {
      if index > 0 {
        builder.push(", ");
      }
      builder.push_bind(id.clone());
    }
    builder.push(")");
    let batch = builder
      .build_query_as::<FeatureRow>()
      .fetch_all(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取选曲特征失败：{error}")))?;
    rows.extend(batch);
  }
  Ok(rows)
}

/// 返回一个可播放的本地文件路径；内置曲、目录缺失或文件被移动时返回 None。
pub async fn playable_path(
  pool: &SqlitePool,
  track_id: &str,
) -> Result<Option<String>, MediaError> {
  #[derive(sqlx::FromRow)]
  struct PlayableRow {
    file_path: Option<String>,
    root_path: Option<String>,
    relative_path: Option<String>,
  }

  let row = sqlx::query_as::<_, PlayableRow>(
    "SELECT t.file_path, s.root_path, t.relative_path FROM music_tracks t \
     JOIN music_sources s ON s.id = t.folder_id \
     WHERE t.id = ? AND t.kind = 'file' AND t.status = 'active' \
       AND s.status IN ('active', 'scanning')",
  )
  .bind(track_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取曲目文件路径失败：{error}")))?;
  let Some(row) = row else {
    return Ok(None);
  };
  let path = if let Some(file_path) = row.file_path.filter(|value| !value.is_empty()) {
    PathBuf::from(file_path)
  } else {
    let (Some(root_path), Some(relative_path)) = (row.root_path, row.relative_path) else {
      return Ok(None);
    };
    if !safe_relative_path(&relative_path) {
      return Ok(None);
    }
    Path::new(&root_path).join(relative_path)
  };
  if !path.is_file() {
    return Ok(None);
  }
  Ok(path.to_str().map(str::to_string))
}

fn safe_relative_path(relative: &str) -> bool {
  !relative.is_empty()
    && relative
      .split('/')
      .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// M3U 导入：把绝对路径解析回 (folder_id, relative_path) 对应的 Track。
pub async fn find_by_path(pool: &SqlitePool, path: &Path) -> Result<Option<String>, MediaError> {
  let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
  if canonical.to_str().is_none() {
    return Ok(None);
  }
  let absolute = canonical.to_string_lossy().replace('\\', "/");
  let manual = sqlx::query_scalar::<_, String>(
    "SELECT id FROM music_tracks WHERE kind = 'file' AND status = 'active' \
       AND file_path COLLATE NOCASE = ? LIMIT 1",
  )
  .bind(&absolute)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("匹配单曲文件失败：{error}")))?;
  if manual.is_some() {
    return Ok(manual);
  }
  let roots = sources::list_local_roots(pool).await?;
  for (folder_id, root) in roots {
    let root_path = PathBuf::from(&root);
    let Ok(relative) = canonical.strip_prefix(&root_path) else {
      continue;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    if relative.is_empty() {
      continue;
    }
    let track_id = sqlx::query_scalar::<_, String>(
      "SELECT t.id FROM music_tracks t JOIN music_sources s ON s.id = t.folder_id \
       WHERE t.folder_id = ? AND t.kind = 'file' AND t.relative_path = ? COLLATE NOCASE \
         AND t.status = 'active' AND s.status IN ('active', 'scanning') LIMIT 1",
    )
    .bind(&folder_id)
    .bind(&relative)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("匹配 M3U 曲目失败：{error}")))?;
    if track_id.is_some() {
      return Ok(track_id);
    }
  }
  Ok(None)
}

pub async fn metadata(
  pool: &SqlitePool,
  track_id: &str,
) -> Result<Option<TrackMetadataRow>, MediaError> {
  sqlx::query_as::<_, TrackMetadataRow>(
    "SELECT imported_json, normalized_json, overrides_json, online_json \
     FROM music_track_metadata WHERE track_id = ?",
  )
  .bind(track_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取曲目元数据失败：{error}")))
}

pub async fn lyrics(pool: &SqlitePool, track_id: &str) -> Result<Option<LyricsRow>, MediaError> {
  sqlx::query_as::<_, LyricsRow>(
    "SELECT format, source, content, offset_ms, language \
     FROM music_lyrics WHERE track_id = ? \
     ORDER BY is_primary DESC, updated_at DESC LIMIT 1",
  )
  .bind(track_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取歌词失败：{error}")))
}

pub async fn list_genres(pool: &SqlitePool) -> Result<Vec<String>, MediaError> {
  sqlx::query_scalar(
    "SELECT DISTINCT genre FROM music_tracks \
     WHERE genre IS NOT NULL AND trim(genre) <> '' \
     ORDER BY genre COLLATE NOCASE",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取流派失败：{error}")))
}

/// 艺术家列表；`track_count` 只统计默认 `listTracks` 会返回的曲目。
///
/// 艺术家实体不只来自曲目标签：导入时 `albumArtist` 也会创建艺术家（合集、
/// 原声带常见），标签编辑/合并后还会留下没有曲目关系的孤立实体。这些实体在
/// 曲库里没有可展示的曲目，若把它们的 `track_count` 算成非零（或直接列进筛选
/// 下拉），按艺术家筛选就会得到空列表。这里用与 `push_filters` 一致的可见性
/// 规则统计，让「艺术家数」与筛选结果始终对得上。
pub async fn list_artists(pool: &SqlitePool) -> Result<Vec<ArtistRow>, MediaError> {
  sqlx::query_as::<_, ArtistRow>(
    "SELECT a.id, a.name, a.kind, \
       COUNT(DISTINCT visible.track_id) AS track_count, a.needs_review \
     FROM music_artists a \
     LEFT JOIN ( \
       SELECT ta.artist_id, t.id AS track_id \
       FROM music_track_artists ta \
       JOIN music_tracks t ON t.id = ta.track_id \
       WHERE t.kind = 'builtin' OR (t.status = 'active' AND EXISTS ( \
         SELECT 1 FROM music_sources s \
         WHERE s.id = t.folder_id AND s.status IN ('active', 'scanning'))) \
     ) AS visible ON visible.artist_id = a.id \
     WHERE a.merged_into_id IS NULL \
     GROUP BY a.id \
     ORDER BY a.name COLLATE NOCASE, a.id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取艺术家失败：{error}")))
}

pub async fn list_albums(pool: &SqlitePool) -> Result<Vec<AlbumRow>, MediaError> {
  sqlx::query_as::<_, AlbumRow>(
    "SELECT al.id, al.title, al.year, al.kind, ar.name AS album_artist, \
       (SELECT COUNT(*) FROM music_track_albums taa WHERE taa.album_id = al.id) AS track_count, \
       EXISTS (SELECT 1 FROM music_track_albums taa \
         JOIN music_track_assets mta ON mta.track_id = taa.track_id AND mta.role = 'cover' \
         WHERE taa.album_id = al.id AND mta.is_primary = 1) AS has_cover \
     FROM music_albums al \
     LEFT JOIN music_artists ar ON ar.id = al.album_artist_id \
     WHERE al.merged_into_id IS NULL \
     ORDER BY al.title COLLATE NOCASE, al.id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取专辑失败：{error}")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }

  #[test]
  fn features_for_reads_artist_album_genre_and_favorite() {
    let path = std::env::temp_dir().join(format!("lull-features-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      for sql in [
        "INSERT INTO music_tracks (id, kind, title, genre, status, added_at, updated_at) \
         VALUES ('trk_1', 'file', 'A', 'Ambient', 'active', 1, 1)",
        "INSERT INTO music_artists (id, name, created_at, updated_at) \
         VALUES ('art_1', 'Artist', 1, 1)",
        "INSERT INTO music_albums (id, title, created_at, updated_at) \
         VALUES ('alb_1', 'Album', 1, 1)",
        "INSERT INTO music_track_artists \
           (track_id, artist_id, role, position, source, updated_at) \
         VALUES ('trk_1', 'art_1', 'primary', 0, 'import', 1)",
        "INSERT INTO music_track_albums (track_id, album_id, is_primary, source) \
         VALUES ('trk_1', 'alb_1', 1, 'import')",
        "INSERT INTO music_favorites (track_id, created_at) VALUES ('trk_1', 1)",
      ] {
        sqlx::query(sql).execute(&pool).await.expect("seed");
      }

      let rows = features_for(&pool, &["trk_1".to_string()])
        .await
        .expect("features");
      assert_eq!(rows.len(), 1);
      assert_eq!(rows[0].artist_ids.as_deref(), Some("art_1"));
      assert_eq!(rows[0].album_id.as_deref(), Some("alb_1"));
      assert_eq!(rows[0].genre.as_deref(), Some("Ambient"));
      assert_eq!(rows[0].favorite, 1);
      assert!(features_for(&pool, &[]).await.expect("empty").is_empty());
      db::close(&pool).await;
    });
    cleanup(&path);
  }

  #[test]
  fn list_artists_counts_only_visible_tracks() {
    let path = std::env::temp_dir().join(format!("lull-artists-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      for sql in [
        "INSERT INTO music_sources (id, kind, name, status, created_at, updated_at) \
         VALUES ('src_active', 'local', 'Active', 'active', 1, 1)",
        "INSERT INTO music_sources (id, kind, name, status, created_at, updated_at) \
         VALUES ('src_missing', 'local', 'Missing', 'missing', 1, 1)",
        "INSERT INTO music_tracks (id, kind, title, status, folder_id, added_at, updated_at) \
         VALUES ('trk_visible', 'file', 'A', 'active', 'src_active', 1, 1)",
        "INSERT INTO music_tracks (id, kind, title, status, folder_id, added_at, updated_at) \
         VALUES ('trk_hidden', 'file', 'B', 'active', 'src_missing', 1, 1)",
        "INSERT INTO music_artists (id, name, created_at, updated_at) \
         VALUES ('art_visible', 'Visible', 1, 1)",
        "INSERT INTO music_artists (id, name, created_at, updated_at) \
         VALUES ('art_hidden', 'Hidden', 1, 1)",
        "INSERT INTO music_artists (id, name, created_at, updated_at) \
         VALUES ('art_orphan', 'Orphan', 1, 1)",
        "INSERT INTO music_track_artists \
           (track_id, artist_id, role, position, source, updated_at) \
         VALUES ('trk_visible', 'art_visible', 'primary', 0, 'import', 1)",
        "INSERT INTO music_track_artists \
           (track_id, artist_id, role, position, source, updated_at) \
         VALUES ('trk_hidden', 'art_hidden', 'primary', 0, 'import', 1)",
      ] {
        sqlx::query(sql).execute(&pool).await.expect("seed");
      }

      let rows = list_artists(&pool).await.expect("artists");
      let counts = rows
        .iter()
        .map(|row| (row.id.as_str(), row.track_count))
        .collect::<Vec<_>>();
      // 来源 missing 的曲目不参与默认列表，因此也不能给艺术家凑数；
      // 只作为专辑艺术家存在的孤立实体固定是 0。
      assert_eq!(
        counts,
        vec![("art_hidden", 0), ("art_orphan", 0), ("art_visible", 1)]
      );
      db::close(&pool).await;
    });
    cleanup(&path);
  }
}
