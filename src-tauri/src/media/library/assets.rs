//! 封面与歌词资产写入。
//!
//! 文件内容按 SHA-256 内容寻址保存到 `<music>/assets/`；数据库只存 storage_key
//! 与 MIME，不把二进制塞进 SQLite。扫描只读用户文件，资产是 Lull 自己的副本。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::Sqlite;

use crate::media::api::errors::MediaError;

use super::metadata::EmbeddedCover;

#[derive(Debug, Clone, Copy)]
pub enum CoverSource {
  Embedded,
  Folder,
}

impl CoverSource {
  fn as_str(self) -> &'static str {
    match self {
      Self::Embedded => "embedded",
      Self::Folder => "folder",
    }
  }
}

fn extension_for_mime(mime: &str) -> &'static str {
  match mime {
    "image/png" => "png",
    "image/webp" => "webp",
    "image/gif" => "gif",
    _ => "jpg",
  }
}

fn mime_for_path(path: &Path) -> &'static str {
  match path
    .extension()
    .and_then(std::ffi::OsStr::to_str)
    .map(str::to_ascii_lowercase)
    .as_deref()
  {
    Some("png") => "image/png",
    Some("webp") => "image/webp",
    Some("gif") => "image/gif",
    _ => "image/jpeg",
  }
}

/// 在音频目录查找常见封面文件。
#[must_use]
pub fn folder_cover(audio_path: &Path) -> Option<EmbeddedCover> {
  static NAMES: &[&str] = &[
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "cover.webp",
    "folder.jpg",
    "folder.jpeg",
    "folder.png",
    "front.jpg",
    "front.png",
  ];
  let parent = audio_path.parent()?;
  for name in NAMES {
    let path = parent.join(name);
    if path.is_file() {
      if let Ok(bytes) = std::fs::read(&path) {
        return Some(EmbeddedCover {
          bytes,
          mime: mime_for_path(&path).to_string(),
        });
      }
    }
  }
  None
}

/// 保存封面并把当前主封面指向它；重复扫描会替换旧的 embedded/folder 封面。
pub async fn ingest_cover(
  tx: &mut sqlx::Transaction<'_, Sqlite>,
  assets_dir: &Path,
  track_id: &str,
  cover: Option<&EmbeddedCover>,
  source: CoverSource,
  now: i64,
) -> Result<(), MediaError> {
  let Some(cover) = cover else {
    return Ok(());
  };
  let digest = Sha256::digest(&cover.bytes);
  let hex = format!("{digest:x}");
  let storage_key = format!("{hex}.{}", extension_for_mime(&cover.mime));
  let path = assets_dir.join(&storage_key);
  if !path.is_file() {
    std::fs::write(&path, &cover.bytes)
      .map_err(|error| MediaError::internal(format!("写入封面资产失败：{error}")))?;
  }
  let asset_id = format!("asset_{}", &hex[..16]);
  sqlx::query(
    "INSERT INTO music_assets \
     (id, asset_type, content_hash, storage_key, mime_type, size_bytes, created_at) \
     VALUES (?, 'cover', ?, ?, ?, ?, ?) \
     ON CONFLICT(content_hash, asset_type) DO NOTHING",
  )
  .bind(&asset_id)
  .bind(&hex)
  .bind(&storage_key)
  .bind(&cover.mime)
  .bind(i64::try_from(cover.bytes.len()).unwrap_or(i64::MAX))
  .bind(now)
  .execute(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入封面索引失败：{error}")))?;
  let asset_id: String = sqlx::query_scalar(
    "SELECT id FROM music_assets WHERE content_hash = ? AND asset_type = 'cover'",
  )
  .bind(&hex)
  .fetch_one(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("读取封面索引失败：{error}")))?;

  sqlx::query("DELETE FROM music_track_assets WHERE track_id = ? AND role = 'cover'")
    .bind(track_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧封面失败：{error}")))?;
  sqlx::query(
    "INSERT INTO music_track_assets \
     (track_id, asset_id, role, source, is_primary, updated_at) \
     VALUES (?, ?, 'cover', ?, 1, ?)",
  )
  .bind(track_id)
  .bind(&asset_id)
  .bind(source.as_str())
  .bind(now)
  .execute(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入曲目封面失败：{error}")))?;
  Ok(())
}

/// 同名 sidecar 歌词：`.lrc`、`.txt`、`.srt`；只读文本，不写回文件。
#[derive(Debug, Clone)]
pub struct SidecarLyrics {
  pub content: String,
  pub format: &'static str,
}

/// 保存内嵌歌词或同名 sidecar；没有歌词时不清理旧记录。
pub async fn ingest_lyrics(
  tx: &mut sqlx::Transaction<'_, Sqlite>,
  track_id: &str,
  lyrics: Option<&str>,
  sidecar: Option<&SidecarLyrics>,
  now: i64,
) -> Result<(), MediaError> {
  let (content, format, source) = if let Some(content) = lyrics {
    (content, "embedded", "embedded")
  } else if let Some(sidecar) = sidecar {
    (sidecar.content.as_str(), sidecar.format, "sidecar")
  } else {
    return Ok(());
  };
  let trimmed = content.trim();
  if trimmed.is_empty() {
    return Ok(());
  }
  let digest = Sha256::digest(trimmed.as_bytes());
  let hex = format!("{digest:x}");
  sqlx::query("DELETE FROM music_lyrics WHERE track_id = ? AND source IN ('embedded', 'sidecar')")
    .bind(track_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧歌词失败：{error}")))?;
  let has_primary: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM music_lyrics WHERE track_id = ? AND is_primary = 1")
      .bind(track_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(|error| MediaError::internal(format!("检查主歌词失败：{error}")))?;
  sqlx::query(
    "INSERT INTO music_lyrics \
     (id, track_id, format, source, content, offset_ms, is_primary, content_hash, updated_at) \
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
  )
  .bind(crate::media::repository::new_id("lyric"))
  .bind(track_id)
  .bind(format)
  .bind(source)
  .bind(trimmed)
  .bind(if has_primary == 0 { 1_i64 } else { 0_i64 })
  .bind(&hex)
  .bind(now)
  .execute(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入歌词失败：{error}")))?;
  Ok(())
}

/// 同名 sidecar 歌词路径：`track.flac` → `track.lrc` / `track.txt` / `track.srt`。
#[must_use]
pub fn sidecar_lyrics(audio_path: &Path) -> Option<SidecarLyrics> {
  for format in ["lrc", "txt", "srt"] {
    let path: PathBuf = audio_path.with_extension(format);
    if !path.is_file() {
      continue;
    }
    if let Some(content) = std::fs::read_to_string(path)
      .ok()
      .filter(|value| !value.trim().is_empty())
    {
      return Some(SidecarLyrics { content, format });
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sidecar_lyrics_supports_lrc_txt_and_srt() {
    let dir = std::env::temp_dir().join(format!("lull-lyrics-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).expect("create dir");
    let audio = dir.join("track.flac");
    for (extension, content) in [
      ("lrc", "[00:00.00]雨"),
      ("txt", "纯文本"),
      ("srt", "1\n00:00"),
    ] {
      let path = audio.with_extension(extension);
      std::fs::write(&path, content).expect("write lyrics");
      let sidecar = sidecar_lyrics(&audio).expect("sidecar");
      assert_eq!(sidecar.format, extension);
      assert_eq!(sidecar.content, content);
      std::fs::remove_file(path).expect("remove lyrics");
    }
    assert!(sidecar_lyrics(&audio).is_none());
  }
}
