//! 媒体子系统的稳定 DTO 与诊断视图。
//!
//! 这些类型是 Tauri 命令的序列化契约；Rust 内部状态不得直接暴露 `media-pp` 类型。

use serde::{Deserialize, Serialize};

use super::config::MediaConfig;

/// 当前实际使用的呈现后端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaBackend {
  /// WebView2 TextureStream：Rust 解码一次，多个 WebView 共享帧。
  NativeTexture,
  /// HTML `<video>`：每个 WebView 由 Chromium 自行解码。
  HtmlVideo,
}

/// 会话状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaSessionState {
  Starting,
  Playing,
  Paused,
  Degraded,
  Ended,
  Error,
}

/// 能力探测结果。原生路径不可用时，前端必须走 HTML 回退。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilities {
  pub native_texture_stream: bool,
  pub hardware_decode: bool,
  pub reason: Option<String>,
  pub runtime_version: Option<String>,
  pub adapter_luid: Option<u64>,
  /// 是否至少有一条可用路径；当前 HTML 回退始终可用。
  pub html_fallback: bool,
}

impl Default for MediaCapabilities {
  fn default() -> Self {
    Self {
      native_texture_stream: false,
      hardware_decode: false,
      reason: Some("native media bridge is not built".to_string()),
      runtime_version: None,
      adapter_luid: None,
      html_fallback: true,
    }
  }
}

/// 单个呈现面（WebView）的运行时视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSurfaceView {
  pub label: String,
  pub device: Option<String>,
  pub backend: MediaBackend,
  pub started: bool,
  pub presented: u64,
  pub dropped: u64,
  pub last_media_pts_us: Option<i64>,
  pub last_presented_at_ms: Option<u64>,
  pub adapter_luid: Option<u64>,
}

/// 单个媒体会话的运行时视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionView {
  pub session_id: String,
  pub scene_id: String,
  pub asset_id: String,
  pub asset_name: Option<String>,
  pub backend: MediaBackend,
  pub state: MediaSessionState,
  pub loop_playback: bool,
  pub muted: bool,
  pub rate: f32,
  pub preferred_fps: u16,
  pub hardware_decode: String,
  pub share: String,
  pub decode_path: Option<String>,
  pub decoder_instances: u32,
  pub position_ms: u64,
  pub duration_ms: Option<u64>,
  pub last_error: Option<String>,
  pub surfaces: Vec<MediaSurfaceView>,
}

/// 诊断汇总。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStats {
  pub sessions: usize,
  pub native_sessions: usize,
  pub fallback_sessions: usize,
  pub decoder_instances: u32,
  pub cpu_readback_bytes: u64,
  pub capabilities: MediaCapabilities,
  pub session_views: Vec<MediaSessionView>,
}

/// 配置 + 素材 + 能力的组合视图，壁纸与设置页共用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaConfigView {
  pub config: MediaConfig,
  pub asset: Option<super::assets::MediaAssetView>,
  pub asset_url: Option<String>,
  pub capabilities: MediaCapabilities,
}

/// `media_open` 的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOpenResult {
  pub session_id: String,
  pub backend: MediaBackend,
  pub asset_url: String,
  pub state: MediaSessionState,
  pub reason: Option<String>,
}

/// `media_attach` 的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAttachResult {
  pub backend: MediaBackend,
  pub stream_id: Option<String>,
  pub asset_url: String,
  pub state: MediaSessionState,
  pub reason: Option<String>,
}

/// `media-changed` 事件载荷；只带 id，消费方按需刷新。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaChangedEvent {
  pub session_ids: Vec<String>,
}

/// `media-degraded` 事件载荷；壁纸收到后从原生切到 HTML。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDegradedEvent {
  pub session_id: String,
  pub asset_url: String,
  pub reason: String,
}
