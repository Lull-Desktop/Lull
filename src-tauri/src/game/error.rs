//! Game Runtime 的稳定错误码与错误体。
//!
//! 命令层统一返回 `GameError`，序列化给前端时保持 `{ code, message, detail? }`。
//! code 是稳定契约（`docs/game-runtime.md` 附录 A），message 只用于兜底展示。

use serde::{Deserialize, Serialize};

/// 返回给前端的错误体；`detail` 只给诊断看。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameErrorBody {
  pub code: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameError {
  pub code: &'static str,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

impl GameError {
  #[must_use]
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
      detail: None,
    }
  }

  #[must_use]
  pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
    self.detail = Some(detail.into());
    self
  }

  #[must_use]
  pub fn body(&self) -> GameErrorBody {
    GameErrorBody {
      code: self.code.to_string(),
      message: self.message.clone(),
      detail: self.detail.clone(),
    }
  }
}

impl std::fmt::Display for GameError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for GameError {}

impl From<String> for GameError {
  fn from(message: String) -> Self {
    Self::new("io.error", message)
  }
}

impl From<&str> for GameError {
  fn from(message: &str) -> Self {
    Self::new("io.error", message)
  }
}

pub type GameResult<T> = Result<T, GameError>;

/// 稳定 code 常量，避免散落的字符串拼写漂移。
/// 部分常量留给 P2/P3（暂停、网络、协议升级），先保留稳定命名。
#[allow(dead_code)]
pub mod codes {
  pub const PACKAGE_NOT_FOUND: &str = "game.package_not_found";
  pub const PACKAGE_DISABLED: &str = "game.package_disabled";
  pub const MANIFEST_INVALID: &str = "game.manifest_invalid";
  pub const UNSUPPORTED_SCHEMA: &str = "game.unsupported_schema";
  pub const UNSUPPORTED_HOST_API: &str = "game.unsupported_host_api";
  pub const UNSUPPORTED_DISPLAY_POLICY: &str = "game.unsupported_display_policy";
  pub const UNSUPPORTED_AUTHORITY_MODE: &str = "game.unsupported_authority_mode";
  pub const INSTANCE_NOT_FOUND: &str = "game.instance_not_found";
  pub const INSTANCE_NOT_RUNNING: &str = "game.instance_not_running";
  pub const INSTANCE_LIMIT: &str = "game.instance_limit";
  pub const START_EXISTS: &str = "game.start_exists";
  pub const STATE_INCOMPATIBLE: &str = "game.state_incompatible";
  pub const AUTHORITY_NOT_OWNER: &str = "authority.not_owner";
  pub const AUTHORITY_EPOCH_MISMATCH: &str = "authority.epoch_mismatch";
  pub const AUTHORITY_LEASE_EXPIRED: &str = "authority.lease_expired";
  pub const AUTHORITY_TOKEN_INVALID: &str = "authority.token_invalid";
  pub const AUTHORITY_NOT_READY: &str = "authority.not_ready";
  pub const STATE_REVISION_CONFLICT: &str = "state.revision_conflict";
  pub const STATE_TOO_LARGE: &str = "state.too_large";
  pub const STATE_INVALID: &str = "state.invalid";
  pub const STATE_COMMIT_RATE_LIMITED: &str = "state.commit_rate_limited";
  pub const EVENT_TOO_LARGE: &str = "event.too_large";
  pub const EVENT_UNDECLARED_TYPE: &str = "event.undeclared_type";
  pub const COMMAND_UNKNOWN_TYPE: &str = "command.unknown_type";
  pub const COMMAND_INVALID_PAYLOAD: &str = "command.invalid_payload";
  pub const COMMAND_TIMEOUT: &str = "command.timeout";
  pub const COMMAND_RATE_LIMITED: &str = "command.rate_limited";
  pub const PERMISSION_DENIED: &str = "permission.denied";
  pub const PERMISSION_REVOKED: &str = "permission.revoked";
  pub const CONTROLLER_NOT_DECLARED: &str = "game.controller_not_declared";
  pub const CONTROLLER_NOT_INSTALLED: &str = "game.controller_not_installed";
  pub const CONTROLLER_DISABLED: &str = "game.controller_disabled";
  pub const CONTROLLER_UNKNOWN: &str = "game.controller_unknown";
  pub const CONTROLLER_NOT_ACTIVE: &str = "game.controller_not_active";
  pub const CONTROLLER_IN_USE: &str = "game.controller_in_use";
  pub const CONTROLLER_TARGET_MISMATCH: &str = "game.controller_target_mismatch";
  pub const CONTROLLER_NOT_TARGETED: &str = "game.controller_not_targeted";
  pub const CONTROLLER_READ_ONLY: &str = "game.controller_read_only";
  pub const COMMAND_NOT_ALLOWED: &str = "game.command_not_allowed";
  pub const COMMAND_NOT_GRANTED: &str = "game.command_not_granted";
  pub const PROTOCOL_UNSUPPORTED: &str = "protocol.unsupported";
  pub const REPLICA_LIMIT_REACHED: &str = "replica.limit_reached";
  pub const REPLICA_NOT_ATTACHED: &str = "replica.not_attached";
  pub const IO_ERROR: &str = "io.error";
  pub const NETWORK_ORIGIN_DENIED: &str = "network.origin_denied";
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn error_body_serializes_camel_case() {
    let body = GameError::new(codes::STATE_TOO_LARGE, "太大")
      .with_detail("bytes=2MiB")
      .body();
    let json = serde_json::to_value(body).expect("serialize");
    assert_eq!(json["code"], "state.too_large");
    assert_eq!(json["message"], "太大");
    assert_eq!(json["detail"], "bytes=2MiB");
  }

  #[test]
  fn detail_is_skipped_when_absent() {
    let json =
      serde_json::to_value(GameError::new(codes::IO_ERROR, "x").body()).expect("serialize");
    assert!(json.get("detail").is_none());
  }
}
