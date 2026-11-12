//! 媒体生命周期与壁纸窗口/显示拓扑的接线。
//!
//! 原则：窗口销毁只解绑 surface，不销毁 MediaSession；只有离开视频场景、
//! 配置切换到另一个资源、或应用退出才停止会话。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::engine::engine;

static TOKENS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn tokens() -> &'static Mutex<BTreeMap<String, String>> {
  TOKENS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn token_map() -> std::sync::MutexGuard<'static, BTreeMap<String, String>> {
  tokens()
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 为壁纸窗口生成顶层帧 token，并注入 `window.__LULL_MEDIA_TOKEN__`。
pub fn register_window(label: &str) -> String {
  let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or_default();
  let digest = Sha256::digest(format!("{label}:{}:{counter}:{now}", std::process::id()).as_bytes());
  let hex = format!("{digest:x}");
  let token = hex[..32].to_string();
  token_map().insert(label.to_string(), token.clone());
  token
}

pub fn remove_window(label: &str) {
  token_map().remove(label);
  engine().detach(label, None);
}

/// 页面重载/WebView 重建时清掉旧 surface；新页面会重新 attach。
pub fn on_page_loaded(label: &str) {
  engine().detach(label, None);
}

/// 拓扑重建：只解绑 surface，保留 Session，避免 Explorer 重启后重新解码。
pub fn on_topology_rebuild() {
  engine().detach_all_surfaces();
}

pub fn set_master_visible(visible: bool) {
  engine().set_master_visible(visible);
}

/// 场景/显示配置变化：只保留仍在视频显示器上的会话。
///
/// 切换单屏到非视频场景时，其它显示器如果仍是 `lull.video`，不能被误停；
/// 反过来，切走的显示器必须释放解码器/纹理流，不能留下后台播放开销。
pub fn on_display_config_changed() {
  let devices = crate::wallpaper::runtime::video_devices();
  engine().retain_video_devices(&devices);
}

/// 显示模式/同步拓扑变化：共享分组已变，全部会话重新建立。
pub fn on_display_layout_changed() {
  engine().stop_all();
}

pub fn shutdown() {
  engine().stop_all();
  token_map().clear();
}

/// 壁纸窗口的媒体命令鉴权；设置窗是受信控制面。
pub fn authorize(label: &str, token: Option<&str>) -> Result<(), String> {
  if label == "settings" {
    return Ok(());
  }
  if !label.starts_with("wallpaper-") {
    return Err("当前窗口没有媒体访问权限".to_string());
  }
  let expected = token_map()
    .get(label)
    .cloned()
    .ok_or_else(|| "壁纸窗口未注册媒体 token".to_string())?;
  match token {
    Some(actual) if actual == expected => Ok(()),
    _ => Err("媒体 token 无效".to_string()),
  }
}

/// 只读配置的控制面：设置窗与壁纸管理窗（`backdrop`）免 token。
///
/// `backdrop` 本来就能写配置（`media_config_set` / `media_activate`），给它读权限
/// 不扩大能力。会话类命令（open/attach/detach/degrade）仍走 [`authorize`]，
/// 库窗口不会意外创建或挂载 Surface。
pub fn authorize_control(label: &str, token: Option<&str>) -> Result<(), String> {
  if matches!(label, "settings" | "backdrop") {
    return Ok(());
  }
  authorize(label, token)
}

/// 当前壁纸窗口对应的显示器设备名。
#[must_use]
pub fn device_for_label(label: &str) -> Option<String> {
  crate::wallpaper::runtime::device_for_label(label)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn token_authorizes_wallpaper_and_rejects_others() {
    let token = register_window("wallpaper-test-token");
    assert!(authorize("wallpaper-test-token", Some(&token)).is_ok());
    assert!(authorize("wallpaper-test-token", Some("wrong")).is_err());
    assert!(authorize("widget-x", Some(&token)).is_err());
    assert!(authorize("settings", None).is_ok());
    remove_window("wallpaper-test-token");
    assert!(authorize("wallpaper-test-token", Some(&token)).is_err());
  }

  #[test]
  fn backdrop_is_trusted_for_config_reads_only() {
    // 壁纸管理窗口与设置窗同属受信控制面，读配置不需要 token。
    assert!(authorize_control("backdrop", None).is_ok());
    assert!(authorize_control("backdrop", Some("bogus")).is_ok());
    assert!(authorize_control("settings", None).is_ok());
    assert!(authorize_control("library", None).is_err());
    assert!(authorize_control("widget-x", None).is_err());
    // 会话类命令不放宽：库窗口仍不能 open/attach。
    assert!(authorize("backdrop", None).is_err());
  }
}
