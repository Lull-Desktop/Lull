//! 壁纸窗的音频订阅表。
//!
//! label 是 Tauri 窗口 label（`wallpaper-0`…）。订阅按窗口而不是按显示器记录：
//! 同一份分析结果定向发给每个壁纸窗，多显示器因此天然共享同一时间基准。
//!
//! 没有订阅者时 `source_union()` 为空，dispatcher 会让引擎停止分析。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use super::config::{AudioReactiveConfig, UPDATE_INTERVAL_MS};
use super::model::{AudioFeature, AudioSource};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
  pub sources: BTreeSet<AudioSource>,
  pub features: BTreeSet<AudioFeature>,
  pub interval_ms: u64,
}

impl Subscription {
  #[must_use]
  pub fn wants_bands(&self) -> bool {
    self.features.contains(&AudioFeature::Bands)
  }
}

static SUBSCRIBERS: OnceLock<Mutex<BTreeMap<String, Subscription>>> = OnceLock::new();

fn subscribers() -> &'static Mutex<BTreeMap<String, Subscription>> {
  SUBSCRIBERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn lock() -> MutexGuard<'static, BTreeMap<String, Subscription>> {
  subscribers().lock().unwrap_or_else(PoisonError::into_inner)
}

/// 未知来源被丢弃；空集合（或全部非法）回落到四来源全开。
#[must_use]
pub fn parse_sources(values: Option<&[String]>) -> BTreeSet<AudioSource> {
  let mut out = BTreeSet::new();
  if let Some(values) = values {
    for value in values {
      if let Some(source) = AudioSource::parse(value) {
        out.insert(source);
      }
    }
  }
  if out.is_empty() {
    out.extend(AudioSource::ALL);
  }
  out
}

/// 未知特征被丢弃；空集合回落到 P0 的 level/bands。
#[must_use]
pub fn parse_features(values: Option<&[String]>) -> BTreeSet<AudioFeature> {
  let mut out = BTreeSet::new();
  if let Some(values) = values {
    for value in values {
      if let Some(feature) = AudioFeature::parse(value) {
        out.insert(feature);
      }
    }
  }
  if out.is_empty() {
    out.insert(AudioFeature::Level);
    out.insert(AudioFeature::Bands);
  }
  out
}

pub fn register(
  label: &str,
  sources: BTreeSet<AudioSource>,
  features: BTreeSet<AudioFeature>,
  interval_ms: Option<u64>,
) {
  let subscription = Subscription {
    sources,
    features,
    interval_ms: AudioReactiveConfig::interval_ms_clamped(interval_ms),
  };
  lock().insert(label.to_string(), subscription);
}

/// 返回是否真的移除了订阅（用于决定是否需要重新对账引擎）。
pub fn remove(label: &str) -> bool {
  lock().remove(label).is_some()
}

pub fn clear() {
  lock().clear();
}

#[must_use]
pub fn is_empty() -> bool {
  lock().is_empty()
}

#[must_use]
pub fn labels() -> Vec<String> {
  lock().keys().cloned().collect()
}

#[must_use]
pub fn get(label: &str) -> Option<Subscription> {
  lock().get(label).cloned()
}

/// 所有订阅来源的并集，按 `AudioSource::ALL` 的稳定顺序返回。
#[must_use]
pub fn source_union() -> Vec<AudioSource> {
  let subscriptions = lock();
  AudioSource::ALL
    .into_iter()
    .filter(|source| {
      subscriptions
        .values()
        .any(|subscription| subscription.sources.contains(source))
    })
    .collect()
}

#[must_use]
pub fn wants_bands() -> bool {
  lock().values().any(Subscription::wants_bands)
}

/// 引擎 tick 取所有订阅中最小的间隔，保证没有订阅者被降频。
#[must_use]
pub fn min_interval_ms() -> u64 {
  lock()
    .values()
    .map(|subscription| subscription.interval_ms)
    .min()
    .filter(|interval| *interval > 0)
    .unwrap_or(UPDATE_INTERVAL_MS)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{Mutex, MutexGuard};

  /// 订阅表是进程级全局状态；测试串行化并清空，避免互相污染。
  static TEST_LOCK: Mutex<()> = Mutex::new(());

  fn reset() -> MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    clear();
    guard
  }

  #[test]
  fn defaults_cover_all_sources_and_core_features() {
    let _guard = reset();
    let sources = parse_sources(None);
    assert_eq!(sources.len(), 4);
    assert!(sources.contains(&AudioSource::Mix));
    let features = parse_features(None);
    assert!(features.contains(&AudioFeature::Level));
    assert!(features.contains(&AudioFeature::Bands));
    assert!(!features.contains(&AudioFeature::Spectrum));
  }

  #[test]
  fn unknown_values_are_dropped_and_empty_falls_back() {
    let _guard = reset();
    let sources = parse_sources(Some(&["music".to_string(), "unknown".to_string()]));
    assert_eq!(sources.len(), 1);
    let fallback = parse_sources(Some(&["unknown".to_string()]));
    assert_eq!(fallback.len(), 4);
    let features = parse_features(Some(&["waveform".to_string()]));
    assert_eq!(features.len(), 1);
    assert!(features.contains(&AudioFeature::Waveform));
  }

  #[test]
  fn registration_overwrites_and_removes_by_label() {
    let _guard = reset();
    register(
      "wallpaper-0",
      BTreeSet::from([AudioSource::Music]),
      BTreeSet::from([AudioFeature::Level]),
      Some(50),
    );
    assert_eq!(labels(), vec!["wallpaper-0".to_string()]);
    register(
      "wallpaper-0",
      BTreeSet::from([AudioSource::Noise]),
      BTreeSet::from([AudioFeature::Bands]),
      Some(100),
    );
    let subscription = get("wallpaper-0").expect("subscription");
    assert!(subscription.sources.contains(&AudioSource::Noise));
    assert!(!subscription.sources.contains(&AudioSource::Music));
    assert_eq!(subscription.interval_ms, 100);
    assert!(remove("wallpaper-0"));
    assert!(!remove("wallpaper-0"));
    assert!(is_empty());
  }

  #[test]
  fn union_is_ordered_and_deduplicated() {
    let _guard = reset();
    register(
      "wallpaper-1",
      BTreeSet::from([AudioSource::Master, AudioSource::Music]),
      BTreeSet::from([AudioFeature::Level]),
      Some(50),
    );
    register(
      "wallpaper-0",
      BTreeSet::from([AudioSource::Music, AudioSource::Noise]),
      BTreeSet::from([AudioFeature::Bands]),
      Some(100),
    );
    assert_eq!(
      source_union(),
      vec![AudioSource::Music, AudioSource::Noise, AudioSource::Master]
    );
    assert!(wants_bands());
    assert_eq!(min_interval_ms(), 50);
  }

  #[test]
  fn empty_registry_falls_back_to_default_interval() {
    let _guard = reset();
    assert_eq!(min_interval_ms(), UPDATE_INTERVAL_MS);
    assert!(source_union().is_empty());
    assert!(!wants_bands());
  }

  #[test]
  fn interval_is_clamped_to_supported_range() {
    let _guard = reset();
    register(
      "wallpaper-0",
      BTreeSet::from([AudioSource::Mix]),
      BTreeSet::from([AudioFeature::Level]),
      Some(1),
    );
    assert_eq!(get("wallpaper-0").expect("subscription").interval_ms, 50);
  }
}
