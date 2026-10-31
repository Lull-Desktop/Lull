//! 资料库 revision 与 `media:event` 事件总线。
//!
//! 播放模块也发送 `media:event`，但资料库事件使用自己的 revision；订阅方按 topic
//! 区分，不依赖两个域之间的顺序。

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const MEDIA_EVENT: &str = "media:event";

static REVISION: AtomicU64 = AtomicU64::new(0);

#[must_use]
pub fn revision() -> u64 {
  REVISION.load(Ordering::SeqCst)
}

pub fn set_revision(value: u64) {
  REVISION.store(value, Ordering::SeqCst);
}

/// 递增 revision 并发送统一事件；数据库写盘失败只记日志，不阻断扫描/查询。
pub fn emit(app: &AppHandle, topic: &str, payload: Value) {
  let event = envelope(topic, payload);
  let revision = event["revision"].as_u64().unwrap_or_default();
  let _ = app.emit(MEDIA_EVENT, &event);
  tauri::async_runtime::spawn(async move {
    let Ok(pool) = super::pool() else {
      return;
    };
    if let Err(error) = sqlx::query(
      "UPDATE app_meta SET value = ? \
       WHERE key = 'revision' AND CAST(value AS INTEGER) < ?",
    )
    .bind(revision.to_string())
    .bind(i64::try_from(revision).unwrap_or(i64::MAX))
    .execute(pool)
    .await
    {
      crate::wallpaper::wlog(&format!("保存资料库 revision 失败：{error}"));
    }
  });
}

/// 高频事件只发内存，revision 的持久化留给 started/finished/changed。
pub fn emit_ephemeral(app: &AppHandle, topic: &str, payload: Value) {
  let _ = app.emit(MEDIA_EVENT, envelope(topic, payload));
}

fn envelope(topic: &str, payload: Value) -> Value {
  let revision = REVISION.fetch_add(1, Ordering::SeqCst) + 1;
  json!({
    "protocol": 1,
    "topic": topic,
    "revision": revision,
    "at": crate::media::repository::now_ms(),
    "payload": payload,
  })
}

pub fn changed(app: &AppHandle) {
  emit(app, "library.changed", Value::Null);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn revision_roundtrips() {
    set_revision(42);
    assert_eq!(revision(), 42);
    set_revision(0);
  }
}
