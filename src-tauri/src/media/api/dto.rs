//! Media API 的公开 DTO。
//!
//! 规则：
//! - 这些类型只用于 IPC，不直接映射数据库行；
//! - 不包含 `path` / `root_path` 以外的文件系统细节，且 `root_path` 只允许
//!   host 窗口读取（当前 `library.listSources` 只对设置窗开放）；
//! - 字段以 camelCase 输出，与 TypeScript SDK 对齐。

use serde::{Deserialize, Serialize};

use crate::media::repository::sources::SourceRow;
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

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
  #[serde(default)]
  pub keyword: Option<String>,
  #[serde(default)]
  pub source_ids: Option<Vec<String>>,
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
  pub track_number: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub disc_number: Option<i64>,
  pub source: String,
  pub available: bool,
  pub has_cover: bool,
}

impl From<TrackRow> for TrackSummary {
  fn from(row: TrackRow) -> Self {
    Self {
      id: row.id,
      title: row.title,
      artists: split_names(row.artist_names.as_deref()),
      album: row.album_title,
      album_id: row.album_id,
      duration_ms: row.duration_ms,
      year: row.year,
      track_number: row.track_number,
      disc_number: row.disc_number,
      source: row.kind,
      available: row.available != 0,
      has_cover: row.cover_asset_id.is_some(),
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDetailView {
  #[serde(flatten)]
  pub summary: TrackSummary,
  pub metadata: serde_json::Value,
  pub files: Vec<TrackFileView>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanJobView {
  pub job_id: String,
  pub source_id: String,
  pub status: String,
}
