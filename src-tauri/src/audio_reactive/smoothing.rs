//! 视觉平滑：attack 快、release 慢的 one-pole 滤波器。
//!
//! 20Hz 数据直接驱动渲染会出现阶梯感；Rust 侧统一平滑一次，场景侧再按自身
//! 帧率做一次插值（RFC §8.2/§8.3）。原始 RMS / Peak 不经过本模块。

use super::model::clamp01;

#[derive(Debug, Clone, Copy, Default)]
pub struct Smoother {
  value: f64,
  initialized: bool,
}

impl Smoother {
  #[must_use]
  pub fn new() -> Self {
    Self::default()
  }

  /// 向 `target` 逼近一步；首个样本直接对齐，避免上电时从 0 缓慢爬升。
  pub fn step(&mut self, target: f64, dt_ms: f64, attack_ms: f64, release_ms: f64) -> f64 {
    let target = clamp01(target);
    if !self.initialized {
      self.value = target;
      self.initialized = true;
      return self.value;
    }
    let tau = if target > self.value {
      attack_ms
    } else {
      release_ms
    };
    let alpha = if tau <= 0.0 {
      1.0
    } else {
      1.0 - (-dt_ms.max(0.0) / tau).exp()
    };
    self.value = clamp01(self.value + (target - self.value) * alpha);
    self.value
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn first_sample_snaps_to_target() {
    let mut smoother = Smoother::new();
    assert_eq!(smoother.step(0.6, 50.0, 80.0, 280.0), 0.6);
  }

  #[test]
  fn attack_is_faster_than_release() {
    let mut rising = Smoother::new();
    rising.step(0.0, 50.0, 80.0, 280.0);
    let up = rising.step(1.0, 50.0, 80.0, 280.0);

    let mut falling = Smoother::new();
    falling.step(1.0, 50.0, 80.0, 280.0);
    let down = falling.step(0.0, 50.0, 80.0, 280.0);

    let rise = up - 0.0;
    let fall = 1.0 - down;
    assert!(rise > fall, "attack should move faster than release");
  }

  #[test]
  fn converges_toward_target_without_overshoot() {
    let mut smoother = Smoother::new();
    smoother.step(0.0, 50.0, 80.0, 280.0);
    let mut last = 0.0;
    for _ in 0..200 {
      last = smoother.step(0.7, 50.0, 80.0, 280.0);
      assert!((0.0..=0.7).contains(&last));
    }
    assert!((last - 0.7).abs() < 0.01);
  }

  #[test]
  fn invalid_targets_are_clamped() {
    let mut high = Smoother::new();
    assert_eq!(high.step(4.0, 50.0, 80.0, 280.0), 1.0);
    let mut nan = Smoother::new();
    assert_eq!(nan.step(f64::NAN, 50.0, 80.0, 280.0), 0.0);
  }
}
