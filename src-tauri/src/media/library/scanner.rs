//! 本地音乐目录扫描。
//!
//! 目录就是 `music_sources(kind='local')`：扫描按 `folder_id + relative_path`
//! 识别 Track，文件元数据直接写在 `music_tracks` 上，不再维护 `music_files`。
//! 文件本身只读，不写标签、不移动、不删除。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;
use walkdir::WalkDir;

use super::assets::{self, CoverSource};
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
  pub skipped: i64,
  pub removed: i64,
  pub errors: Vec<String>,
  pub cancelled: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ScanProgress {
  pub processed: u64,
  pub total: u64,
  pub added: i64,
  pub updated: i64,
  pub skipped: i64,
}

/// 扫描所需的宿主上下文；测试可传空的取消/进度。
pub struct ScanControl<'a> {
  pub assets_dir: &'a Path,
  pub cancel: Option<&'a AtomicBool>,
  pub on_progress: Option<&'a (dyn Fn(ScanProgress) + Send + Sync)>,
}

#[derive(Debug)]
enum UpsertResult {
  Added,
  Updated,
}

#[derive(Debug)]
struct ExistingTrack {
  id: String,
  status: String,
  file_size: i64,
  file_modified_at: Option<i64>,
  format: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingTrackRow {
  id: String,
  relative_path: Option<String>,
  status: String,
  file_size: i64,
  file_modified_at: Option<i64>,
  format: Option<String>,
}

#[derive(Debug)]
struct FileEntry {
  path: PathBuf,
  relative: String,
  file_name: String,
  format: String,
  size: i64,
  mtime: Option<i64>,
  /// 单曲导入使用绝对路径；目录扫描的曲目为 None。
  file_path: Option<String>,
}

fn is_audio(path: &Path) -> bool {
  path
    .extension()
    .and_then(std::ffi::OsStr::to_str)
    .map(str::to_ascii_lowercase)
    .is_some_and(|extension| AUDIO_EXTENSIONS.contains(&extension.as_str()))
}

/// 与旧 `path_key` 对齐：统一分隔符并小写，用于同目录内匹配。
fn normalize_relative(relative: &str) -> String {
  relative.replace('\\', "/").to_lowercase()
}

fn push_error(outcome: &mut ScanOutcome, message: String) {
  if outcome.errors.len() < 100 {
    outcome.errors.push(message);
  }
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

fn build_entry(canonical: PathBuf, relative: String) -> Result<FileEntry, MediaError> {
  let file_meta = std::fs::metadata(&canonical)
    .map_err(|error| MediaError::unavailable(format!("读取文件信息失败：{error}")))?;
  let size = i64::try_from(file_meta.len()).unwrap_or(i64::MAX);
  let mtime = file_meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .and_then(|duration| i64::try_from(duration.as_millis()).ok());
  let format = canonical
    .extension()
    .and_then(std::ffi::OsStr::to_str)
    .map(str::to_ascii_lowercase)
    .unwrap_or_else(|| "unknown".to_string());
  let file_name = canonical
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or(&relative)
    .to_string();
  Ok(FileEntry {
    path: canonical,
    relative,
    file_name,
    format,
    size,
    mtime,
    file_path: None,
  })
}

/// 单曲导入的结果；与全量扫描的 `ScanOutcome` 区分开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
  Added,
  Updated,
  Skipped,
}

/// 扫描一个本地目录。调用方负责把目录标记为 scanning/active。
pub async fn scan_source(
  pool: &SqlitePool,
  source: &SourceRow,
  _run_id: &str,
  control: &ScanControl<'_>,
) -> Result<ScanOutcome, MediaError> {
  let root = source
    .root_path
    .as_deref()
    .ok_or_else(|| MediaError::invalid("该目录没有本地路径"))?;
  let root = PathBuf::from(root);
  let root = dunce::canonicalize(&root)
    .map_err(|error| MediaError::new("folders.unavailable", format!("音乐目录不可用：{error}")))?;
  if !root.is_dir() {
    return Err(MediaError::new("folders.unavailable", "音乐目录不存在"));
  }
  let assets_dir = control.assets_dir;

  let mut outcome = ScanOutcome::default();
  let mut files = Vec::new();
  let mut discovery_error = false;
  let mut walker = WalkDir::new(&root).follow_links(false);
  if source.recursive == 0 {
    walker = walker.max_depth(1);
  }
  for entry in walker {
    if control
      .cancel
      .is_some_and(|cancel| cancel.load(Ordering::SeqCst))
    {
      outcome.cancelled = true;
      return Ok(outcome);
    }
    let entry = match entry {
      Ok(entry) => entry,
      Err(error) => {
        discovery_error = true;
        push_error(&mut outcome, format!("遍历失败：{error}"));
        continue;
      }
    };
    if entry.file_type().is_file() && is_audio(entry.path()) {
      files.push(entry.into_path());
    }
  }

  let existing_rows = sqlx::query_as::<_, ExistingTrackRow>(
    "SELECT id, relative_path, status, file_size, file_modified_at, format \
     FROM music_tracks WHERE folder_id = ? AND kind = 'file'",
  )
  .bind(&source.id)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取已有曲目失败：{error}")))?;
  let mut existing: HashMap<String, ExistingTrack> = HashMap::new();
  for row in existing_rows {
    let Some(relative) = row.relative_path else {
      continue;
    };
    existing.insert(
      normalize_relative(&relative),
      ExistingTrack {
        id: row.id,
        status: row.status,
        file_size: row.file_size,
        file_modified_at: row.file_modified_at,
        format: row.format,
      },
    );
  }

  let total = u64::try_from(files.len()).unwrap_or(u64::MAX);
  let mut seen: HashSet<String> = HashSet::new();
  for (index, path) in files.iter().enumerate() {
    if control
      .cancel
      .is_some_and(|cancel| cancel.load(Ordering::SeqCst))
    {
      outcome.cancelled = true;
      break;
    }
    let canonical = match dunce::canonicalize(path) {
      Ok(canonical) => canonical,
      Err(error) => {
        discovery_error = true;
        push_error(
          &mut outcome,
          format!("{}（文件不可用：{error}）", collection_error(path)),
        );
        continue;
      }
    };
    let relative = match canonical.strip_prefix(&root) {
      Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
      Err(_) => {
        discovery_error = true;
        push_error(
          &mut outcome,
          format!("{}（文件不在音乐目录内）", collection_error(path)),
        );
        continue;
      }
    };
    let key = normalize_relative(&relative);
    // 先记 seen：即使后续元数据读取失败，也不要把它当成“已删除”。
    seen.insert(key.clone());
    let entry = match build_entry(canonical, relative) {
      Ok(entry) => entry,
      Err(error) => {
        push_error(
          &mut outcome,
          format!("{}（{error}）", collection_error(path)),
        );
        continue;
      }
    };

    let existing_track = existing.get(&key);
    let unchanged = existing_track.is_some_and(|track| {
      track.file_size == entry.size
        && track.file_modified_at == entry.mtime
        && track.format.as_deref() == Some(entry.format.as_str())
    });

    if unchanged {
      outcome.skipped += 1;
      // 旧库迁移后可能有文件已恢复但 Track 仍是 missing；未变化也要恢复可用。
      if let Some(track) = existing_track.filter(|track| track.status != "active") {
        sqlx::query("UPDATE music_tracks SET status = 'active' WHERE id = ?")
          .bind(&track.id)
          .execute(pool)
          .await
          .map_err(|error| MediaError::internal(format!("恢复曲目状态失败：{error}")))?;
      }
    } else {
      let existing_id = existing_track.map(|track| track.id.as_str());
      match upsert_track(pool, source, &entry, existing_id, assets_dir).await {
        Ok(UpsertResult::Added) => outcome.added += 1,
        Ok(UpsertResult::Updated) => outcome.updated += 1,
        Err(error) => push_error(
          &mut outcome,
          format!("{}（{error}）", collection_error(path)),
        ),
      }
    }

    if let Some(progress) = control.on_progress {
      progress(ScanProgress {
        processed: u64::try_from(index + 1).unwrap_or(u64::MAX),
        total,
        added: outcome.added,
        updated: outcome.updated,
        skipped: outcome.skipped,
      });
    }
  }

  if outcome.cancelled {
    return Ok(outcome);
  }

  // 遍历有错误时宁可保留旧记录，也不要把不可读子目录里的曲目误删。
  if !discovery_error {
    let stale: Vec<String> = existing
      .iter()
      .filter(|(key, _)| !seen.contains(*key))
      .map(|(_, track)| track.id.clone())
      .collect();
    if !stale.is_empty() {
      let mut tx = pool
        .begin()
        .await
        .map_err(|error| MediaError::internal(format!("开启清理事务失败：{error}")))?;
      let mut removed = 0_i64;
      for chunk in stale.chunks(200) {
        let mut builder = sqlx::QueryBuilder::new("DELETE FROM music_tracks WHERE id IN (");
        {
          let mut separated = builder.separated(", ");
          for id in chunk {
            separated.push_bind(id.clone());
          }
        }
        builder.push(")");
        let result = builder
          .build()
          .execute(&mut *tx)
          .await
          .map_err(|error| MediaError::internal(format!("移除缺失曲目失败：{error}")))?;
        removed += i64::try_from(result.rows_affected()).unwrap_or(i64::MAX);
      }
      tx.commit()
        .await
        .map_err(|error| MediaError::internal(format!("提交清理事务失败：{error}")))?;
      outcome.removed = removed;
    }
  }

  if total == 0 && outcome.errors.is_empty() {
    outcome
      .errors
      .push("目录中没有找到可识别的音频文件".to_string());
  }

  Ok(outcome)
}

async fn upsert_track(
  pool: &SqlitePool,
  source: &SourceRow,
  file: &FileEntry,
  existing_track: Option<&str>,
  assets_dir: &Path,
) -> Result<UpsertResult, MediaError> {
  let parsed = metadata::parse_file(&file.path).unwrap_or_else(|error| {
    let (title, artists) = metadata::parse_filename(&file.path);
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

  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启扫描事务失败：{error}")))?;

  let protected: Vec<String> = match existing_track {
    Some(track_id) => sqlx::query_scalar(
      "SELECT field FROM music_field_sources \
       WHERE track_id = ? AND source IN ('manual', 'split', 'online')",
    )
    .bind(track_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("读取字段保护失败：{error}")))?,
    None => Vec::new(),
  };
  let protected_title = protected.iter().any(|field| field == "title");
  let protected_genre = protected.iter().any(|field| field == "genre");
  let protected_year = protected.iter().any(|field| field == "year");
  let protected_artists = protected.iter().any(|field| field == "artists");
  let protected_album = protected.iter().any(|field| field == "album");

  let track_id = match existing_track {
    Some(track_id) => {
      sqlx::query(
        "UPDATE music_tracks SET \
         title = CASE WHEN ? THEN title ELSE ? END, \
         sort_title = CASE WHEN ? THEN sort_title ELSE ? END, \
         genre = CASE WHEN ? THEN genre ELSE ? END, \
         year = CASE WHEN ? THEN year ELSE ? END, \
         duration_ms = ?, folder_id = ?, relative_path = ?, file_name = ?, \
         file_path = ?, file_size = ?, file_modified_at = ?, format = ?, bitrate = ?, sample_rate = ?, \
         status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .bind(protected_title)
      .bind(&title)
      .bind(protected_title)
      .bind(normalize_name(&title))
      .bind(protected_genre)
      .bind(&parsed.genre)
      .bind(protected_year)
      .bind(parsed.year)
      .bind(parsed.duration_ms)
      .bind(&source.id)
      .bind(&file.relative)
      .bind(&file.file_name)
      .bind(file.file_path.as_deref())
      .bind(file.size)
      .bind(file.mtime)
      .bind(&file.format)
      .bind(parsed.bitrate)
      .bind(parsed.sample_rate)
      .bind(now)
      .bind(track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("更新曲目失败：{error}")))?;
      track_id.to_string()
    }
    None => {
      let track_id = new_id("trk");
      sqlx::query(
        "INSERT INTO music_tracks \
         (id, kind, title, sort_title, duration_ms, year, genre, status, \
          folder_id, relative_path, file_name, file_path, file_size, file_modified_at, format, \
          bitrate, sample_rate, added_at, updated_at) \
         VALUES (?, 'file', ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(&track_id)
      .bind(&title)
      .bind(normalize_name(&title))
      .bind(parsed.duration_ms)
      .bind(parsed.year)
      .bind(&parsed.genre)
      .bind(&source.id)
      .bind(&file.relative)
      .bind(&file.file_name)
      .bind(file.file_path.as_deref())
      .bind(file.size)
      .bind(file.mtime)
      .bind(&file.format)
      .bind(parsed.bitrate)
      .bind(parsed.sample_rate)
      .bind(now)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("创建曲目失败：{error}")))?;
      track_id
    }
  };

  let imported = serde_json::json!({
    "title": title,
    "artists": artists,
    "album": album,
    "albumArtist": album_artist_name,
    "genre": parsed.genre,
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

  let mut artist_ids = Vec::new();
  if protected_artists {
    artist_ids = sqlx::query_scalar(
      "SELECT artist_id FROM music_track_artists WHERE track_id = ? \
       AND role IN ('primary', 'featured') ORDER BY position, artist_id",
    )
    .bind(&track_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("读取受保护艺术家失败：{error}")))?;
  } else {
    sqlx::query("DELETE FROM music_track_artists WHERE track_id = ? AND source = 'import'")
      .bind(&track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理艺术家关系失败：{error}")))?;
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
  }

  let album_artist_id = match album_artist_name.as_deref() {
    Some(name) if !name.trim().is_empty() => Some(ensure_artist(&mut tx, name, "unknown").await?),
    _ => artist_ids.first().cloned(),
  };
  let album_id = match album.as_deref() {
    Some(title) => ensure_album(&mut tx, title, album_artist_id.as_deref(), parsed.year).await?,
    None => None,
  };

  if !protected_album {
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
  }

  for field in ["title", "artists", "album", "genre", "year"] {
    if protected.iter().any(|item| item == field) {
      continue;
    }
    sqlx::query(
      "INSERT INTO music_field_sources \
       (track_id, field, source, confidence, updated_at) VALUES (?, ?, 'import', NULL, ?) \
       ON CONFLICT(track_id, field) DO UPDATE SET source = 'import', \
         confidence = NULL, updated_at = excluded.updated_at",
    )
    .bind(&track_id)
    .bind(field)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入字段来源失败：{error}")))?;
  }

  if !(protected_title || protected_artists || protected_album) {
    let search_text = normalize_name(&format!(
      "{} {} {} {}",
      title,
      artists.join(" "),
      album.clone().unwrap_or_default(),
      file.relative
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
  }

  let folder = if parsed.cover.is_none() {
    assets::folder_cover(&file.path)
  } else {
    None
  };
  let (cover, cover_source) = match (&parsed.cover, &folder) {
    (Some(cover), _) => (Some(cover), CoverSource::Embedded),
    (None, Some(cover)) => (Some(cover), CoverSource::Folder),
    _ => (None, CoverSource::Embedded),
  };
  assets::ingest_cover(&mut tx, assets_dir, &track_id, cover, cover_source, now).await?;
  let sidecar = assets::sidecar_lyrics(&file.path);
  assets::ingest_lyrics(
    &mut tx,
    &track_id,
    parsed.lyrics.as_deref(),
    sidecar.as_ref(),
    now,
  )
  .await?;

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交扫描事务失败：{error}")))?;

  Ok(if existing_track.is_some() {
    UpsertResult::Updated
  } else {
    UpsertResult::Added
  })
}

/// 导入用户逐个选择的音频文件，写入「单曲导入」目录。
///
/// 文件绝对路径写入 `file_path`，`relative_path` 只保留文件名用于显示；因此
/// 不同目录下的同名文件可以同时存在，重复导入同一个文件则跳过或更新。
pub async fn import_single(
  pool: &SqlitePool,
  source: &SourceRow,
  path: &Path,
  assets_dir: &Path,
) -> Result<ImportOutcome, MediaError> {
  let canonical = dunce::canonicalize(path)
    .map_err(|error| MediaError::new("folders.invalid-path", format!("文件不可用：{error}")))?;
  if !canonical.is_file() {
    return Err(MediaError::new(
      "folders.invalid-path",
      "选择的路径不是文件",
    ));
  }
  if !is_audio(&canonical) {
    return Err(MediaError::new(
      "folders.unsupported-format",
      "只支持导入 mp3/flac/m4a/aac/wav/ogg/opus/aiff 音频文件",
    ));
  }
  let file_name = canonical
    .file_name()
    .and_then(std::ffi::OsStr::to_str)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| MediaError::new("folders.invalid-path", "文件名不是合法 UTF-8"))?
    .to_string();
  let absolute = canonical.to_string_lossy().replace('\\', "/");

  let existing = sqlx::query_as::<_, ExistingTrackRow>(
    "SELECT id, relative_path, status, file_size, file_modified_at, format \
     FROM music_tracks WHERE folder_id = ? AND kind = 'file' \
       AND file_path COLLATE NOCASE = ? LIMIT 1",
  )
  .bind(&source.id)
  .bind(&absolute)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取已导入单曲失败：{error}")))?;

  let mut entry = build_entry(canonical, file_name)?;
  entry.file_path = Some(absolute);

  if let Some(track) = existing.as_ref() {
    let unchanged = track.file_size == entry.size
      && track.file_modified_at == entry.mtime
      && track.format.as_deref() == Some(entry.format.as_str());
    if unchanged {
      if track.status != "active" {
        sqlx::query("UPDATE music_tracks SET status = 'active' WHERE id = ?")
          .bind(&track.id)
          .execute(pool)
          .await
          .map_err(|error| MediaError::internal(format!("恢复单曲状态失败：{error}")))?;
      }
      return Ok(ImportOutcome::Skipped);
    }
    upsert_track(pool, source, &entry, Some(&track.id), assets_dir).await?;
    return Ok(ImportOutcome::Updated);
  }

  upsert_track(pool, source, &entry, None, assets_dir).await?;
  Ok(ImportOutcome::Added)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

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
  fn relative_keys_are_case_and_separator_insensitive() {
    assert_eq!(normalize_relative(r"Album\Song.MP3"), "album/song.mp3");
    assert_eq!(normalize_relative("Album/Song.mp3"), "album/song.mp3");
  }

  #[test]
  fn manual_title_survives_rescan() {
    let root = std::env::temp_dir().join(format!("lull-scan-manual-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    let file = root.join("Artist - Manual.wav");
    write_silence_wav(&file);
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      crate::media::library::scan_path(&pool, &root)
        .await
        .expect("first scan");
      let track_id: String = sqlx::query_scalar(
        "SELECT id FROM music_tracks WHERE relative_path = 'Artist - Manual.wav' LIMIT 1",
      )
      .fetch_one(&pool)
      .await
      .expect("track id");
      sqlx::query("UPDATE music_tracks SET title = '人工标题' WHERE id = ?")
        .bind(&track_id)
        .execute(&pool)
        .await
        .expect("manual title");
      sqlx::query(
        "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
         VALUES (?, 'title', 'manual', 1.0, 1) \
         ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', confidence = 1.0",
      )
      .bind(&track_id)
      .execute(&pool)
      .await
      .expect("field source");

      std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .expect("open wav")
        .write_all(b"\0")
        .expect("append");
      crate::media::library::scan_path(&pool, &root)
        .await
        .expect("second scan");
      let title: String = sqlx::query_scalar("SELECT title FROM music_tracks WHERE id = ?")
        .bind(&track_id)
        .fetch_one(&pool)
        .await
        .expect("title");
      assert_eq!(title, "人工标题");
    });
  }

  #[test]
  fn scan_is_incremental_and_persists_tracks() {
    let root = std::env::temp_dir().join(format!("lull-scan-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    write_silence_wav(&root.join("Artist - Tree.wav"));
    std::fs::write(root.join("cover.png"), b"\x89PNG\r\n\x1a\ncover").expect("cover");
    std::fs::write(
      root.join("Artist - Tree.lrc"),
      "[00:00.00]树影\n[00:04.00]风",
    )
    .expect("lyrics");
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
      assert_eq!(first.skipped, 0);

      let second = crate::media::library::scan_path(&pool, &root)
        .await
        .expect("second scan");
      assert_eq!(second.added, 0);
      assert_eq!(second.updated, 0);
      assert_eq!(second.skipped, 1);

      let tracks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks")
        .fetch_one(&pool)
        .await
        .expect("count tracks");
      let search: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_search_text")
        .fetch_one(&pool)
        .await
        .expect("count search rows");
      let covers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_track_assets")
        .fetch_one(&pool)
        .await
        .expect("count cover relations");
      let lyrics: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_lyrics")
        .fetch_one(&pool)
        .await
        .expect("count lyrics");
      let storage_key: String = sqlx::query_scalar("SELECT storage_key FROM music_assets LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("cover storage key");
      let (relative, format, folder_id): (String, String, String) =
        sqlx::query_as("SELECT relative_path, format, folder_id FROM music_tracks LIMIT 1")
          .fetch_one(&pool)
          .await
          .expect("track file fields");

      sqlx::query("UPDATE music_tracks SET genre = 'Ambient', year = 2024")
        .execute(&pool)
        .await
        .expect("set genre");
      let (filtered, total) = crate::media::repository::tracks::list(
        &pool,
        &crate::media::api::dto::TrackQuery {
          genre: Some("ambient".to_string()),
          format: Some("wav".to_string()),
          year: Some(2024),
          ..Default::default()
        },
      )
      .await
      .expect("filter tracks");
      let genres = crate::media::repository::tracks::list_genres(&pool)
        .await
        .expect("genres");
      crate::media::repository::db::close(&pool).await;
      assert_eq!(relative, "Artist - Tree.wav");
      assert_eq!(format, "wav");
      assert!(!folder_id.is_empty());
      assert_eq!(genres, vec!["Ambient".to_string()]);
      assert_eq!(tracks, 1);
      assert_eq!(search, 1);
      assert_eq!(covers, 1);
      assert_eq!(lyrics, 1);
      assert!(root.join("assets").join(storage_key).is_file());
      assert_eq!(total, 1);
      assert_eq!(filtered.len(), 1);
    });

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn scan_skips_unchanged_and_removes_missing_files() {
    let root = std::env::temp_dir().join(format!("lull-scan-missing-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    write_silence_wav(&root.join("one.wav"));
    write_silence_wav(&root.join("two.wav"));
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      let first = crate::media::library::scan_path(&pool, &root)
        .await
        .expect("first scan");
      assert_eq!(first.added, 2);

      std::fs::remove_file(root.join("two.wav")).expect("remove file");
      let second = crate::media::library::scan_path(&pool, &root)
        .await
        .expect("second scan");
      let tracks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks")
        .fetch_one(&pool)
        .await
        .expect("count tracks");
      crate::media::repository::db::close(&pool).await;
      assert_eq!(second.added, 0);
      assert_eq!(second.skipped, 1);
      assert_eq!(second.removed, 1);
      assert_eq!(tracks, 1);
    });

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn recursive_flag_limits_discovery() {
    let root = std::env::temp_dir().join(format!("lull-scan-recursive-{}", uuid::Uuid::now_v7()));
    let nested = root.join("album");
    std::fs::create_dir_all(&nested).expect("create scan dir");
    write_silence_wav(&root.join("top.wav"));
    write_silence_wav(&nested.join("nested.wav"));
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).expect("assets");
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      let source = crate::media::repository::sources::insert_local(
        &pool,
        "测试音乐",
        root.to_str().expect("root utf8"),
        false,
      )
      .await
      .expect("source");
      let control = ScanControl {
        assets_dir: &assets,
        cancel: None,
        on_progress: None,
      };
      let outcome = scan_source(&pool, &source, "run-recursive", &control)
        .await
        .expect("scan");
      crate::media::repository::db::close(&pool).await;
      assert_eq!(outcome.added, 1);
    });

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn missing_root_keeps_tracks_and_reports_unavailable() {
    let root = std::env::temp_dir().join(format!("lull-scan-root-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    write_silence_wav(&root.join("one.wav"));
    let db_path = std::env::temp_dir().join(format!("lull-scan-root-{}.db", uuid::Uuid::now_v7()));
    let assets = std::env::temp_dir().join(format!("lull-scan-assets-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&assets).expect("assets");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      let source = crate::media::repository::sources::insert_local(
        &pool,
        "测试音乐",
        root.to_str().expect("root utf8"),
        true,
      )
      .await
      .expect("source");
      let control = ScanControl {
        assets_dir: &assets,
        cancel: None,
        on_progress: None,
      };
      scan_source(&pool, &source, "run-1", &control)
        .await
        .expect("first scan");
      std::fs::remove_dir_all(&root).expect("remove root");
      let error = scan_source(&pool, &source, "run-2", &control)
        .await
        .expect_err("missing root");
      let tracks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks")
        .fetch_one(&pool)
        .await
        .expect("count tracks");
      crate::media::repository::db::close(&pool).await;
      assert_eq!(error.code, "folders.unavailable");
      assert_eq!(tracks, 1);
    });

    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_dir_all(&assets);
  }

  #[test]
  fn scan_reports_progress_and_can_be_cancelled_before_work() {
    let root = std::env::temp_dir().join(format!("lull-scan-control-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create scan dir");
    write_silence_wav(&root.join("one.wav"));
    write_silence_wav(&root.join("two.wav"));
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).expect("assets");
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&db_path)
        .await
        .expect("open db");
      let source = crate::media::repository::sources::insert_local(
        &pool,
        "测试音乐",
        root.to_str().expect("root utf8"),
        true,
      )
      .await
      .expect("source");
      let processed = std::sync::atomic::AtomicU64::new(0);
      let on_progress = |progress: ScanProgress| {
        processed.store(progress.processed, Ordering::SeqCst);
      };
      let control = ScanControl {
        assets_dir: &assets,
        cancel: None,
        on_progress: Some(&on_progress),
      };
      let outcome = scan_source(&pool, &source, "run-progress", &control)
        .await
        .expect("scan progress");
      assert_eq!(outcome.added, 2);
      assert_eq!(processed.load(Ordering::SeqCst), 2);

      let cancel = AtomicBool::new(true);
      let control = ScanControl {
        assets_dir: &assets,
        cancel: Some(&cancel),
        on_progress: None,
      };
      let outcome = scan_source(&pool, &source, "run-cancel", &control)
        .await
        .expect("scan cancel");
      assert!(outcome.cancelled);
      assert_eq!(outcome.added, 0);
      crate::media::repository::db::close(&pool).await;
    });

    let _ = std::fs::remove_dir_all(&root);
  }
}
