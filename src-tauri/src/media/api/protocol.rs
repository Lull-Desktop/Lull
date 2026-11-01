//! Media API v1 的线上协议。
//!
//! 请求/响应全部使用 camelCase；前端 SDK 只通过 `media_call` 进入 Rust。
//! 破坏性变更才递增 `PROTOCOL_VERSION`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::errors::{MediaError, MediaErrorBody};

pub const PROTOCOL_VERSION: u32 = 1;

fn default_protocol() -> u32 {
  PROTOCOL_VERSION
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequest {
  #[serde(default = "default_protocol")]
  pub protocol: u32,
  #[serde(default)]
  pub request_id: String,
  pub namespace: String,
  pub method: String,
  #[serde(default)]
  pub args: Value,
  /// Widget 桥 token；官方窗口不传。
  #[serde(default)]
  pub bridge_token: Option<String>,
  /// 预留给 P2 的队列/播放冲突检查；P1 只读资料库不使用。
  #[allow(dead_code)]
  #[serde(default)]
  pub expected_revision: Option<u64>,
  /// 预留给歌单/Track 编辑的乐观并发检查。
  #[allow(dead_code)]
  #[serde(default)]
  pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResponse {
  pub protocol: u32,
  pub request_id: String,
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<MediaErrorBody>,
  pub revision: u64,
}

impl MediaResponse {
  #[must_use]
  pub fn ok(request_id: &str, result: Value, revision: u64) -> Self {
    Self {
      protocol: PROTOCOL_VERSION,
      request_id: request_id.to_string(),
      ok: true,
      result: Some(result),
      error: None,
      revision,
    }
  }

  #[must_use]
  pub fn error(request_id: &str, error: &MediaError, revision: u64) -> Self {
    Self {
      protocol: PROTOCOL_VERSION,
      request_id: request_id.to_string(),
      ok: false,
      result: None,
      error: Some(error.body()),
      revision,
    }
  }
}
