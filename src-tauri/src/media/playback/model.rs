//! P2 播放 / 队列 / 白噪音的公开 DTO 与内部状态。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::media::api::dto::TrackSummary;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStateView {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub track: Option<TrackSummary>,
  pub status: String,
  pub position_ms: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub duration_ms: Option<i64>,
  pub volume: f64,
  pub muted: bool,
  pub mode: String,
  pub revision: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStateView {
  pub track_ids: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub current_index: Option<usize>,
  pub revision: u64,
}

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
pub struct PlaybackSnapshot {
  pub protocol: u32,
  pub revision: u64,
  pub player: PlayerStateView,
  pub queue: QueueStateView,
  pub noise: NoiseStateView,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
  #[serde(default)]
  pub topics: Vec<String>,
  #[serde(default)]
  pub progress_ms: Option<u64>,
  #[serde(default)]
  pub levels: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct Subscription {
  pub topics: BTreeMap<String, bool>,
  pub progress_ms: u64,
  pub levels: bool,
}

impl Subscription {
  #[must_use]
  pub fn wants(&self, topic: &str) -> bool {
    self.topics.contains_key(topic)
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSoundView {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayMode {
  Sequence,
  Shuffle,
  RepeatOne,
}

impl PlayMode {
  #[must_use]
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "sequence" => Some(Self::Sequence),
      "shuffle" => Some(Self::Shuffle),
      "repeat-one" => Some(Self::RepeatOne),
      _ => None,
    }
  }

  #[must_use]
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Sequence => "sequence",
      Self::Shuffle => "shuffle",
      Self::RepeatOne => "repeat-one",
    }
  }
}
