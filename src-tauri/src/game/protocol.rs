//! Game Protocol v1 的线上结构。
//!
//! 全部 camelCase；宿主命令与事件共用这里的 DTO。破坏性变更才递增
//! `PROTOCOL_VERSION`；新增可选字段由读取方忽略。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::GameErrorBody;

pub const PROTOCOL_VERSION: u32 = 1;
pub const HOST_API: u32 = 1;
pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 5_000;
pub const MAX_COMMAND_PAYLOAD_BYTES: usize = 32 * 1024;
pub const MAX_EVENT_BYTES: usize = 16 * 1024;
pub const MAX_EVENTS_PER_COMMIT: usize = 32;
pub const MAX_RENDER_STATE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GameRole {
  Authority,
  Replica,
  Controller,
}

impl GameRole {
  #[allow(dead_code)] // 协议校验/日志用；序列化由 serde 完成。
  #[must_use]
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Authority => "authority",
      Self::Replica => "replica",
      Self::Controller => "controller",
    }
  }
}

/// 宿主硬上限的公开视图；manifest 只能收紧，不能放宽。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLimits {
  pub max_state_bytes: u64,
  pub max_event_bytes: usize,
  pub max_events_per_commit: usize,
  pub max_render_state_bytes: usize,
  pub max_replicas: u32,
  pub tick_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRect {
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameViewport {
  pub width: f64,
  pub height: f64,
  pub dpr: f64,
}

/// 单屏渲染上下文：几何直接来自 SceneFrame，不另算一套坐标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRenderContext {
  #[serde(default = "default_protocol")]
  pub protocol: u32,
  pub display_id: String,
  /// `mirror` | `span`，由壁纸显示模式映射而来。
  pub mode: String,
  pub canvas: GameRect,
  pub view: GameRect,
  pub viewport: GameViewport,
}

fn default_protocol() -> u32 {
  PROTOCOL_VERSION
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameContext {
  pub protocol: u32,
  pub host_api: u32,
  pub role: GameRole,
  pub game_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub instance_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub authority_id: Option<String>,
  pub authority_epoch: u32,
  pub revision: u64,
  pub simulation_time_ms: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub render: Option<GameRenderContext>,
  pub limits: GameLimits,
  pub locale: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSnapshot {
  pub protocol: u32,
  pub game_id: String,
  pub instance_id: String,
  pub revision: u64,
  pub authority_epoch: u32,
  pub simulation_time_ms: u64,
  pub state: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEvent {
  pub protocol: u32,
  pub game_id: String,
  pub instance_id: String,
  pub event_id: String,
  pub revision: u64,
  pub authority_epoch: u32,
  #[serde(rename = "type")]
  pub kind: String,
  pub payload: Value,
  pub simulation_time_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRenderState {
  pub protocol: u32,
  pub game_id: String,
  pub instance_id: String,
  pub revision: u64,
  pub authority_epoch: u32,
  pub state: Value,
  pub published_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLifecycle {
  pub game_id: String,
  pub instance_id: String,
  pub authority_epoch: u32,
  pub revision: u64,
  /// started / stopped / suspended / resumed / authority-changed / failed
  pub state: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub offline_ms: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<GameErrorBody>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCommandEnvelope {
  pub protocol: u32,
  pub request_id: String,
  #[serde(rename = "type")]
  pub kind: String,
  pub payload: Value,
  pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameTick {
  pub simulation_time_ms: u64,
  pub delta_ms: u64,
  pub wall_clock_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConnectResult {
  pub context: Option<GameContext>,
  pub replica_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstanceView {
  pub game_id: String,
  pub instance_id: String,
  pub authority_epoch: u32,
  pub revision: u64,
  pub simulation_time_ms: u64,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_error: Option<GameErrorBody>,
  pub replicas: usize,
  pub controllers: usize,
  pub updated_at: u64,
}

/// 已安装游戏的宿主视图（设置页与扩展中心共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameView {
  pub id: String,
  pub name: String,
  pub version: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub author: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub license: Option<String>,
  /// `ready` / `invalid` / `disabled`
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub enabled: bool,
  pub granted: Vec<String>,
  pub capabilities: Vec<String>,
  /// 包内 `entry.replica` 的 `lullgame://` URL；没有自带渲染入口时为 None。
  #[serde(skip_serializing_if = "Option::is_none")]
  pub entry_replica_url: Option<String>,
  pub state_schema_version: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub instance: Option<GameInstanceView>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConnectRequest {
  #[serde(default)]
  pub game_id: Option<String>,
  #[serde(default)]
  #[allow(dead_code)] // P2 场景绑定时使用。
  pub scene_id: Option<String>,
  #[serde(default)]
  pub render: Option<GameRenderContext>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEventDraft {
  #[serde(rename = "type")]
  pub kind: String,
  #[serde(default)]
  pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStateUpdate {
  pub authority_id: String,
  pub authority_epoch: u32,
  pub base_revision: u64,
  #[serde(default)]
  pub simulation_time_ms: u64,
  pub state: Value,
  #[serde(default)]
  pub events: Vec<GameEventDraft>,
  #[serde(default)]
  pub render_state: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCommitResult {
  pub ok: bool,
  pub revision: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<GameErrorBody>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCommandSendRequest {
  pub request_id: String,
  #[serde(rename = "type")]
  pub kind: String,
  #[serde(default)]
  pub payload: Value,
  #[serde(default)]
  pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCommandResult {
  pub request_id: String,
  pub ok: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub revision: Option<u64>,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub deduplicated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCommandResultRequest {
  pub request_id: String,
  pub ok: bool,
  #[serde(default)]
  pub result: Option<Value>,
  #[serde(default)]
  pub error: Option<String>,
  #[serde(default)]
  pub revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRenderPublishRequest {
  pub revision: u64,
  pub state: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameReportErrorRequest {
  pub scope: String,
  pub code: String,
  pub message: String,
}

#[must_use]
pub fn event_id(instance_id: &str, revision: u64, seq: u64) -> String {
  format!("{instance_id}:{revision}:{seq}")
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn event_serializes_type_field_camel_case() {
    let event = GameEvent {
      protocol: PROTOCOL_VERSION,
      game_id: "community.living-world".into(),
      instance_id: "i1".into(),
      event_id: event_id("i1", 2, 0),
      revision: 2,
      authority_epoch: 1,
      kind: "world.changed".into(),
      payload: json!({"ok": true}),
      simulation_time_ms: 10,
    };
    let value = serde_json::to_value(event).expect("serialize");
    assert_eq!(value["type"], "world.changed");
    assert_eq!(value["eventId"], "i1:2:0");
    assert_eq!(value["simulationTimeMs"], 10);
  }

  #[test]
  fn state_update_accepts_sdk_shape() {
    let update: GameStateUpdate = serde_json::from_value(json!({
      "authorityId": "a1",
      "authorityEpoch": 3,
      "baseRevision": 7,
      "simulationTimeMs": 100,
      "state": {"food": 2},
      "events": [{"type": "world.changed", "payload": {}}]
    }))
    .expect("deserialize");
    assert_eq!(update.base_revision, 7);
    assert_eq!(update.events.len(), 1);
    assert!(update.render_state.is_none());
  }

  #[test]
  fn role_strings_are_lowercase() {
    assert_eq!(GameRole::Authority.as_str(), "authority");
    assert_eq!(GameRole::Replica.as_str(), "replica");
    assert_eq!(GameRole::Controller.as_str(), "controller");
  }
}
