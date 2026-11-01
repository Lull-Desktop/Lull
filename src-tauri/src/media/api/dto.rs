//! Media API 的公开 DTO。
//!
//! 规则：
//! - 这些类型只用于 IPC，不直接映射数据库行；
//! - 不暴露绝对路径；`rootPath` 只允许 settings/library 窗口读取，
//!   `relativePath` 只在 host-only 的 `folders.getTracks` 中返回；
//! - 字段以 camelCase 输出，与 TypeScript SDK 对齐。

use serde::{Deserialize, Serialize};

use crate::media::repository::sources::{FolderRow, SourceRow};
use crate::media::repository::tracks::TrackRow;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
  pub id: String,
  pub kind: String,
  pub name: String,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub root_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_scan_at: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_scan_error: Option<String>,
}

impl From<SourceRow> for SourceView {
  fn from(row: SourceRow) -> Self {
    Self {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      root_path: row.root_path,
      last_scan_at: row.last_scan_at,
      last_scan_error: row.last_scan_error,
    }
  }
}

/// 对外的物理目录视图。内部仍复用 `music_sources(kind='local')`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicFolderView {
  pub id: String,
  pub name: String,
  pub root_path: String,
  pub recursive: bool,
  /// `active` 在 DTO 层映射为 `available`；其余值保持一致。
  pub status: String,
  pub track_count: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_scanned_at: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_scan_error: Option<String>,
  pub created_at: i64,
  pub updated_at: i64,
}

/// 内部 status 的历史值是 active；对外的 MusicFolder 语义使用 available。
#[must_use]
pub fn folder_status(status: &str) -> String {
  match status {
    "active" => "available".to_string(),
    other => other.to_string(),
  }
}

impl From<FolderRow> for MusicFolderView {
  fn from(row: FolderRow) -> Self {
    Self {
      id: row.id,
      name: row.name,
      root_path: row.root_path,
      recursive: row.recursive != 0,
      status: folder_status(&row.status),
      track_count: row.track_count,
      last_scanned_at: row.last_scan_at,
      last_scan_error: row.last_scan_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
  #[serde(default)]
  pub keyword: Option<String>,
  #[serde(default)]
  pub source_ids: Option<Vec<String>>,
  /// 物理目录筛选；与 source_ids 指向同一 id 空间。
  #[serde(default)]
  pub folder_id: Option<String>,
  #[serde(default)]
  pub artist_id: Option<String>,
  #[serde(default)]
  pub album_id: Option<String>,
  #[serde(default)]
  pub genre: Option<String>,
  #[serde(default)]
  pub format: Option<String>,
  #[serde(default)]
  pub year: Option<i64>,
  #[serde(default)]
  pub year_from: Option<i64>,
  #[serde(default)]
  pub year_to: Option<i64>,
  #[serde(default)]
  pub page: Option<u32>,
  #[serde(default)]
  pub page_size: Option<u32>,
  #[serde(default)]
  pub sort_by: Option<String>,
  #[serde(default)]
  pub sort_order: Option<String>,
  #[serde(default)]
  pub include_unavailable: Option<bool>,
  #[serde(default)]
  pub favorite_only: Option<bool>,
  #[serde(default)]
  pub tag_id: Option<String>,
}

impl TrackQuery {
  #[must_use]
  pub fn page(&self) -> u32 {
    self.page.unwrap_or(1).max(1)
  }

  #[must_use]
  pub fn page_size(&self) -> u32 {
    self.page_size.unwrap_or(50).clamp(1, 200)
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
  pub id: String,
  pub title: String,
  pub artists: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub album: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub album_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub duration_ms: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub year: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub genre: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub track_number: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub disc_number: Option<i64>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub tags: Vec<TagView>,
  pub source: String,
  pub available: bool,
  pub has_cover: bool,
  pub favorite: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub folder_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub folder_name: Option<String>,
  pub added_at: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub format: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_size: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub bitrate: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sample_rate: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_modified_at: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub album_art_id: Option<String>,
}

impl From<TrackRow> for TrackSummary {
  fn from(row: TrackRow) -> Self {
    let is_file = row.kind != "builtin";
    let file_name = row.file_name.clone().or_else(|| {
      row
        .relative_path
        .as_deref()
        .and_then(|path| path.rsplit('/').next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
    });
    Self {
      id: row.id,
      title: row.title,
      artists: split_names(row.artist_names.as_deref()),
      album: row.album_title,
      album_id: row.album_id,
      duration_ms: row.duration_ms,
      year: row.year,
      genre: row.genre,
      track_number: row.track_number,
      disc_number: row.disc_number,
      tags: serde_json::from_str(&row.tags_json).unwrap_or_default(),
      source: "local".to_string(),
      available: row.available != 0,
      has_cover: row.cover_asset_id.is_some(),
      favorite: row.favorite != 0,
      folder_id: row.folder_id,
      folder_name: row.folder_name,
      added_at: row.added_at,
      file_name,
      format: row.format,
      file_size: if is_file { Some(row.file_size) } else { None },
      bitrate: row.bitrate,
      sample_rate: row.sample_rate,
      file_modified_at: row.file_modified_at,
      album_art_id: row.cover_asset_id,
    }
  }
}

fn split_names(value: Option<&str>) -> Vec<String> {
  value
    .map(|text| {
      text
        .split('\u{1f}')
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
  pub items: Vec<T>,
  pub total: i64,
  pub page: u32,
  pub page_size: u32,
  pub has_more: bool,
}

impl<T> Page<T> {
  #[must_use]
  pub fn new(items: Vec<T>, total: i64, page: u32, page_size: u32) -> Self {
    let loaded = i64::from(page) * i64::from(page_size);
    Self {
      items,
      total,
      page,
      page_size,
      has_more: loaded < total,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFileView {
  pub format: String,
  pub size_bytes: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub bitrate: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sample_rate: Option<i64>,
  pub available: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_modified_at: Option<i64>,
}

/// 目录详情里的曲目：在 TrackSummary 之外只多暴露 host 窗口可读的相对路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTrackView {
  #[serde(flatten)]
  pub summary: TrackSummary,
  pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyricsView {
  pub format: String,
  pub source: String,
  pub content: String,
  pub offset_ms: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDetailView {
  #[serde(flatten)]
  pub summary: TrackSummary,
  pub metadata: serde_json::Value,
  pub files: Vec<TrackFileView>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lyrics: Option<TrackLyricsView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub track_count: i64,
  pub needs_review: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
  pub id: String,
  pub title: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub year: Option<i64>,
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub album_artist: Option<String>,
  pub track_count: i64,
  pub has_cover: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagView {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub track_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPlaylistView {
  pub id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub rules: serde_json::Value,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanJobView {
  pub job_id: String,
  pub source_id: String,
  pub folder_id: String,
  pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
  pub id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub track_count: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
  pub track_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub track: Option<TrackSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
  #[serde(flatten)]
  pub summary: PlaylistSummary,
  pub entries: Vec<PlaylistEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteView {
  pub track_id: String,
  pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
  pub id: String,
  pub track_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub track: Option<TrackSummary>,
  pub played_at: i64,
  pub completed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uImportResult {
  pub playlist: PlaylistDetail,
  pub imported: i64,
  pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uExportResult {
  pub exported: i64,
  pub skipped: i64,
}
