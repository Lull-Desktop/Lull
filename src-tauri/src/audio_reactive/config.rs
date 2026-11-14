//! Audio Reactive 的默认参数与归一化策略。
//!
//! P0 参数固定：20Hz、sensitivity 1.0、平滑 0.35、adaptive 归一化。
//! P1 会把这里接到设置面板与 `display.json` 持久化；因此字段先集中在本文件，
//! 避免散落在 processor / dispatcher 里。

use serde::Deserialize;

/// 数据更新频率：20Hz。与现有媒体电平订阅一致，不引入更高频的跨 WebView 消息。
pub const UPDATE_INTERVAL_MS: u64 = 50;
pub const MIN_INTERVAL_MS: u64 = 50;
pub const MAX_INTERVAL_MS: u64 = 200;

/// 视觉响应灵敏度；P0 固定 1.0。
pub const SENSITIVITY: f64 = 1.0;
/// 平滑程度 0–1；0.35 → attack ≈82ms、release ≈281ms。
pub const SMOOTHING: f64 = 0.35;

/// 电平归一化：低于该值视为静音底噪。
pub const LEVEL_FLOOR: f64 = 0.004;
/// 自适应归一化允许的最小包络跨度，避免把极安静信号放大成满幅。
pub const LEVEL_MIN_SPAN: f64 = 0.04;
/// 绝对分量的满幅参考（约 -6 dBFS RMS）。
pub const LEVEL_ABSOLUTE_SPAN: f64 = 0.5;
/// 包络衰减时间常数：跟随当前峰值、缓慢回落。
pub const LEVEL_ENVELOPE_DECAY_MS: f64 = 2000.0;

/// 频段 AGC 的平均参考时间常数：约 4s。跟随段落响度，不追每个鼓点；
/// 持续段落停在刻度中段，快节奏变化才有可见的上下起伏。
pub const BAND_AVERAGE_TAU_MS: f64 = 4000.0;
/// 视觉动态范围：相对近期平均值的 ±9 dB 映射到 0–1（总跨度 18 dB）。
pub const BAND_AGC_SPAN_DB: f64 = 18.0;
/// 引擎把频段 dB 映射到 0–1 时的跨度（-70…-6 dBFS），用于值差换算 dB。
pub const BAND_DB_PER_UNIT: f64 = 64.0;
/// 平均参考下限：避免极安静时把底噪放大成满幅。
pub const BAND_MIN_AVERAGE: f64 = 0.04;
/// 绝对分量满幅参考；保留整体响度层级，不完全是逐段自动增益。
pub const BAND_ABSOLUTE_SPAN: f64 = 0.95;
/// 相对 / 绝对权重：相对分量负责“起伏”，绝对分量保留“这一句有多响”。
pub const BAND_RELATIVE_WEIGHT: f64 = 0.65;
/// 静音门限：低于该值按比例淡出，避免底噪把柱子顶到中段。
pub const BAND_PRESENCE_FLOOR: f64 = 0.12;

pub const FIXED_LEVEL_GAIN: f64 = 2.5;
/// 频段已是对数刻度，固定增益接近 1 才不会一开就满幅。
pub const FIXED_BAND_GAIN: f64 = 1.2;

/// 平滑基准：attack 更快、release 更慢，避免视觉抖动。
pub const BASE_ATTACK_MS: f64 = 40.0;
pub const ATTACK_SMOOTHING_MS: f64 = 120.0;
pub const BASE_RELEASE_MS: f64 = 120.0;
pub const RELEASE_SMOOTHING_MS: f64 = 460.0;

/// 频段使用明显更快的 attack/release：快速鼓点需要在一拍内回落，
/// 而整体呼吸/雾效仍用上面的慢参数。默认 smoothing=0.35 → 约 41/130ms。
pub const BAND_BASE_ATTACK_MS: f64 = 20.0;
pub const BAND_ATTACK_SMOOTHING_MS: f64 = 60.0;
pub const BAND_BASE_RELEASE_MS: f64 = 60.0;
pub const BAND_RELEASE_SMOOTHING_MS: f64 = 200.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Normalization {
  /// 相对包络 + 绝对分量混合（默认）：不同音源都能产生可用的动态。
  Adaptive,
  /// 固定增益；P1 设置面板启用后才会被构造。
  Fixed,
}

impl Default for Normalization {
  fn default() -> Self {
    Self::Adaptive
  }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioReactiveConfig {
  pub interval_ms: u64,
  pub sensitivity: f64,
  pub smoothing: f64,
  pub normalization: Normalization,
}

impl Default for AudioReactiveConfig {
  fn default() -> Self {
    Self {
      interval_ms: UPDATE_INTERVAL_MS,
      sensitivity: SENSITIVITY,
      smoothing: SMOOTHING,
      normalization: Normalization::default(),
    }
  }
}

impl AudioReactiveConfig {
  #[must_use]
  pub fn attack_ms(&self) -> f64 {
    BASE_ATTACK_MS + ATTACK_SMOOTHING_MS * self.smoothing
  }

  #[must_use]
  pub fn release_ms(&self) -> f64 {
    BASE_RELEASE_MS + RELEASE_SMOOTHING_MS * self.smoothing
  }

  /// 频段专用的快 attack；`smoothing` 仍会影响，但基准比整体电平短。
  #[must_use]
  pub fn band_attack_ms(&self) -> f64 {
    BAND_BASE_ATTACK_MS + BAND_ATTACK_SMOOTHING_MS * self.smoothing
  }

  /// 频段专用的快 release；约 130ms 才能让快速鼓点在下一拍前回落。
  #[must_use]
  pub fn band_release_ms(&self) -> f64 {
    BAND_BASE_RELEASE_MS + BAND_RELEASE_SMOOTHING_MS * self.smoothing
  }

  #[must_use]
  pub fn interval_ms_clamped(value: Option<u64>) -> u64 {
    value
      .unwrap_or(UPDATE_INTERVAL_MS)
      .clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn smoothing_defaults_stay_in_the_expected_visual_range() {
    let config = AudioReactiveConfig::default();
    assert_eq!(config.interval_ms, 50);
    assert!((config.attack_ms() - 82.0).abs() < 0.001);
    assert!((config.release_ms() - 281.0).abs() < 0.001);
    assert!((config.band_attack_ms() - 41.0).abs() < 0.001);
    assert!((config.band_release_ms() - 130.0).abs() < 0.001);
    assert!(config.band_release_ms() < config.release_ms());
    assert_eq!(config.normalization, Normalization::Adaptive);
  }

  #[test]
  fn interval_is_clamped_to_supported_range() {
    assert_eq!(AudioReactiveConfig::interval_ms_clamped(None), 50);
    assert_eq!(AudioReactiveConfig::interval_ms_clamped(Some(1)), 50);
    assert_eq!(AudioReactiveConfig::interval_ms_clamped(Some(1000)), 200);
  }
}
