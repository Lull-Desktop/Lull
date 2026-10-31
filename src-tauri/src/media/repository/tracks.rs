//! 曲目、艺术家、专辑的读取查询。
//!
//! 写入与扫描在 `media::library` 中完成，这里保持查询可测试、可复用。

use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};

use crate::media::api::dto::TrackQuery;
use crate::media::api::errors::MediaError;

#[derive(Debug, Clone, FromRow)]
pub struct TrackRow {
  pub id: String,
  pub title: String,
  pub duration_ms: Option<i64>,
  pub year: Option<i64>,
  pub kind: String,
  #[allow(dead_code)]
  pub status: String,
  pub artist_names: Option<String>,
  pub album_title: Option<String>,
  pub album_id: Option<String>,
  pub track_number: Option<i64>,
  pub disc_number: Option<i64>,
  pub cover_asset_id: Option<String>,
  pub available: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct TrackFileRow {
  pub format: String,
  pub size_bytes: i64,
  pub bitrate: Option<i64>,
  pub sample_rate: Option<i64>,
  pub available: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct TrackMetadataRow {
  pub imported_json: String,
  pub normalized_json: String,
  pub overrides_json: String,
  pub online_json: String,
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

const TRACK_SELECT: &str = "\
SELECT t.id, t.title, t.duration_ms, t.year, t.kind, t.status, \
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
  CASE WHEN t.kind = 'builtin' THEN 1 \
       WHEN EXISTS (SELECT 1 FROM music_files f WHERE f.track_id = t.id AND f.available = 1) THEN 1 \
       ELSE 0 END AS available \
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

  if let Some(source_ids) = query.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
    builder.push(" AND (");
    for (index, source_id) in source_ids.iter().enumerate() {
      if index > 0 {
        builder.push(" OR ");
      }
      if source_id == "builtin" {
        builder.push("t.kind = 'builtin'");
      } else {
        builder
          .push("EXISTS (SELECT 1 FROM music_files f WHERE f.track_id = t.id AND f.source_id = ")
          .push_bind(source_id.clone())
          .push(")");
      }
    }
    builder.push(")");
  }

  if !query.include_unavailable.unwrap_or(false) {
    builder.push(
      " AND (t.kind = 'builtin' OR EXISTS \
       (SELECT 1 FROM music_files f WHERE f.track_id = t.id AND f.available = 1))",
    );
  }
}

fn sort_clause(query: &TrackQuery) -> (&'static str, &'static str) {
  let column = match query.sort_by.as_deref() {
    Some("addedAt" | "added_at") => "t.added_at",
    Some("year") => "t.year",
    Some("duration" | "durationMs") => "t.duration_ms",
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

pub async fn files(pool: &SqlitePool, track_id: &str) -> Result<Vec<TrackFileRow>, MediaError> {
  sqlx::query_as::<_, TrackFileRow>(
    "SELECT format, size_bytes, bitrate, sample_rate, available \
     FROM music_files WHERE track_id = ? ORDER BY available DESC, format",
  )
  .bind(track_id)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取曲目文件失败：{error}")))
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

pub async fn list_artists(pool: &SqlitePool) -> Result<Vec<ArtistRow>, MediaError> {
  sqlx::query_as::<_, ArtistRow>(
    "SELECT a.id, a.name, a.kind, \
       COUNT(DISTINCT ta.track_id) AS track_count, a.needs_review \
     FROM music_artists a \
     LEFT JOIN music_track_artists ta ON ta.artist_id = a.id \
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
