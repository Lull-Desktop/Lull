//! 归一化：把不同音源的能量映射到统一的 0–1 视觉刻度。
//!
//! 电平（`level.normalized`）使用 adaptive：相对当前包络 + 绝对参考混合，
//! 让雨声这类持续低能量环境音也能产生可见变化，又不会把底噪放大成满幅。
//!
//! 频段（`bands`）使用逐段 AGC：每个频段维护一个约 4s 的慢速平均参考，
//! 把「相对近期平均值 ±9 dB」映射到 0–1，再与绝对分量混合。纯绝对刻度会让
//! 音乐低频长期贴在 1.0（持续段落本来就在 -12 dBFS 附近），柱高只剩几像素
//! 变化；改到近期平均之上后，持续段落停在刻度中段，快节奏才有完整摆幅。
//! 为避免底噪被抬起来，平均值与输入都设有门限。
//!
//! 原始 RMS / Peak 不经过这里（RFC §8.3），只有 `normalized` 与 `bands` 使用。

use super::config::{
  Normalization, BAND_ABSOLUTE_SPAN, BAND_AGC_SPAN_DB, BAND_AVERAGE_TAU_MS, BAND_DB_PER_UNIT,
  BAND_MIN_AVERAGE, BAND_PRESENCE_FLOOR, BAND_RELATIVE_WEIGHT, FIXED_BAND_GAIN,
  LEVEL_ABSOLUTE_SPAN, LEVEL_ENVELOPE_DECAY_MS, LEVEL_FLOOR, LEVEL_MIN_SPAN,
};
use super::model::clamp01;

/// 单个标量的包络归一化器；只用于整体电平。
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeNormalizer {
  decay_ms: f64,
  floor: f64,
  min_span: f64,
  absolute_span: f64,
  envelope: f64,
  initialized: bool,
}

impl EnvelopeNormalizer {
  #[must_use]
  pub fn new(decay_ms: f64, floor: f64, min_span: f64, absolute_span: f64) -> Self {
    Self {
      decay_ms,
      floor,
      min_span,
      absolute_span,
      envelope: 0.0,
      initialized: false,
    }
  }

  #[must_use]
  pub fn level() -> Self {
    Self::new(
      LEVEL_ENVELOPE_DECAY_MS,
      LEVEL_FLOOR,
      LEVEL_MIN_SPAN,
      LEVEL_ABSOLUTE_SPAN,
    )
  }

  /// 输入原始值（0–1），返回归一化并乘过灵敏度的目标值（0–1）。
  ///
  /// `fixed_gain` 只在使用 `Normalization::Fixed` 时生效。
  pub fn normalize(
    &mut self,
    value: f64,
    dt_ms: f64,
    strategy: Normalization,
    sensitivity: f64,
    fixed_gain: f64,
  ) -> f64 {
    let value = clamp01(value);
    let target = match strategy {
      Normalization::Adaptive => {
        if !self.initialized {
          self.envelope = value;
          self.initialized = true;
        } else {
          let decay = (-dt_ms.max(0.0) / self.decay_ms.max(1.0)).exp();
          self.envelope = value.max(self.envelope * decay).clamp(0.0, 1.0);
        }
        let range = (self.envelope - self.floor).max(self.min_span);
        let relative = clamp01((value - self.floor) / range);
        let absolute = clamp01((value - self.floor) / self.absolute_span.max(0.001));
        0.7 * relative + 0.3 * absolute
      }
      Normalization::Fixed => value * fixed_gain,
    };

    clamp01(target * sensitivity.max(0.0))
  }
}

/// 五个频段各自的慢速平均参考（逐段 AGC）。
///
/// 每个频段独立维护 `averages[i]`，持续段落因此停在中段；`BAND_RELATIVE_WEIGHT`
/// 把「相对起伏」与「绝对响度」混合，既保留频段间的大致层级，又让快节奏音乐
/// 的五根柱子都有完整摆幅。
#[derive(Debug, Clone, Copy)]
pub struct BandNormalizers {
  averages: [f64; 5],
  initialized: bool,
}

impl BandNormalizers {
  #[must_use]
  pub fn new() -> Self {
    Self {
      averages: [0.0; 5],
      initialized: false,
    }
  }

  #[must_use]
  pub fn normalize(
    &mut self,
    values: [f64; 5],
    dt_ms: f64,
    strategy: Normalization,
    sensitivity: f64,
  ) -> [f64; 5] {
    let inputs = values.map(clamp01);
    let mut out = [0.0; 5];
    match strategy {
      Normalization::Fixed => {
        for (index, value) in inputs.iter().enumerate() {
          out[index] = clamp01(value * FIXED_BAND_GAIN * sensitivity.max(0.0));
        }
      }
      Normalization::Adaptive => {
        if !self.initialized {
          self.averages = inputs;
          self.initialized = true;
        } else {
          let alpha = 1.0 - (-dt_ms.max(0.0) / BAND_AVERAGE_TAU_MS.max(1.0)).exp();
          for (average, value) in self.averages.iter_mut().zip(inputs.iter()) {
            *average += (value - *average) * alpha;
          }
        }

        for (index, value) in inputs.iter().enumerate() {
          let average = self.averages[index].max(BAND_MIN_AVERAGE);
          let delta_db = (value - average) * BAND_DB_PER_UNIT;
          let relative = clamp01(0.5 + delta_db / BAND_AGC_SPAN_DB);
          let absolute = clamp01(value / BAND_ABSOLUTE_SPAN);
          let presence = clamp01(value / BAND_PRESENCE_FLOOR);
          let target = BAND_RELATIVE_WEIGHT * relative + (1.0 - BAND_RELATIVE_WEIGHT) * absolute;
          out[index] = clamp01(target * presence * sensitivity.max(0.0));
        }
      }
    }
    out
  }
}

impl Default for BandNormalizers {
  fn default() -> Self {
    Self::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::audio_reactive::config::{
    AudioReactiveConfig, FIXED_LEVEL_GAIN, SENSITIVITY, SMOOTHING,
  };

  fn config() -> AudioReactiveConfig {
    AudioReactiveConfig {
      sensitivity: SENSITIVITY,
      smoothing: SMOOTHING,
      ..AudioReactiveConfig::default()
    }
  }

  fn settle(normalizers: &mut BandNormalizers, values: [f64; 5], ticks: usize) -> [f64; 5] {
    let mut last = [0.0; 5];
    for _ in 0..ticks {
      last = normalizers.normalize(values, 50.0, Normalization::Adaptive, 1.0);
    }
    last
  }

  #[test]
  fn silence_stays_zero() {
    let mut normalizer = EnvelopeNormalizer::level();
    let value = normalizer.normalize(0.0, 50.0, Normalization::Adaptive, 1.0, FIXED_LEVEL_GAIN);
    assert_eq!(value, 0.0);
  }

  #[test]
  fn sustained_signal_converges_to_a_usable_level() {
    let mut normalizer = EnvelopeNormalizer::level();
    let mut last = 0.0;
    for _ in 0..100 {
      last = normalizer.normalize(0.2, 50.0, Normalization::Adaptive, 1.0, FIXED_LEVEL_GAIN);
    }
    // 0.7 * 1.0 + 0.3 * ((0.2-0.004)/0.5) ≈ 0.8176
    assert!((last - 0.8176).abs() < 0.01, "unexpected level: {last}");
    assert!((0.0..=1.0).contains(&last));
  }

  #[test]
  fn quiet_source_is_not_boosted_to_full_scale() {
    let mut normalizer = EnvelopeNormalizer::level();
    let mut last = 0.0;
    for _ in 0..100 {
      last = normalizer.normalize(0.02, 50.0, Normalization::Adaptive, 1.0, FIXED_LEVEL_GAIN);
    }
    assert!(last < 0.4, "quiet signal should stay restrained: {last}");
  }

  #[test]
  fn transient_decays_after_the_envelope_rises() {
    let mut normalizer = EnvelopeNormalizer::level();
    let high = normalizer.normalize(0.6, 50.0, Normalization::Adaptive, 1.0, FIXED_LEVEL_GAIN);
    let after = normalizer.normalize(0.1, 50.0, Normalization::Adaptive, 1.0, FIXED_LEVEL_GAIN);
    assert!(high > after);
  }

  #[test]
  fn fixed_strategy_uses_a_constant_gain() {
    let mut normalizer = EnvelopeNormalizer::level();
    let value = normalizer.normalize(0.2, 50.0, Normalization::Fixed, 1.0, FIXED_LEVEL_GAIN);
    assert!((value - 0.5).abs() < 0.001);
    let capped = normalizer.normalize(0.9, 50.0, Normalization::Fixed, 1.0, FIXED_LEVEL_GAIN);
    assert_eq!(capped, 1.0);
  }

  #[test]
  fn sensitivity_is_applied_and_clamped() {
    let mut normalizer = EnvelopeNormalizer::level();
    let value = normalizer.normalize(0.2, 50.0, Normalization::Fixed, 0.5, FIXED_LEVEL_GAIN);
    assert!((value - 0.25).abs() < 0.001);
    let value = normalizer.normalize(0.5, 50.0, Normalization::Fixed, 4.0, FIXED_LEVEL_GAIN);
    assert_eq!(value, 1.0);
  }

  #[test]
  fn sustained_bands_center_around_mid_scale() {
    let mut normalizers = BandNormalizers::new();
    let out = settle(&mut normalizers, [0.9, 0.7, 0.55, 0.4, 0.25], 100);
    for value in out {
      assert!(
        (0.35..=0.75).contains(&value),
        "sustained band should sit mid-scale: {out:?}"
      );
    }
    assert!(
      out[0] > out[4] + 0.15,
      "bands should keep a rough hierarchy: {out:?}"
    );
  }

  #[test]
  fn fast_transients_swing_visibly() {
    let mut normalizers = BandNormalizers::new();
    let mut min: [f64; 5] = [1.0; 5];
    let mut max: [f64; 5] = [0.0; 5];
    for tick in 0..40 {
      let values = if (tick / 5) % 2 == 0 {
        [0.9, 0.75, 0.6, 0.45, 0.3]
      } else {
        [0.55, 0.45, 0.4, 0.32, 0.25]
      };
      let out = normalizers.normalize(values, 50.0, Normalization::Adaptive, 1.0);
      for index in 0..5 {
        min[index] = min[index].min(out[index]);
        max[index] = max[index].max(out[index]);
      }
    }
    assert!(
      max[0] - min[0] > 0.35,
      "bass should swing: {min:?}..{max:?}"
    );
  }

  #[test]
  fn quiet_passage_falls_back_from_a_loud_section() {
    let mut normalizers = BandNormalizers::new();
    let loud = settle(&mut normalizers, [0.9, 0.7, 0.55, 0.4, 0.25], 50);
    let quiet = settle(&mut normalizers, [0.5, 0.4, 0.35, 0.3, 0.25], 10);
    assert!(loud[0] > 0.55, "loud section: {loud:?}");
    assert!(
      quiet[0] < loud[0] - 0.25,
      "quiet section should drop: {quiet:?} vs {loud:?}"
    );
  }

  #[test]
  fn silence_returns_to_zero() {
    let mut normalizers = BandNormalizers::new();
    settle(&mut normalizers, [0.8; 5], 5);
    let out = settle(&mut normalizers, [0.0; 5], 5);
    assert_eq!(out, [0.0; 5]);
  }

  #[test]
  fn quiet_bands_are_not_boosted_to_full_scale() {
    let mut normalizers = BandNormalizers::new();
    let out = settle(&mut normalizers, [0.15; 5], 100);
    for value in out {
      assert!(value < 0.5, "quiet bands should stay low: {out:?}");
    }
  }

  #[test]
  fn each_band_uses_its_own_average() {
    let mut normalizers = BandNormalizers::new();
    let out = settle(&mut normalizers, [0.8, 0.0, 0.0, 0.0, 0.0], 20);
    assert!(out[0] > 0.5, "bass should remain visible: {out:?}");
    for value in &out[1..] {
      assert_eq!(*value, 0.0);
    }
  }

  #[test]
  fn fixed_strategy_applies_a_constant_band_gain() {
    let mut normalizers = BandNormalizers::new();
    let out = normalizers.normalize([0.5; 5], 50.0, Normalization::Fixed, 1.0);
    for value in out {
      assert!((value - 0.6).abs() < 0.001);
    }
    let capped = normalizers.normalize([1.0; 5], 50.0, Normalization::Fixed, 4.0);
    assert_eq!(capped, [1.0; 5]);
  }

  #[test]
  fn config_is_readable_without_panicking() {
    let config = config();
    assert!(config.attack_ms() > 0.0);
  }
}
