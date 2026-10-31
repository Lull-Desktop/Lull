//! 媒体相关事件。
//!
//! 事件只传 id / 原因 / asset URL，不传帧；壁纸窗口已有 event listen 权限。

use tauri::{AppHandle, Emitter};

use super::diagnostics::{MediaChangedEvent, MediaDegradedEvent};

pub const MEDIA_CHANGED: &str = "media-changed";
pub const MEDIA_CONFIG_CHANGED: &str = "media-config-changed";
pub const MEDIA_DEGRADED: &str = "media-degraded";
pub const MEDIA_MASTER_VISIBLE: &str = "media-master-visible";
pub const MEDIA_RESYNC: &str = "media-resync";

pub fn emit_resync(app: &AppHandle, position_ms: u64) {
  let _ = app.emit(MEDIA_RESYNC, position_ms);
}

pub fn emit_changed(app: &AppHandle, session_ids: Vec<String>) {
  let _ = app.emit(MEDIA_CHANGED, MediaChangedEvent { session_ids });
}

pub fn emit_config_changed(app: &AppHandle) {
  let _ = app.emit(MEDIA_CONFIG_CHANGED, ());
}

pub fn emit_master_visible(app: &AppHandle, visible: bool) {
  let _ = app.emit(MEDIA_MASTER_VISIBLE, visible);
}

pub fn emit_degraded(app: &AppHandle, session_id: &str, asset_url: &str, reason: &str) {
  let _ = app.emit(
    MEDIA_DEGRADED,
    MediaDegradedEvent {
      session_id: session_id.to_string(),
      asset_url: asset_url.to_string(),
      reason: reason.to_string(),
    },
  );
}
