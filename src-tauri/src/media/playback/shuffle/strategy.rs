//! 算法层：把用户配置转换成评分、约束与概率。
//!
//! 纯函数式实现：不访问数据库、不持有轮次状态；Engine 负责提供剩余集合。

use std::collections::HashSet;

use super::context::{ShuffleCandidate, ShuffleContext};
use super::profile::SmartShuffleConfig;

/// log-score 的温度；越小越偏向高分。
const TAU: f64 = 0.5;
/// 收藏曲目的固定加成（不开放给用户）。
const FAVORITE_BOOST: f64 = 1.2;
/// 单因素下限，避免 `ln(0)`。
const MIN_FACTOR: f64 = 0.01;

/// 一次选曲的可调策略。
#[derive(Debug, Clone, Copy)]
pub struct ShuffleStrategy {
  hard_recent: usize,
  alpha: f64,
  recency_strength: f64,
  artist_window: usize,
  album_window: usize,
  genre_scale: f64,
}

impl ShuffleStrategy {
  #[must_use]
  pub fn from_config(config: &SmartShuffleConfig) -> Self {
    let randomness = config.experience.randomness.min(100);
    let ratio = f64::from(randomness) / 100.0;
    let repeat = config.experience.repeat_avoidance.min(100);
    Self {
      // 最近 N 首硬排除：0..4，和 randomness 无关。
      hard_recent: usize::try_from((repeat * 4 + 50) / 100).unwrap_or(0),
      alpha: ratio * ratio,
      recency_strength: f64::from(repeat) / 80.0,
      artist_window: usize::try_from(config.separation.artist.min(10)).unwrap_or(0),
      album_window: usize::try_from(config.separation.album.min(10)).unwrap_or(0),
      genre_scale: f64::from(config.experience.diversity.min(100)) / 50.0,
    }
  }

  #[cfg(test)]
  #[must_use]
  pub fn hard_recent(&self) -> usize {
    self.hard_recent
  }

  /// 按严格到宽松的候选层返回；Engine 取第一个非空层。
  ///
  /// 轮次「未播放」由 `remaining` 表达；这里只处理当前曲、近期硬窗口与
  /// 单曲/全近期等兜底。
  #[must_use]
  pub fn eligible_tiers<'a>(
    &self,
    context: &'a ShuffleContext,
    remaining: &HashSet<String>,
  ) -> Vec<Vec<&'a ShuffleCandidate>> {
    let current = context.current.as_deref();
    let mut strict = Vec::new();
    let mut relaxed = Vec::new();
    let mut fallback = Vec::new();
    for candidate in &context.candidates {
      if !remaining.contains(&candidate.id) {
        continue;
      }
      let recent_position = context
        .recent
        .iter()
        .position(|entry| entry.id == candidate.id);
      let is_current = current == Some(candidate.id.as_str());
      if !is_current {
        fallback.push(candidate);
        if recent_position.is_none_or(|position| position >= self.hard_recent) {
          strict.push(candidate);
        }
        relaxed.push(candidate);
      } else {
        fallback.push(candidate);
      }
    }
    let mut tiers = vec![strict];
    if self.hard_recent > 0 {
      tiers.push(relaxed);
    }
    // 单曲列表 / 所有候选都在近期窗口内时允许当前曲，避免无歌可选。
    tiers.push(fallback);
    tiers
  }

  /// 候选的对数评分；所有因子相乘转换为 log 相加。
  #[must_use]
  pub fn log_score(&self, candidate: &ShuffleCandidate, context: &ShuffleContext) -> f64 {
    let mut value = 0.0;
    if let Some(position) = context
      .recent
      .iter()
      .position(|entry| entry.id == candidate.id)
    {
      value += self.recency_factor(position).ln();
    }
    let Some(features) = candidate.features.as_ref() else {
      return value;
    };
    value += self.artist_factor(features, context);
    value += self.album_factor(features, context);
    value += self.genre_factor(features, context);
    if features.favorite {
      value += FAVORITE_BOOST.ln();
    }
    value
  }

  /// softmax + uniform 混合；返回值保证非负且和为 1。
  #[must_use]
  pub fn probabilities(
    &self,
    candidates: &[&ShuffleCandidate],
    context: &ShuffleContext,
  ) -> Vec<f64> {
    if candidates.is_empty() {
      return Vec::new();
    }
    let logs: Vec<f64> = candidates
      .iter()
      .map(|candidate| self.log_score(candidate, context))
      .collect();
    let max = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut weights: Vec<f64> = logs
      .iter()
      .map(|value| ((value - max) / TAU).exp())
      .collect();
    let total: f64 = weights.iter().sum();
    let count = f64::from(u32::try_from(candidates.len()).unwrap_or(u32::MAX));
    if !total.is_finite() || total <= f64::EPSILON {
      return vec![1.0 / count; candidates.len()];
    }
    let alpha = self.alpha.clamp(0.0, 1.0);
    for weight in &mut weights {
      *weight = (1.0 - alpha) * (*weight / total) + alpha / count;
    }
    weights
  }

  fn recency_factor(&self, position: usize) -> f64 {
    if position < self.hard_recent {
      return 0.02_f64.powf(self.recency_strength).max(MIN_FACTOR);
    }
    let offset = position - self.hard_recent;
    let base: f64 = match offset {
      0..=4 => 0.15,
      5..=12 => 0.5,
      13..=31 => 0.85,
      _ => 1.0,
    };
    base.powf(self.recency_strength).max(MIN_FACTOR)
  }

  fn artist_factor(
    &self,
    features: &super::context::TrackFeatures,
    context: &ShuffleContext,
  ) -> f64 {
    if self.artist_window == 0 || features.artists.is_empty() {
      return 0.0;
    }
    let hits = context
      .recent
      .iter()
      .take(self.artist_window)
      .filter(|entry| {
        entry.features.as_ref().is_some_and(|other| {
          other
            .artists
            .iter()
            .any(|artist| features.artists.contains(artist))
        })
      })
      .count();
    0.2_f64
      .powi(i32::try_from(hits).unwrap_or(i32::MAX))
      .max(MIN_FACTOR)
      .ln()
  }

  fn album_factor(
    &self,
    features: &super::context::TrackFeatures,
    context: &ShuffleContext,
  ) -> f64 {
    if self.album_window == 0 {
      return 0.0;
    }
    let Some(album) = features.album.as_deref() else {
      return 0.0;
    };
    let factor: f64 = if context
      .recent
      .first()
      .is_some_and(|entry| entry_album(entry).is_some_and(|value| value == album))
    {
      0.15
    } else if context
      .recent
      .iter()
      .take(self.album_window)
      .any(|entry| entry_album(entry).is_some_and(|value| value == album))
    {
      0.5
    } else {
      1.0
    };
    factor.max(MIN_FACTOR).ln()
  }

  fn genre_factor(
    &self,
    features: &super::context::TrackFeatures,
    context: &ShuffleContext,
  ) -> f64 {
    if self.genre_scale <= f64::EPSILON {
      return 0.0;
    }
    let Some(genre) = features.genre.as_deref() else {
      return 0.0;
    };
    let hits = context
      .recent
      .iter()
      .take(3)
      .filter(|entry| {
        entry
          .features
          .as_ref()
          .and_then(|other| other.genre.as_deref())
          == Some(genre)
      })
      .count();
    let hits = f64::from(u32::try_from(hits).unwrap_or(0));
    0.45_f64.powf(hits * self.genre_scale).max(MIN_FACTOR).ln()
  }
}

fn entry_album(entry: &super::context::RecentPlay) -> Option<&str> {
  entry
    .features
    .as_ref()
    .and_then(|value| value.album.as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::playback::shuffle::context::{
    RecentPlay, ShuffleCandidate, ShuffleContext, TrackFeatures,
  };
  use crate::media::playback::shuffle::profile::{
    SmartShuffleConfig, SmartShuffleExperience, SmartShuffleSeparation,
  };
  use std::collections::HashSet;

  fn feats(artists: &[&str], album: &str, genre: &str, favorite: bool) -> TrackFeatures {
    TrackFeatures {
      artists: artists.iter().map(|value| (*value).to_string()).collect(),
      album: Some(album.to_string()),
      genre: Some(genre.to_string()),
      favorite,
    }
  }

  fn candidate(id: &str, features: TrackFeatures) -> ShuffleCandidate {
    ShuffleCandidate {
      id: id.to_string(),
      features: Some(features),
    }
  }

  fn context(candidates: Vec<ShuffleCandidate>, recent: Vec<RecentPlay>) -> ShuffleContext {
    ShuffleContext {
      candidates,
      recent,
      current: None,
    }
  }

  fn recent(id: &str, features: TrackFeatures) -> RecentPlay {
    RecentPlay {
      id: id.to_string(),
      features: Some(features),
    }
  }

  fn config(
    randomness: u32,
    diversity: u32,
    repeat: u32,
    artist: u32,
    album: u32,
  ) -> SmartShuffleConfig {
    SmartShuffleConfig {
      experience: SmartShuffleExperience {
        randomness,
        diversity,
        repeat_avoidance: repeat,
      },
      separation: SmartShuffleSeparation { artist, album },
      ..SmartShuffleConfig::default()
    }
  }

  #[test]
  fn probabilities_are_normalized() {
    let strategy = ShuffleStrategy::from_config(&SmartShuffleConfig::default());
    let ctx = context(
      vec![
        candidate("a", feats(&["x"], "al", "g", false)),
        candidate("b", feats(&["y"], "al2", "g2", true)),
        candidate("c", feats(&["z"], "al3", "g3", false)),
      ],
      Vec::new(),
    );
    let list: Vec<&ShuffleCandidate> = ctx.candidates.iter().collect();
    let probabilities = strategy.probabilities(&list, &ctx);
    assert_eq!(probabilities.len(), 3);
    let sum: f64 = probabilities.iter().sum();
    assert!((sum - 1.0).abs() < 1e-9);
    assert!(probabilities.iter().all(|value| *value >= 0.0));
  }

  #[test]
  fn randomness_hundred_is_uniform() {
    let strategy = ShuffleStrategy::from_config(&config(100, 100, 100, 10, 10));
    let ctx = context(
      vec![
        candidate("a", feats(&["x"], "al", "g", false)),
        candidate("b", feats(&["x"], "al", "g", true)),
        candidate("c", feats(&["x"], "al", "g", false)),
      ],
      Vec::new(),
    );
    let list: Vec<&ShuffleCandidate> = ctx.candidates.iter().collect();
    let probabilities = strategy.probabilities(&list, &ctx);
    for value in probabilities {
      assert!((value - 1.0 / 3.0).abs() < 1e-9);
    }
  }

  #[test]
  fn hard_recent_window_survives_randomness_hundred() {
    let strategy = ShuffleStrategy::from_config(&config(100, 50, 100, 3, 2));
    let candidates = vec![
      candidate("a", feats(&["x"], "al", "g", false)),
      candidate("b", feats(&["y"], "al2", "g2", false)),
      candidate("c", feats(&["z"], "al3", "g3", false)),
    ];
    let recent = vec![
      recent("a", feats(&["x"], "al", "g", false)),
      recent("b", feats(&["y"], "al2", "g2", false)),
    ];
    let ctx = context(candidates, recent);
    let remaining: HashSet<String> = ["a", "b", "c"].iter().map(|id| (*id).to_string()).collect();
    let tiers = strategy.eligible_tiers(&ctx, &remaining);
    assert_eq!(tiers[0].len(), 1);
    assert_eq!(tiers[0][0].id, "c");
  }

  #[test]
  fn harder_repeat_avoidance_penalizes_soft_window_more() {
    let features = feats(&["x"], "al", "g", false);
    let mut recent_list: Vec<RecentPlay> = (0..8)
      .map(|index| recent(&format!("r{index}"), feats(&["y"], "al2", "g2", false)))
      .collect();
    // 把候选放到软窗口（位置 5）：repeatAvoidance 越高惩罚越强。
    recent_list[5] = recent("a", features.clone());
    let soft = context(vec![candidate("a", features)], recent_list);
    let weak = ShuffleStrategy::from_config(&config(60, 50, 0, 3, 2));
    let strong = ShuffleStrategy::from_config(&config(60, 50, 100, 3, 2));
    let candidate = &soft.candidates[0];
    assert!(strong.log_score(candidate, &soft) < weak.log_score(candidate, &soft));
  }

  #[test]
  fn audio_features_do_not_affect_probabilities() {
    let base = SmartShuffleConfig::default();
    let mut changed = base.clone();
    changed.audio_features.bpm_matching = 100;
    changed.audio_features.energy_matching = 0;
    changed.audio_features.mood_diversity = 100;
    changed.audio_features.genre_diversity = 0;
    let context = context(
      vec![
        candidate("a", feats(&["x"], "al", "g", false)),
        candidate("b", feats(&["y"], "al2", "g2", true)),
      ],
      Vec::new(),
    );
    let list: Vec<&ShuffleCandidate> = context.candidates.iter().collect();
    let first = ShuffleStrategy::from_config(&base).probabilities(&list, &context);
    let second = ShuffleStrategy::from_config(&changed).probabilities(&list, &context);
    assert_eq!(first, second);
  }

  #[test]
  fn single_candidate_falls_back_to_current() {
    let strategy = ShuffleStrategy::from_config(&SmartShuffleConfig::default());
    let ctx = ShuffleContext {
      candidates: vec![candidate("only", feats(&["x"], "al", "g", false))],
      recent: vec![recent("only", feats(&["x"], "al", "g", false))],
      current: Some("only".to_string()),
    };
    let remaining: HashSet<String> = ["only".to_string()].into_iter().collect();
    let tiers = strategy.eligible_tiers(&ctx, &remaining);
    assert!(tiers.iter().any(|tier| !tier.is_empty()));
    assert_eq!(tiers.last().unwrap()[0].id, "only");
  }
}
