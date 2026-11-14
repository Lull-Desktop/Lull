//! Lull Audio Reactive Service。
//!
//! 职责：接收 Media Engine 的原始测量，做归一化/平滑，维护壁纸窗订阅表，并把
//! 同一份 `AudioFrame` 定向分发给所有显示器。音频播放仍由 Media Service /
//! Media Engine 拥有；本模块只提供只读视觉信号。
//!
//! 数据流：Media Engine（20Hz 特征提取）→ `media_engine_event` →
//! 本模块（标准化 + 订阅 + 分发）→ Tauri `wallpaper-audio` → 壁纸页 → 场景 SDK。

pub(crate) mod commands;
mod config;
mod dispatcher;
mod model;
mod normalizer;
mod processor;
mod smoothing;
mod subscription;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use serde_json::Value;
use tauri::AppHandle;

use model::{
  AudioConnectRequest, AudioConnectResult, AudioSnapshot, AudioSource, AudioStatus,
  AudioStatusReason, EngineAudioFrame,
};
use processor::Processor;

static START: OnceLock<Instant> = OnceLock::new();
static ENGINE_AVAILABLE: AtomicBool = AtomicBool::new(false);
static PROCESSOR: OnceLock<Mutex<Processor>> = OnceLock::new();

fn processor() -> &'static Mutex<Processor> {
  PROCESSOR.get_or_init(|| Mutex::new(Processor::default()))
}

fn lock_processor() -> MutexGuard<'static, Processor> {
  processor().lock().unwrap_or_else(PoisonError::into_inner)
}

/// 服务自启动以来的单调毫秒；所有来源、所有显示器共享同一基准。
#[must_use]
pub fn monotonic_ms() -> u64 {
  let start = START.get_or_init(Instant::now);
  u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn current_status() -> AudioStatus {
  if ENGINE_AVAILABLE.load(Ordering::SeqCst) {
    AudioStatus::available()
  } else {
    AudioStatus::unavailable(AudioStatusReason::Inactive)
  }
}

/// 壁纸窗订阅：注册来源/特征，返回当前快照与状态。
pub fn connect(app: &AppHandle, label: &str, request: AudioConnectRequest) -> AudioConnectResult {
  let sources = subscription::parse_sources(request.sources.as_deref());
  let features = subscription::parse_features(request.features.as_deref());
  subscription::register(label, sources.clone(), features, request.interval_ms);
  dispatcher::sync_engine(app);

  let status = current_status();
  let snapshot = if status.available {
    lock_processor().latest(Some(&sources))
  } else {
    AudioSnapshot::empty(0)
  };
  AudioConnectResult { snapshot, status }
}

/// 壁纸窗退订；最后一个订阅消失时通知引擎停止分析。
pub fn disconnect(app: &AppHandle, label: &str) {
  if subscription::remove(label) {
    dispatcher::sync_engine(app);
  }
}

/// 引擎 ready（含设备切换后的页面重载）：恢复分析并广播状态。
pub fn on_engine_ready(app: &AppHandle) {
  ENGINE_AVAILABLE.store(true, Ordering::SeqCst);
  dispatcher::sync_engine(app);
  if !subscription::is_empty() {
    dispatcher::broadcast_status(app, AudioStatus::available());
  }
}

/// 引擎窗口销毁 / 应用退出：清空缓存并让订阅者进入 inactive。
pub fn on_engine_lost(app: &AppHandle) {
  on_engine_lost_with(app, AudioStatusReason::Inactive);
}

fn on_engine_lost_with(app: &AppHandle, reason: AudioStatusReason) {
  let was_available = ENGINE_AVAILABLE.swap(false, Ordering::SeqCst);
  clear_latest();
  if was_available || !subscription::is_empty() {
    dispatcher::broadcast_status(app, AudioStatus::unavailable(reason));
  }
}

/// 壁纸窗销毁：移除订阅，避免向不存在的窗口发送。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
  disconnect(app, label);
}

pub fn clear_latest() {
  lock_processor().clear();
}

pub fn shutdown() {
  subscription::clear();
  clear_latest();
  ENGINE_AVAILABLE.store(false, Ordering::SeqCst);
}

/// 解析引擎 `audio.frame` 事件；对来源数量做上限校验，避免异常批量放大。
fn parse_engine_frames(event: &Value) -> Result<Vec<EngineAudioFrame>, String> {
  let raw = event
    .get("frames")
    .cloned()
    .unwrap_or_else(|| Value::Array(Vec::new()));
  let frames: Vec<EngineAudioFrame> =
    serde_json::from_value(raw).map_err(|error| format!("解析音频帧失败：{error}"))?;
  if frames.len() > AudioSource::ALL.len() {
    return Err("音频帧数量超过来源上限".to_string());
  }
  Ok(frames)
}

/// `media-engine` 的 `audio.*` 事件入口。
///
/// 返回错误只会被引擎页的 `send()` 忽略并记日志，不影响 player/noise 事件。
pub fn ingest_engine_event(app: &AppHandle, event: &Value) -> Result<(), String> {
  match event.get("type").and_then(Value::as_str) {
    Some("audio.frame") => {
      let frames = parse_engine_frames(event)?;
      // 无订阅者时引擎应已停止；即使收到残留帧，也不做无谓的分析与分发。
      if subscription::is_empty() || frames.is_empty() {
        return Ok(());
      }
      let timestamp = monotonic_ms();
      let tick = lock_processor().ingest(&frames, timestamp);
      if let Some((sequence, processed)) = tick {
        dispatcher::dispatch(app, timestamp, sequence, &processed);
      }
      Ok(())
    }
    Some("audio.status") => {
      let available = event
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
      if available {
        on_engine_ready(app);
      } else {
        let reason = match event.get("reason").and_then(Value::as_str) {
          Some("not-supported") => AudioStatusReason::NotSupported,
          _ => AudioStatusReason::Inactive,
        };
        on_engine_lost_with(app, reason);
      }
      Ok(())
    }
    Some(other) => Err(format!("未知音频事件：{other}")),
    None => Err("音频事件缺少 type".to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parses_engine_frames_and_keeps_optional_band_defaults() {
    let event = json!({
      "type": "audio.frame",
      "frames": [
        {
          "source": "music",
          "active": true,
          "level": { "rms": 0.1, "peak": 0.2 },
          "bands": { "bass": 0.1, "lowMid": 0.2, "mid": 0.3, "highMid": 0.4, "treble": 0.5 }
        }
      ]
    });
    let frames = parse_engine_frames(&event).expect("parse frames");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].source, AudioSource::Music);
  }

  #[test]
  fn rejects_more_frames_than_sources() {
    let frames: Vec<Value> = (0..5)
      .map(|_| {
        json!({
          "source": "music",
          "active": true,
          "level": { "rms": 0.1, "peak": 0.2 },
          "bands": { "bass": 0.1, "lowMid": 0.2, "mid": 0.3, "highMid": 0.4, "treble": 0.5 }
        })
      })
      .collect();
    let event = json!({ "type": "audio.frame", "frames": frames });
    assert!(parse_engine_frames(&event).is_err());
  }

  #[test]
  fn missing_frames_is_empty_not_an_error() {
    let event = json!({ "type": "audio.frame" });
    assert!(parse_engine_frames(&event).expect("empty").is_empty());
  }

  #[test]
  fn unknown_source_is_rejected() {
    let event = json!({
      "type": "audio.frame",
      "frames": [{
        "source": "microphone",
        "level": { "rms": 0.1, "peak": 0.2 },
        "bands": { "bass": 0.1, "lowMid": 0.2, "mid": 0.3, "highMid": 0.4, "treble": 0.5 }
      }]
    });
    assert!(parse_engine_frames(&event).is_err());
  }

  #[test]
  fn monotonic_clock_never_goes_backwards() {
    let first = monotonic_ms();
    let second = monotonic_ms();
    assert!(second >= first);
  }
}
