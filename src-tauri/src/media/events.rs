//! `media:event` 订阅总线。
//!
//! Player、Noise、Output 都通过这里把状态变化发给已订阅窗口；各 domain 自己维护
//! revision，事件 envelope 的 revision 由调用方传入。Music library 的扫描事件仍走
//! `library/events.rs` 的全局广播，不混入本模块的订阅过滤。

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const MEDIA_EVENT: &str = "media:event";

const DEFAULT_TOPICS: &[&str] = &[
  "player.state",
  "player.progress",
  "player.level",
  "queue.changed",
  "noise.state",
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.track.state-changed",
  "noise.volume.changed",
  "noise.library.changed",
  "noise.level",
  "output.changed",
];

const ALLOWED_TOPICS: &[&str] = &[
  "player.state",
  "player.progress",
  "player.level",
  "queue.changed",
  "noise.state",
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.track.state-changed",
  "noise.volume.changed",
  "noise.library.changed",
  "noise.level",
  "output.changed",
];

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

static SUBSCRIBERS: OnceLock<Mutex<BTreeMap<String, Subscription>>> = OnceLock::new();

fn subscribers() -> &'static Mutex<BTreeMap<String, Subscription>> {
  SUBSCRIBERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn lock() -> MutexGuard<'static, BTreeMap<String, Subscription>> {
  subscribers().lock().unwrap_or_else(PoisonError::into_inner)
}

fn normalize_topics(topics: &[String]) -> BTreeMap<String, bool> {
  let mut selected = BTreeMap::new();
  for topic in topics {
    if ALLOWED_TOPICS.contains(&topic.as_str()) {
      selected.insert(topic.clone(), true);
    }
  }
  if selected.is_empty() {
    for topic in DEFAULT_TOPICS {
      selected.insert((*topic).to_string(), true);
    }
  }
  selected
}

pub fn register(label: &str, request: ConnectRequest) {
  let subscription = Subscription {
    topics: normalize_topics(&request.topics),
    progress_ms: request.progress_ms.unwrap_or(1000).clamp(250, 5000),
    levels: request.levels.unwrap_or(false),
  };
  lock().insert(label.to_string(), subscription);
}

pub fn disconnect(label: &str) {
  lock().remove(label);
}

pub fn remove(label: &str) {
  disconnect(label);
}

#[must_use]
pub fn any_levels() -> bool {
  lock().values().any(|subscription| subscription.levels)
}

#[must_use]
pub fn any_progress() -> bool {
  lock()
    .values()
    .any(|subscription| subscription.wants("player.progress"))
}

#[must_use]
pub fn min_progress_ms() -> u64 {
  lock()
    .values()
    .map(|subscription| subscription.progress_ms)
    .min()
    .unwrap_or(1000)
}

/// 发送给所有订阅了该 topic 的窗口；不存在的窗口由 Tauri 忽略。
pub fn emit(app: &AppHandle, topic: &str, revision: u64, payload: Value) {
  let event = envelope(topic, revision, payload);
  let labels: Vec<String> = lock()
    .iter()
    .filter(|(_, subscription)| subscription.wants(topic))
    .map(|(label, _)| label.clone())
    .collect();
  for label in labels {
    let _ = app.emit_to(label.as_str(), MEDIA_EVENT, &event);
  }
}

fn envelope(topic: &str, revision: u64, payload: Value) -> Value {
  json!({
    "protocol": 1,
    "topic": topic,
    "revision": revision,
    "at": crate::media::repository::now_ms(),
    "eventId": format!("{topic}:{revision}"),
    "payload": payload,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn topics_are_filtered_and_defaulted() {
    let selected = normalize_topics(&["noise.level".to_string(), "unknown".to_string()]);
    assert!(selected.contains_key("noise.level"));
    assert!(!selected.contains_key("unknown"));
    assert_eq!(selected.len(), 1);

    let defaults = normalize_topics(&[]);
    for topic in DEFAULT_TOPICS {
      assert!(defaults.contains_key(*topic));
    }
  }

  #[test]
  fn envelope_carries_event_id_and_revision() {
    let event = envelope("noise.state", 7, json!({ "ok": true }));
    assert_eq!(event["topic"], "noise.state");
    assert_eq!(event["revision"], 7);
    assert_eq!(event["eventId"], "noise.state:7");
    assert_eq!(event["payload"]["ok"], true);
  }
}
