//! 签名策略：默认宽松（未验签只警告），可在设置里开启「仅允许已验签」。
//!
//! 策略在 Rust 侧统一计算成 `allow / warn / block`，前端只消费结果，
//! 避免前后端各写一套判断。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const FILE_NAME: &str = "content-trust.json";

/// 策略变化后广播，设置页与扩展列表据此刷新。
pub const POLICY_CHANGED_EVENT: &str = "content-trust-changed";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustPolicy {
  /// true = 没有有效签名的包不能安装/启用；false（默认）= 只警告。
  pub require_signature: bool,
}

/// 状态 → 决策。`invalid/mismatch/revoked` 永远阻断；其余按严格开关。
#[must_use]
pub fn decision_for(status: &str, policy: &TrustPolicy) -> &'static str {
  match status {
    "verified" => "allow",
    "invalid" | "mismatch" | "revoked" => "block",
    _ if policy.require_signature => "block",
    _ => "warn",
  }
}

fn path(app: &AppHandle) -> PathBuf {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join(FILE_NAME))
    .unwrap_or_else(|_| PathBuf::from(FILE_NAME))
}

/// 读取策略；文件缺失/损坏 → 默认宽松（首启不应是错误）。
#[must_use]
pub fn load(app: &AppHandle) -> TrustPolicy {
  std::fs::read_to_string(path(app))
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

fn save(app: &AppHandle, policy: TrustPolicy) -> Result<(), String> {
  let path = path(app);
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_string_pretty(&policy).map_err(|error| error.to_string())?;
  std::fs::write(path, format!("{json}\n")).map_err(|error| error.to_string())
}

#[tauri::command]
#[must_use]
pub fn content_trust_policy_get(app: AppHandle) -> TrustPolicy {
  load(&app)
}

#[tauri::command]
pub fn content_trust_policy_set(
  app: AppHandle,
  require_signature: bool,
) -> Result<TrustPolicy, String> {
  let policy = TrustPolicy { require_signature };
  save(&app, policy)?;
  let _ = app.emit(POLICY_CHANGED_EVENT, policy);
  Ok(policy)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_is_permissive() {
    assert!(!TrustPolicy::default().require_signature);
  }

  #[test]
  fn decision_matrix() {
    let permissive = TrustPolicy::default();
    let strict = TrustPolicy {
      require_signature: true,
    };
    assert_eq!(decision_for("verified", &permissive), "allow");
    assert_eq!(decision_for("unsigned", &permissive), "warn");
    assert_eq!(decision_for("unknown-key", &permissive), "warn");
    assert_eq!(decision_for("invalid", &permissive), "block");
    assert_eq!(decision_for("mismatch", &permissive), "block");
    assert_eq!(decision_for("revoked", &permissive), "block");
    assert_eq!(decision_for("unsigned", &strict), "block");
    assert_eq!(decision_for("verified", &strict), "allow");
  }

  #[test]
  fn serde_uses_camel_case() {
    let json = serde_json::to_string(&TrustPolicy {
      require_signature: true,
    })
    .unwrap_or_default();
    assert_eq!(json, r#"{"requireSignature":true}"#);
  }
}
