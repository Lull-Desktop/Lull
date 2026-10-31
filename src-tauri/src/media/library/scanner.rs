//! 本地音乐目录扫描。
//!
//! 第一版是同步、可取消性待补的增量扫描：按 source + 规范化路径识别文件，
//! 每个文件一个小事务，写入 Track/艺术家/专辑/元数据/搜索文本；扫描结束后
//! 把本次未看到的文件标记不可用。文件本身只读，不写标签、不移动、不删除。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use walkdir::WalkDir;

use super::metadata::{self, ParsedMetadata};
use crate::media::api::errors::MediaError;
use crate::media::repository::artists::{ensure_album, ensure_artist, normalize_name};
use crate::media::repository::sources::SourceRow;
use crate::media::repository::{new_id, now_ms};

pub const AUDIO_EXTENSIONS: &[&str] = &[
  "mp3", "flac", "m4a", "aac", "wav", "ogg", "oga", "opus", "aiff", "aif",
];

#[derive(Debug, Default, Clone)]
pub struct ScanOutcome {
  pub added: i64,
  pub updated: i64,
  pub removed: i64,
  pub errors: Vec<String>,
}

#[derive(Debug)]
enum UpsertResult {
  Added,
  Updated,
}

fn is_audio(path: &Path) -> bool {
  path
    .extension()
    .and_then(std::ffi::OsStr::to_str)
    .map(str::to_ascii_lowercase)
    .is_some_and(|extension| AUDIO_EXTENSIONS.contains(&extension.as_str()))
}

fn file_id(source_id: &str, path_key: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(source_id.as_bytes());
  hasher.update([0]);
  hasher.update(path_key.as_bytes());
  let digest = hasher.finalize();
  let hex = format!("{digest:x}");
  format!("file_{}", &hex[..16])
}

fn path_string(path: &Path) -> Result<String, MediaError> {
  path
    .to_str()
    .map(str::to_string)
    .ok_or_else(|| MediaError::unavailable("文件路径不是合法 UTF-8"))
}

fn collection_error(path: &Path) -> String {
  format!(
    "解析失败：{}",
    path
      .file_name()
      .and_then(|name| name.to_str())
      .unwrap_or("未知文件")
  )
}

/// 扫描一个本地 source。调用方负责把 source 标记为 scanning/active。
pub async fn scan_source(
  pool: &SqlitePool,
  source: &SourceRow,
  run_id: &str,
) -> Result<ScanOutcome, MediaError> {
  let root = source
    .root_path
    .as_deref()
    .ok_or_else(|| MediaError::invalid("该来源没有本地目录"))?;
  let root = PathBuf::from(root);
  let root = dunce::canonicalize(&root)
    .map_err(|error| MediaError::unavailable(format!("音乐目录不可用：{error}")))?;
  if !root.is_dir() {
    return Err(MediaError::unavailable("音乐目录不存在"));
  }

  let mut outcome = ScanOutcome::default();
  let mut seen = 0_i64;

  for entry in WalkDir::new(&root).follow_links(false) {
    let entry = match entry {
      Ok(entry) => entry,
      Err(error) => {
        if outcome.errors.len() < 100 {
          outcome.errors.push(format!("遍历失败：{error}"));
        }
        continue;
      }
    };
    if !entry.file_type().is_file() || !is_audio(entry.path()) {
      continue;
    }
    seen += 1;
    match upsert_file(pool, source, run_id, entry.path(), &root).await {
      Ok(UpsertResult::Added) => outcome.added += 1,
      Ok(UpsertResult::Updated) => outcome.updated += 1,
      Err(error) => {
        if outcome.errors.len() < 100 {
          outcome
            .errors
            .push(format!("{}（{}）", collection_error(entry.path()), error));
        }
      }
    }
  }

  let now = now_ms();
  let removed = sqlx::query(
    "UPDATE music_files SET available = 0, updated_at = ? \
     WHERE source_id = ? AND COALESCE(last_seen_scan_id, '') <> ?",
  )
  .bind(now)
  .bind(&source.id)
  .bind(run_id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("标记缺失文件失败：{error}")))?;
  outcome.removed = i64::try_from(removed.rows_affected()).unwrap_or(i64::MAX);

  sqlx::query(
    "UPDATE music_tracks SET status = 'missing' \
     WHERE kind = 'file' AND NOT EXISTS \
       (SELECT 1 FROM music_files f WHERE f.track_id = music_tracks.id AND f.available = 1)",
  )
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新曲目状态失败：{error}")))?;

  sqlx::query(
    "UPDATE music_tracks SET status = 'active' \
     WHERE kind = 'file' AND EXISTS \
       (SELECT 1 FROM music_files f WHERE f.track_id = music_tracks.id AND f.available = 1)",
  )
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新曲目状态失败：{error}")))?;

  if seen == 0 && outcome.errors.is_empty() {
    outcome
      .errors
      .push("目录中没有找到可识别的音频文件".to_string());
  }

  Ok(outcome)
}

async fn upsert_file(
  pool: &SqlitePool,
  source: &SourceRow,
  run_id: &str,
  path: &Path,
  root: &Path,
) -> Result<UpsertResult, MediaError> {
  let canonical = dunce::canonicalize(path)
    .map_err(|error| MediaError::unavailable(format!("文件不可用：{error}")))?;
  let path_text = path_string(&canonical)?;
  let path_key = path_text.replace('\\', "/").to_lowercase();
  let relative = canonical
    .strip_prefix(root)
    .map_err(|_| MediaError::internal("文件不在音乐来源目录内"))?
    .to_string_lossy()
    .replace('\\', "/");
  let format = canonical
    .extension()
    .and_then(std::ffi::OsStr::to_str)
    .map(str::to_ascii_lowercase)
    .unwrap_or_else(|| "unknown".to_string());
  let file_meta = std::fs::metadata(&canonical)
    .map_err(|error| MediaError::unavailable(format!("读取文件信息失败：{error}")))?;
  let size_bytes = i64::try_from(file_meta.len()).unwrap_or(i64::MAX);
  let mtime_ms = file_meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .and_then(|duration| i64::try_from(duration.as_millis()).ok());

  let parsed = metadata::parse_file(&canonical).unwrap_or_else(|error| {
    let (title, artists) = metadata::parse_filename(&canonical);
    ParsedMetadata {
      title,
      artists,
      raw: serde_json::json!({ "parseError": error }),
      ..ParsedMetadata::default()
    }
  });

  let title = parsed
    .title
    .clone()
    .unwrap_or_else(|| "未命名音频".to_string());
  let artists = if parsed.artists.is_empty() {
    vec!["未知艺术家".to_string()]
  } else {
    parsed.artists.clone()
  };
  let album = parsed.album.clone();
  let album_artist_name = parsed
    .album_artist
    .clone()
    .or_else(|| artists.first().cloned());

  let id = file_id(&source.id, &path_key);
  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启扫描事务失败：{error}")))?;

  let existing_track: Option<String> =
    sqlx::query_scalar("SELECT track_id FROM music_files WHERE source_id = ? AND path_key = ?")
      .bind(&source.id)
      .bind(&path_key)
      .fetch_optional(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("查询已有文件失败：{error}")))?
      .flatten();

  let result = if existing_track.is_some() {
    UpsertResult::Updated
  } else {
    UpsertResult::Added
  };

  let track_id = match existing_track {
    Some(track_id) => {
      sqlx::query(
        "UPDATE music_tracks SET title = ?, duration_ms = ?, year = ?, status = 'active', \
         updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .bind(&title)
      .bind(parsed.duration_ms)
      .bind(parsed.year)
      .bind(now)
      .bind(&track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("更新曲目失败：{error}")))?;
      track_id
    }
    None => {
      let track_id = new_id("trk");
      sqlx::query(
        "INSERT INTO music_tracks \
         (id, kind, title, sort_title, duration_ms, year, status, added_at, updated_at) \
         VALUES (?, 'file', ?, ?, ?, ?, 'active', ?, ?)",
      )
      .bind(&track_id)
      .bind(&title)
      .bind(normalize_name(&title))
      .bind(parsed.duration_ms)
      .bind(parsed.year)
      .bind(now)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("创建曲目失败：{error}")))?;
      track_id
    }
  };

  sqlx::query(
    "INSERT INTO music_files \
     (id, source_id, track_id, path, path_key, relative_path, format, size_bytes, mtime_ms, \
      raw_tags_json, duration_ms, bitrate, sample_rate, channels, available, last_seen_scan_id, \
      added_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) \
     ON CONFLICT(source_id, path_key) DO UPDATE SET \
       track_id = excluded.track_id, path = excluded.path, relative_path = excluded.relative_path, \
       format = excluded.format, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, \
       raw_tags_json = excluded.raw_tags_json, duration_ms = excluded.duration_ms, \
       bitrate = excluded.bitrate, sample_rate = excluded.sample_rate, channels = excluded.channels, \
       available = 1, last_seen_scan_id = excluded.last_seen_scan_id, updated_at = excluded.updated_at",
  )
  .bind(&id)
  .bind(&source.id)
  .bind(&track_id)
  .bind(&path_text)
  .bind(&path_key)
  .bind(&relative)
  .bind(&format)
  .bind(size_bytes)
  .bind(mtime_ms)
  .bind(serde_json::to_string(&parsed.raw).unwrap_or_else(|_| "{}".to_string()))
  .bind(parsed.duration_ms)
  .bind(parsed.bitrate)
  .bind(parsed.sample_rate)
  .bind(parsed.channels)
  .bind(run_id)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入文件记录失败：{error}")))?;

  let imported = serde_json::json!({
    "title": title,
    "artists": artists,
    "album": album,
    "albumArtist": album_artist_name,
    "year": parsed.year,
    "trackNumber": parsed.track_number,
    "discNumber": parsed.disc_number,
  });
  sqlx::query(
    "INSERT INTO music_track_metadata \
     (track_id, imported_json, normalized_json, overrides_json, online_json, updated_at) \
     VALUES (?, ?, ?, '{}', '{}', ?) \
     ON CONFLICT(track_id) DO UPDATE SET \
       imported_json = excluded.imported_json, normalized_json = excluded.normalized_json, \
       updated_at = excluded.updated_at",
  )
  .bind(&track_id)
  .bind(serde_json::to_string(&imported).unwrap_or_else(|_| "{}".to_string()))
  .bind(serde_json::to_string(&imported).unwrap_or_else(|_| "{}".to_string()))
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入曲目元数据失败：{error}")))?;

  sqlx::query("DELETE FROM music_track_artists WHERE track_id = ? AND source = 'import'")
    .bind(&track_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理艺术家关系失败：{error}")))?;
  let mut artist_ids = Vec::new();
  for (position, artist) in artists.iter().enumerate() {
    let artist_id = ensure_artist(&mut tx, artist, "unknown").await?;
    sqlx::query(
      "INSERT OR REPLACE INTO music_track_artists \
       (track_id, artist_id, role, position, source, updated_at) \
       VALUES (?, ?, 'primary', ?, 'import', ?)",
    )
    .bind(&track_id)
    .bind(&artist_id)
    .bind(i64::try_from(position).unwrap_or(i64::MAX))
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入艺术家关系失败：{error}")))?;
    artist_ids.push(artist_id);
  }

  let album_artist_id = match album_artist_name.as_deref() {
    Some(name) if !name.trim().is_empty() => Some(ensure_artist(&mut tx, name, "unknown").await?),
    _ => artist_ids.first().cloned(),
  };
  let album_id = match album.as_deref() {
    Some(title) => ensure_album(&mut tx, title, album_artist_id.as_deref(), parsed.year).await?,
    None => None,
  };

  sqlx::query("DELETE FROM music_track_albums WHERE track_id = ? AND source = 'import'")
    .bind(&track_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理专辑关系失败：{error}")))?;
  if let Some(album_id) = album_id {
    sqlx::query(
      "INSERT OR REPLACE INTO music_track_albums \
       (track_id, album_id, disc_number, track_number, is_primary, source) \
       VALUES (?, ?, ?, ?, 1, 'import')",
    )
    .bind(&track_id)
    .bind(&album_id)
    .bind(parsed.disc_number)
    .bind(parsed.track_number)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入专辑关系失败：{error}")))?;
  }

  for field in ["title", "artists", "album", "year"] {
    sqlx::query(
      "INSERT OR REPLACE INTO music_field_sources \
       (track_id, field, source, confidence, updated_at) VALUES (?, ?, 'import', NULL, ?)",
    )
    .bind(&track_id)
    .bind(field)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入字段来源失败：{error}")))?;
  }

  let search_text = normalize_name(&format!(
    "{} {} {} {}",
    title,
    artists.join(" "),
    album.clone().unwrap_or_default(),
    relative
  ));
  sqlx::query(
    "INSERT INTO music_search_text (track_id, search_text) VALUES (?, ?) \
     ON CONFLICT(track_id) DO UPDATE SET search_text = excluded.search_text",
  )
  .bind(&track_id)
  .bind(search_text)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新搜索文本失败：{error}")))?;

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交扫描事务失败：{error}")))?;

  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write_silence_wav(path: &Path) {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&36_u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&44_100_u32.to_le_bytes());
    bytes.extend_from_slice(&88_200_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    std::fs::write(path, bytes).expect("write wav");
  }

  #[test]
  fn audio_extensions_are_case_insensitive() {
    assert!(is_audio(Path::new("a.MP3")));
    assert!(is_audio(Path::new("a.flac")));
    assert!(!is_audio(Path::new("a.txt")));
  }

  #[test]
  fn file_id_is_stable_and_source_scoped() {
    let one = file_id("src_a", r"c:/music/a.mp3");
    let two = file_id("src_a", r"c:/music/a.mp3");
    let three = file_id("src_b", r"c:/music/a.mp3");
    assert_eq!(one, two);
    assert_ne!(one, three);
    assert!(one.starts_with("file_"));
  }

  #[test]
  fn scan_is_incremental_and_persists_tracks() {
    let root = std::env::temp_dir().join(format!("lull-scan-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    write_silence_wav(&root.join("Artist - Tree.wav"));
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      let first = crate::media::library::scan_path(&pool, &root)
        .await
        .expect("first scan");
      assert_eq!(first.added, 1);
      assert_eq!(first.updated, 0);

      let second = crate::media::library::scan_path(&pool, &root)
        .await
        .expect("second scan");
      assert_eq!(second.added, 0);
      assert_eq!(second.updated, 1);

      let tracks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks")
        .fetch_one(&pool)
        .await
        .expect("count tracks");
      let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_files")
        .fetch_one(&pool)
        .await
        .expect("count files");
      let search: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_search_text")
        .fetch_one(&pool)
        .await
        .expect("count search rows");
      crate::media::repository::db::close(&pool).await;
      assert_eq!(tracks, 1);
      assert_eq!(files, 1);
      assert_eq!(search, 1);
    });

    let _ = std::fs::remove_dir_all(&root);
  }
}
