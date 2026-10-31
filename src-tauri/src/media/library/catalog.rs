//! 内置氛围曲目录。
//!
//! 曲目元数据与 Web Audio 预设以 JSON 随二进制内嵌；首次启动 seed 到统一
//! `music_tracks`（`kind='builtin'`），这样队列/歌单/喜欢后续可以引用同一
//! Track ID，不再依赖播放器里的 TS 常量。

use sqlx::SqlitePool;

use crate::media::api::errors::MediaError;
use crate::media::repository::artists::{ensure_artist, normalize_name};
use crate::media::repository::now_ms;

const CATALOG_JSON: &str = include_str!("catalog.json");
const BUILTIN_SOURCE_ID: &str = "src_builtin";

#[derive(Debug, Clone, serde::Deserialize)]
struct CatalogFile {
  version: u32,
  tracks: Vec<CatalogTrack>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTrack {
  id: String,
  title: String,
  artist: String,
  duration_ms: Option<i64>,
  tone: i64,
  ambient: serde_json::Value,
}

fn catalog() -> Result<CatalogFile, MediaError> {
  serde_json::from_str(CATALOG_JSON)
    .map_err(|error| MediaError::internal(format!("内置曲目目录损坏：{error}")))
}

/// 首次/版本变化时幂等 seed；失败只记录日志，不阻断资料库读取。
pub async fn seed(pool: &SqlitePool) -> Result<(), MediaError> {
  let catalog = catalog()?;
  let seeded: Option<String> =
    sqlx::query_scalar("SELECT value FROM app_meta WHERE key = 'catalog_seed_version'")
      .fetch_optional(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取目录 seed 版本失败：{error}")))?;
  if seeded
    .as_deref()
    .and_then(|value| value.parse::<u32>().ok())
    == Some(catalog.version)
  {
    return Ok(());
  }

  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启目录 seed 事务失败：{error}")))?;

  sqlx::query(
    "INSERT INTO music_sources (id, kind, name, status, created_at, updated_at) \
     VALUES (?, 'builtin', 'Lull 精选', 'active', ?, ?) \
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
  )
  .bind(BUILTIN_SOURCE_ID)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("创建内置来源失败：{error}")))?;

  for track in &catalog.tracks {
    let artist_id = ensure_artist(&mut tx, &track.artist, "group").await?;
    let preset = serde_json::to_string(&track.ambient)
      .map_err(|error| MediaError::internal(format!("序列化内置曲预设失败：{error}")))?;
    sqlx::query(
      "INSERT INTO music_tracks \
       (id, kind, title, sort_title, duration_ms, playback_preset_json, status, added_at, updated_at) \
       VALUES (?, 'builtin', ?, ?, ?, ?, 'active', ?, ?) \
       ON CONFLICT(id) DO UPDATE SET \
         title = excluded.title, sort_title = excluded.sort_title, \
         duration_ms = excluded.duration_ms, playback_preset_json = excluded.playback_preset_json, \
         status = 'active', updated_at = excluded.updated_at",
    )
    .bind(&track.id)
    .bind(&track.title)
    .bind(normalize_name(&track.title))
    .bind(track.duration_ms)
    .bind(&preset)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入内置曲失败：{error}")))?;

    sqlx::query("DELETE FROM music_track_artists WHERE track_id = ? AND source = 'import'")
      .bind(&track.id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理内置曲艺术家失败：{error}")))?;
    sqlx::query(
      "INSERT INTO music_track_artists \
       (track_id, artist_id, role, position, source, updated_at) \
       VALUES (?, ?, 'primary', 0, 'import', ?)",
    )
    .bind(&track.id)
    .bind(&artist_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入内置曲艺术家失败：{error}")))?;

    let imported = serde_json::json!({
      "title": track.title,
      "artists": [track.artist],
      "album": serde_json::Value::Null,
      "year": serde_json::Value::Null,
      "trackNumber": serde_json::Value::Null,
      "discNumber": serde_json::Value::Null,
    });
    let imported_text = serde_json::to_string(&imported)
      .map_err(|error| MediaError::internal(format!("序列化内置曲元数据失败：{error}")))?;
    sqlx::query(
      "INSERT INTO music_track_metadata \
       (track_id, imported_json, normalized_json, overrides_json, online_json, updated_at) \
       VALUES (?, ?, ?, '{}', '{}', ?) \
       ON CONFLICT(track_id) DO UPDATE SET \
         imported_json = excluded.imported_json, normalized_json = excluded.normalized_json, \
         updated_at = excluded.updated_at",
    )
    .bind(&track.id)
    .bind(&imported_text)
    .bind(&imported_text)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入内置曲元数据失败：{error}")))?;

    for field in ["title", "artists"] {
      sqlx::query(
        "INSERT OR REPLACE INTO music_field_sources \
         (track_id, field, source, confidence, updated_at) VALUES (?, ?, 'import', NULL, ?)",
      )
      .bind(&track.id)
      .bind(field)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入内置曲字段来源失败：{error}")))?;
    }

    let search_text = normalize_name(&format!("{} {} {}", track.title, track.artist, track.tone));
    sqlx::query(
      "INSERT INTO music_search_text (track_id, search_text) VALUES (?, ?) \
       ON CONFLICT(track_id) DO UPDATE SET search_text = excluded.search_text",
    )
    .bind(&track.id)
    .bind(search_text)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入内置曲搜索文本失败：{error}")))?;
  }

  sqlx::query(
    "INSERT INTO app_meta (key, value) VALUES ('catalog_seed_version', ?) \
     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
  .bind(catalog.version.to_string())
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新目录 seed 版本失败：{error}")))?;

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交目录 seed 事务失败：{error}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn catalog_is_valid_and_ids_are_unique() {
    let catalog = catalog().expect("catalog parses");
    assert_eq!(catalog.version, 1);
    assert_eq!(catalog.tracks.len(), 6);
    let mut ids = std::collections::HashSet::new();
    for track in &catalog.tracks {
      assert!(track.id.starts_with("online-"));
      assert!(ids.insert(track.id.clone()));
      assert!(track.duration_ms.unwrap_or(0) > 0);
    }
  }

  #[test]
  fn seed_is_idempotent_and_writes_builtin_tracks() {
    let path = std::env::temp_dir().join(format!("lull-catalog-test-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      seed(&pool).await.expect("first seed");
      seed(&pool).await.expect("second seed");
      let tracks: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks WHERE kind = 'builtin'")
          .fetch_one(&pool)
          .await
          .expect("count tracks");
      let sources: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM music_sources WHERE kind = 'builtin'")
          .fetch_one(&pool)
          .await
          .expect("count sources");
      let search: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_search_text")
        .fetch_one(&pool)
        .await
        .expect("count search");
      let query = crate::media::api::dto::TrackQuery {
        keyword: Some("Beyond".to_string()),
        ..crate::media::api::dto::TrackQuery::default()
      };
      let (rows, total) = crate::media::repository::tracks::list(&pool, &query)
        .await
        .expect("search builtin");
      assert_eq!(total, 1);
      assert_eq!(rows[0].id, "online-beyond-the-horizon");

      for (keyword, expected_id) in [
        ("beyond", "online-beyond-the-horizon"),
        ("月光下的", "online-moonlit-solitude"),
        ("星海", "online-star-sea"),
      ] {
        let query = crate::media::api::dto::TrackQuery {
          keyword: Some(keyword.to_string()),
          ..crate::media::api::dto::TrackQuery::default()
        };
        let (rows, total) = crate::media::repository::tracks::list(&pool, &query)
          .await
          .expect("search keyword");
        assert_eq!(total, 1, "keyword {keyword}");
        assert_eq!(rows[0].id, expected_id, "keyword {keyword}");
      }

      crate::media::repository::db::close(&pool).await;
      assert_eq!(tracks, 6);
      assert_eq!(sources, 1);
      assert_eq!(search, 6);
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
