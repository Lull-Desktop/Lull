//! 分发：把一份处理后的帧集合定向发给每个壁纸窗，并负责引擎分析的启停。
//!
//! 定向事件（`wallpaper-audio`）内容对多显示器完全相同；每个窗口只按自己的
//! 订阅来源裁剪。没有订阅者时向引擎下发空来源，停止分析。

use tauri::{AppHandle, Emitter};

use super::model::{AudioFrame, AudioFrameEnvelope, AudioStatus, AudioStatusEnvelope, AUDIO_EVENT};
use super::subscription::{self, Subscription};

/// 一个 tick 对某个订阅可见的帧集合。
#[must_use]
pub fn select_frames(subscription: &Subscription, frames: &[AudioFrame]) -> Vec<AudioFrame> {
  frames
    .iter()
    .filter(|frame| subscription.sources.contains(&frame.source))
    .cloned()
    .collect()
}

/// 按订阅表对账引擎：来源并集、是否需要频段、最小 tick 间隔。
pub fn sync_engine(app: &AppHandle) {
  let sources = subscription::source_union();
  let bands = subscription::wants_bands();
  let interval = subscription::min_interval_ms();
  let names: Vec<&str> = sources.iter().map(|source| source.as_str()).collect();
  crate::media::engine::send(
    app,
    crate::media::engine::audio_analyze(&names, bands, interval),
  );
  if sources.is_empty() {
    super::clear_latest();
  }
}

pub fn dispatch(app: &AppHandle, timestamp: u64, sequence: u64, frames: &[AudioFrame]) {
  if frames.is_empty() || !master_visible() {
    return;
  }
  for label in subscription::labels() {
    let Some(subscription) = subscription::get(&label) else {
      continue;
    };
    let selected = select_frames(&subscription, frames);
    if selected.is_empty() {
      continue;
    }
    let envelope = AudioFrameEnvelope::new(timestamp, sequence, selected);
    let _ = app.emit_to(label.as_str(), AUDIO_EVENT, envelope);
  }
}

pub fn broadcast_status(app: &AppHandle, status: AudioStatus) {
  for label in subscription::labels() {
    let envelope = AudioStatusEnvelope::new(status.clone());
    let _ = app.emit_to(label.as_str(), AUDIO_EVENT, envelope);
  }
}

/// 壁纸总开关关闭时不浪费跨 WebView 消息；恢复显示后会重新开始分发。
fn master_visible() -> bool {
  crate::wallpaper::runtime::config().map_or(true, |state| state.data.master_visible)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::audio_reactive::model::{AudioBands, AudioLevel, AudioSource, AUDIO_PROTOCOL};
  use std::collections::BTreeSet;

  fn frame(source: AudioSource) -> AudioFrame {
    AudioFrame {
      protocol: AUDIO_PROTOCOL,
      timestamp: 1,
      sequence: 1,
      source,
      active: true,
      level: AudioLevel {
        rms: 0.1,
        peak: 0.2,
        normalized: 0.3,
      },
      bands: AudioBands::silent(),
      spectrum: None,
      waveform: None,
    }
  }

  #[test]
  fn selection_respects_subscribed_sources() {
    let subscription = Subscription {
      sources: BTreeSet::from([AudioSource::Music, AudioSource::Mix]),
      features: BTreeSet::new(),
      interval_ms: 50,
    };
    let frames = [
      frame(AudioSource::Music),
      frame(AudioSource::Noise),
      frame(AudioSource::Mix),
    ];
    let selected = select_frames(&subscription, &frames);
    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].source, AudioSource::Music);
    assert_eq!(selected[1].source, AudioSource::Mix);
  }

  #[test]
  fn selection_can_be_empty() {
    let subscription = Subscription {
      sources: BTreeSet::from([AudioSource::Master]),
      features: BTreeSet::new(),
      interval_ms: 50,
    };
    assert!(select_frames(&subscription, &[frame(AudioSource::Music)]).is_empty());
  }
}
