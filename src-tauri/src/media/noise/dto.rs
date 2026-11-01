//! Noise 业务域公开 DTO。
//!
//! `NoiseSessionView`/`NoiseTrackView` 是新模型；`NoiseStateView` 是旧 5 层
//! `noise.*` API 的兼容视图，N2 期间两者由同一个运行时 Session 生成。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseLayerView {
  pub sound_id: String,
  pub enabled: bool,
  pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSleepView {
  pub timer_minutes: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ends_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseTrackError {
  pub code: String,
  pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseTrackView {
  pub id: String,
  pub asset_id: String,
  pub name: String,
  pub state: String,
  pub volume: f64,
  pub enabled: bool,
  #[serde(rename = "loop")]
  pub loop_: bool,
  pub position_ms: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub fade_in_ms: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub fade_out_ms: Option<i64>,
  pub order: usize,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<NoiseTrackError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSessionView {
  pub id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
  pub state: String,
  pub master_volume: f64,
  pub muted: bool,
  pub tracks: Vec<NoiseTrackView>,
  pub sleep: NoiseSleepView,
  pub revision: u64,
  pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseStateView {
  pub session_id: String,
  pub active: bool,
  pub master: f64,
  pub muted: bool,
  pub layers: Vec<NoiseLayerView>,
  pub sleep: NoiseSleepView,
  pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSoundView {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseAssetQuery {
  #[serde(default)]
  pub keyword: Option<String>,
  #[serde(default)]
  pub category_id: Option<String>,
  #[serde(default)]
  pub tag_id: Option<String>,
  #[serde(default)]
  pub favorite_only: Option<bool>,
  #[serde(default)]
  pub status: Option<String>,
  #[serde(default)]
  pub media_kind: Option<String>,
  #[serde(default)]
  pub page: Option<u32>,
  #[serde(default)]
  pub page_size: Option<u32>,
  #[serde(default)]
  pub sort_by: Option<String>,
  #[serde(default)]
  pub sort_order: Option<String>,
}

impl NoiseAssetQuery {
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
pub struct NoiseCategoryView {
  pub id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub parent_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub icon: Option<String>,
  pub sort_order: i64,
  pub asset_count: i64,
  pub source_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseTagView {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub asset_count: i64,
  #[serde(default)]
  pub source_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseAssetCategory {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseAssetCapabilities {
  #[serde(rename = "loop")]
  pub loop_: bool,
  pub seek: bool,
  pub fade: bool,
}

impl Default for NoiseAssetCapabilities {
  fn default() -> Self {
    Self {
      loop_: true,
      seek: false,
      fade: true,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseAssetView {
  pub id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub media_kind: String,
  pub format: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub duration_ms: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sample_rate: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub channels: Option<i64>,
  pub size_bytes: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub category: Option<NoiseAssetCategory>,
  pub tags: Vec<NoiseTagView>,
  pub favorite: bool,
  pub status: String,
  pub source: String,
  pub capabilities: NoiseAssetCapabilities,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseImportFailure {
  pub file_name: String,
  pub code: String,
  pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoiseImportResult {
  pub imported: Vec<NoiseAssetView>,
  pub duplicates: Vec<NoiseAssetView>,
  pub failed: Vec<NoiseImportFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseRevalidateResult {
  pub checked: i64,
  pub missing: i64,
  pub restored: i64,
}
