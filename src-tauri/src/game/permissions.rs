//! 参与者身份：窗口角色判定、逐窗口 token、Widget 能力校验。
//!
//! 身份只由窗口 label + 宿主注入的 token 决定；消息里的 `role` 不参与授权。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use super::error::{codes, GameError, GameResult};
use crate::widget_package;

pub const AUTHORITY_LABEL_PREFIX: &str = "game-authority-";
pub const WALLPAPER_LABEL_PREFIX: &str = "wallpaper-";
pub const WIDGET_LABEL_PREFIX: &str = "widget-";
pub const MANAGER_LABEL: &str = "settings";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowRole {
  Authority,
  Replica,
  Controller,
  Manager,
  Unknown,
}

/// authority 窗口 label 里的 instanceId；label 不合法返回 None。
#[must_use]
pub fn authority_instance_id(label: &str) -> Option<&str> {
  let rest = label.strip_prefix(AUTHORITY_LABEL_PREFIX)?;
  if rest.len() == 32 && rest.chars().all(|ch| ch.is_ascii_hexdigit()) {
    Some(rest)
  } else {
    None
  }
}

#[must_use]
pub fn widget_id(label: &str) -> Option<&str> {
  let id = label.strip_prefix(WIDGET_LABEL_PREFIX)?;
  if widget_package::manifest::valid_id(id) {
    Some(id)
  } else {
    None
  }
}

#[must_use]
pub fn role_of(label: &str) -> WindowRole {
  if label == MANAGER_LABEL {
    return WindowRole::Manager;
  }
  if authority_instance_id(label).is_some() {
    return WindowRole::Authority;
  }
  if label.starts_with(WALLPAPER_LABEL_PREFIX) {
    return WindowRole::Replica;
  }
  if widget_id(label).is_some() {
    return WindowRole::Controller;
  }
  WindowRole::Unknown
}

static WINDOW_TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn tokens() -> MutexGuard<'static, HashMap<String, String>> {
  WINDOW_TOKENS
    .get_or_init(|| Mutex::new(HashMap::new()))
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
}

/// 为壁纸窗 / 权威窗签发顶层帧 token。
pub fn issue_window_token(label: &str) -> String {
  let token = super::lease::random_token();
  tokens().insert(label.to_string(), token.clone());
  token
}

pub fn revoke_window_token(label: &str) {
  tokens().remove(label);
}

#[must_use]
pub fn verify_window_token(label: &str, token: Option<&str>) -> bool {
  let Some(token) = token.filter(|value| !value.is_empty()) else {
    return false;
  };
  tokens()
    .get(label)
    .is_some_and(|expected| expected == token)
}

pub fn require_window_token(label: &str, token: Option<&str>) -> GameResult<()> {
  if verify_window_token(label, token) {
    Ok(())
  } else {
    Err(GameError::new(
      codes::AUTHORITY_TOKEN_INVALID,
      "窗口 token 缺失或无效",
    ))
  }
}

/// Widget 控制器：桥 token 绑定窗口，能力以授权账本为准。
pub fn require_widget_controller(
  app: &tauri::AppHandle,
  label: &str,
  token: Option<&str>,
  capability: &str,
) -> GameResult<String> {
  let id = widget_id(label)
    .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "当前窗口不是 Widget 控制器"))?;
  if !widget_package::verify_bridge_token(label, token) {
    return Err(GameError::new(
      codes::PERMISSION_DENIED,
      "Widget 桥 token 无效",
    ));
  }
  widget_package::store::require_grant(app, id, capability)
    .map_err(|error| GameError::new(codes::PERMISSION_DENIED, error))?;
  Ok(id.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn roles_are_derived_from_labels_only() {
    assert_eq!(
      role_of("game-authority-0192f3a0000000000000000000000001"),
      WindowRole::Authority
    );
    assert_eq!(
      authority_instance_id("game-authority-0192f3a0000000000000000000000001"),
      Some("0192f3a0000000000000000000000001")
    );
    assert_eq!(role_of("wallpaper-1"), WindowRole::Replica);
    assert_eq!(role_of("widget-community-pomodoro"), WindowRole::Controller);
    assert_eq!(role_of("settings"), WindowRole::Manager);
    assert_eq!(role_of("library"), WindowRole::Unknown);
    assert_eq!(authority_instance_id("game-authority-bad"), None);
    assert_eq!(widget_id("widget-Bad"), None);
  }

  #[test]
  fn window_tokens_are_issued_verified_and_revoked() {
    let label = "wallpaper-token-test";
    let token = issue_window_token(label);
    assert!(verify_window_token(label, Some(&token)));
    assert!(!verify_window_token(label, Some("wrong")));
    assert!(!verify_window_token(label, None));
    revoke_window_token(label);
    assert!(!verify_window_token(label, Some(&token)));
  }
}
