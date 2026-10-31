//! 音频元数据读取（只读）。
//!
//! 使用 lofty 读取标签与音频属性；任何解析失败都返回错误，由扫描器回退到
//! 文件名，不阻断整次扫描。这里不写回用户文件。

use std::path::Path;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::read_from_path;

use crate::media::repository::artists::split_artists;

#[derive(Debug, Clone)]
pub struct EmbeddedCover {
  pub bytes: Vec<u8>,
  pub mime: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedMetadata {
  pub title: Option<String>,
  pub artists: Vec<String>,
  pub album: Option<String>,
  pub album_artist: Option<String>,
  pub genre: Option<String>,
  pub year: Option<i64>,
  pub track_number: Option<i64>,
  pub disc_number: Option<i64>,
  pub duration_ms: Option<i64>,
  pub bitrate: Option<i64>,
  pub sample_rate: Option<i64>,
  pub channels: Option<i64>,
  pub lyrics: Option<String>,
  pub cover: Option<EmbeddedCover>,
  pub raw: serde_json::Value,
}

/// 文件名兜底：`Artist - Title`、`01 - Title`、`01. Title`、纯标题。
#[must_use]
pub fn parse_filename(path: &Path) -> (Option<String>, Vec<String>) {
  let stem = path
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("未命名音频")
    .trim();
  let stem = strip_track_prefix(stem);
  if let Some((artist, title)) = stem.split_once(" - ") {
    let artist = artist.trim();
    let title = title.trim();
    if !artist.is_empty() && !title.is_empty() {
      return (Some(title.to_string()), split_artists(artist));
    }
  }
  (Some(stem.to_string()), Vec::new())
}

fn strip_track_prefix(value: &str) -> &str {
  let bytes = value.as_bytes();
  let mut index = 0;
  while index < bytes.len() && bytes[index].is_ascii_digit() {
    index += 1;
  }
  if index == 0 || index >= bytes.len() {
    return value;
  }
  let rest = &value[index..];
  rest.trim_start_matches(['.', '-', '_', ' ']).trim()
}

fn non_empty(value: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
  value
    .map(|text| text.trim().to_string())
    .filter(|text| !text.is_empty())
}

fn to_i64(value: Option<u32>) -> Option<i64> {
  value.map(i64::from)
}

/// 读取标签与属性；文件格式不支持或损坏时返回 Err。
pub fn parse_file(path: &Path) -> Result<ParsedMetadata, String> {
  let tagged = read_from_path(path).map_err(|error| error.to_string())?;
  let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

  let (fallback_title, fallback_artists) = parse_filename(path);
  let mut parsed = ParsedMetadata {
    title: fallback_title,
    artists: fallback_artists,
    ..ParsedMetadata::default()
  };

  if let Some(tag) = tag {
    if let Some(title) = non_empty(tag.title()) {
      parsed.title = Some(title);
    }
    if let Some(artist) = non_empty(tag.artist()) {
      let artists = split_artists(&artist);
      if !artists.is_empty() {
        parsed.artists = artists;
      }
    }
    if let Some(album) = non_empty(tag.album()) {
      parsed.album = Some(album);
    }
    if let Some(genre) = non_empty(tag.genre()) {
      parsed.genre = Some(genre);
    }
    if let Some(album_artist) = tag
      .get_string(ItemKey::AlbumArtist)
      .map(str::to_string)
      .filter(|value| !value.trim().is_empty())
    {
      parsed.album_artist = Some(album_artist);
    }
    parsed.year = tag
      .get_string(ItemKey::Year)
      .and_then(|value| value.trim().get(..4))
      .and_then(|value| value.parse::<i64>().ok());
    parsed.track_number = to_i64(tag.track());
    parsed.disc_number = to_i64(tag.disk());
    parsed.lyrics = tag
      .get_string(ItemKey::Lyrics)
      .map(str::to_string)
      .filter(|value| !value.trim().is_empty());
    parsed.cover = tag.pictures().first().map(|picture| EmbeddedCover {
      bytes: picture.data().to_vec(),
      mime: picture.mime_type().map_or_else(
        || "image/jpeg".to_string(),
        |mime| mime.as_str().to_string(),
      ),
    });
  }

  let properties = tagged.properties();
  parsed.duration_ms = i64::try_from(properties.duration().as_millis()).ok();
  parsed.bitrate = properties.audio_bitrate().map(i64::from);
  parsed.sample_rate = properties.sample_rate().map(i64::from);
  parsed.channels = properties.channels().map(i64::from);
  parsed.raw = serde_json::json!({
    "title": parsed.title,
    "artists": parsed.artists,
    "album": parsed.album,
    "albumArtist": parsed.album_artist,
    "genre": parsed.genre,
    "year": parsed.year,
    "trackNumber": parsed.track_number,
    "discNumber": parsed.disc_number,
  });

  Ok(parsed)
}
