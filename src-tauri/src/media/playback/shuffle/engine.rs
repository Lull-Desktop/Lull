//! 引擎层：候选选择、轮次袋与上一首/重置。
//!
//! 纯状态机：不访问数据库、不直接播放；`playback` 负责提供上下文并提交结果。

use std::collections::HashSet;

use super::context::{ShuffleContext, Source};
use super::strategy::ShuffleStrategy;

/// 一次待播放的选择；`play` 成功前不能真正消耗轮次名额。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
  pub id: String,
  removed_from_remaining: bool,
}

/// 智能随机引擎。
#[derive(Debug)]
pub struct ShuffleEngine {
  source: Option<Source>,
  known: HashSet<String>,
  remaining: HashSet<String>,
  played: HashSet<String>,
  history: Vec<String>,
  cursor: usize,
  rng: SmartRng,
  pending: Option<Selection>,
}

impl ShuffleEngine {
  #[must_use]
  pub fn new(seed: u64) -> Self {
    Self {
      source: None,
      known: HashSet::new(),
      remaining: HashSet::new(),
      played: HashSet::new(),
      history: Vec::new(),
      cursor: 0,
      rng: SmartRng::seeded(seed),
      pending: None,
    }
  }

  /// 让轮次袋与最新候选列表对齐；由 `setAdvanceList` / 队列变化显式调用。
  pub fn update_tracks(&mut self, source: Source, tracks: &[String], _current: Option<&str>) {
    let set: HashSet<String> = tracks.iter().cloned().collect();
    let reset = self.source != Some(source)
      || self.known.is_empty()
      || !(set.is_superset(&self.known) || set.is_subset(&self.known));
    if reset {
      self.start_new_round(source, &set);
      return;
    }

    let previous = &self.known;
    for id in &set {
      if !previous.contains(id) && !self.played.contains(id) {
        self.remaining.insert(id.clone());
      }
    }
    self.remaining.retain(|id| set.contains(id));
    self.known = set;
    if self.remaining.is_empty() {
      let known = self.known.clone();
      self.start_new_round(source, &known);
    }
  }

  /// 按严格到宽松的候选层抽一首；返回的 Selection 需 commit/abort。
  pub fn next(
    &mut self,
    strategy: &ShuffleStrategy,
    context: &ShuffleContext,
  ) -> Option<Selection> {
    self.pending = None;
    for _ in 0..2 {
      let tiers = strategy.eligible_tiers(context, &self.remaining);
      for tier in tiers {
        if tier.is_empty() {
          continue;
        }
        let probabilities = strategy.probabilities(&tier, context);
        let index = self.pick_index(&probabilities)?;
        let id = tier.get(index)?.id.clone();
        let removed_from_remaining = self.remaining.remove(&id);
        let selection = Selection {
          id,
          removed_from_remaining,
        };
        self.pending = Some(selection.clone());
        return Some(selection);
      }
      if self.remaining.is_empty() {
        let known = self.known.clone();
        self.start_new_round(self.source.unwrap_or(Source::Advance), &known);
        continue;
      }
      break;
    }
    None
  }

  /// 播放成功：真正消耗名额并写入历史。
  pub fn commit(&mut self, selection: Selection) {
    if self.pending.as_ref() != Some(&selection) {
      return;
    }
    self.pending = None;
    self.remaining.remove(&selection.id);
    if self.known.contains(&selection.id) {
      self.played.insert(selection.id.clone());
    }
    self.push_history(selection.id);
  }

  /// 播放失败：把预占的候选放回本轮。
  pub fn abort(&mut self, selection: Selection) {
    if self.pending.as_ref() != Some(&selection) {
      return;
    }
    self.pending = None;
    if selection.removed_from_remaining {
      self.remaining.insert(selection.id);
    }
  }

  /// 返回历史栈中的上一首；不改变轮次名额。
  #[must_use]
  pub fn previous(&mut self) -> Option<String> {
    if self.cursor == 0 {
      return None;
    }
    self.cursor -= 1;
    self.history.get(self.cursor).cloned()
  }

  /// 上一首播放后调用：把重新成为当前曲的曲目移出本轮剩余。
  pub fn note_current(&mut self, id: &str) {
    if self.known.contains(id) {
      self.remaining.remove(id);
    }
  }

  /// 用户手动点播一首：消耗本轮名额并写入历史。
  pub fn on_external_play(&mut self, id: &str) {
    if self.known.contains(id) {
      self.remaining.remove(id);
      self.played.insert(id.to_string());
    }
    self.push_history(id.to_string());
  }

  /// 离开随机模式或显式重开轮次。
  pub fn reset(&mut self) {
    self.source = None;
    self.known.clear();
    self.remaining.clear();
    self.played.clear();
    self.history.clear();
    self.cursor = 0;
    self.pending = None;
  }

  #[cfg(test)]
  #[must_use]
  pub fn remaining_len(&self) -> usize {
    self.remaining.len()
  }

  #[cfg(test)]
  #[must_use]
  pub fn contains_remaining(&self, id: &str) -> bool {
    self.remaining.contains(id)
  }

  fn start_new_round(&mut self, source: Source, set: &HashSet<String>) {
    self.source = Some(source);
    self.known = set.clone();
    self.played.clear();
    self.pending = None;
    self.remaining = set.clone();
  }

  fn push_history(&mut self, id: String) {
    self.history.truncate(self.cursor + 1);
    if self.history.last() != Some(&id) {
      self.history.push(id);
    }
    self.cursor = self.history.len().saturating_sub(1);
  }

  fn pick_index(&mut self, probabilities: &[f64]) -> Option<usize> {
    if probabilities.is_empty() {
      return None;
    }
    let total: f64 = probabilities.iter().sum();
    if !total.is_finite() || total <= f64::EPSILON {
      return Some(self.rng.below(probabilities.len()));
    }
    let mut roll = self.rng.unit() * total;
    for (index, value) in probabilities.iter().enumerate() {
      roll -= value;
      if roll <= 0.0 {
        return Some(index);
      }
    }
    probabilities.len().checked_sub(1)
  }
}

/// SplitMix64：足够好的本地随机源，避免为选曲引入额外依赖。
#[derive(Debug, Clone)]
pub struct SmartRng {
  state: u64,
}

impl SmartRng {
  #[must_use]
  pub fn seeded(seed: u64) -> Self {
    Self {
      state: seed ^ 0x9E37_79B9_7F4A_7C15,
    }
  }

  /// 返回 `[0, 1)` 的浮点数。
  #[must_use]
  pub fn unit(&mut self) -> f64 {
    let bits = u32::try_from(self.next_u64() >> 40).unwrap_or(0);
    f64::from(bits) / f64::from(1_u32 << 24)
  }

  fn below(&mut self, upper: usize) -> usize {
    if upper == 0 {
      return 0;
    }
    let bound = u64::try_from(upper).unwrap_or(u64::MAX);
    usize::try_from(self.next_u64() % bound).unwrap_or(0)
  }

  fn next_u64(&mut self) -> u64 {
    self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut value = self.state;
    value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::playback::shuffle::context::{ShuffleCandidate, ShuffleContext, TrackFeatures};
  use crate::media::playback::shuffle::profile::SmartShuffleConfig;

  fn ids(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("track-{index}")).collect()
  }

  fn candidate(id: &str) -> ShuffleCandidate {
    ShuffleCandidate {
      id: id.to_string(),
      features: Some(TrackFeatures::default()),
    }
  }

  fn context(candidates: Vec<String>) -> ShuffleContext {
    ShuffleContext {
      candidates: candidates.into_iter().map(|id| candidate(&id)).collect(),
      recent: Vec::new(),
      current: None,
    }
  }

  fn strategy() -> ShuffleStrategy {
    ShuffleStrategy::from_config(&SmartShuffleConfig::default())
  }

  #[test]
  fn round_covers_every_track_once() {
    let tracks = ids(20);
    let mut engine = ShuffleEngine::new(42);
    engine.update_tracks(Source::Advance, &tracks, None);
    let ctx = context(tracks.clone());
    let mut seen = HashSet::new();
    for _ in 0..tracks.len() {
      let selection = engine.next(&strategy(), &ctx).expect("selection");
      assert!(seen.insert(selection.id.clone()));
      engine.commit(selection);
    }
    assert_eq!(seen.len(), tracks.len());
    assert_eq!(engine.remaining_len(), 0);
  }

  #[test]
  fn abort_restores_remaining() {
    let tracks = ids(3);
    let mut engine = ShuffleEngine::new(7);
    engine.update_tracks(Source::Advance, &tracks, None);
    let ctx = context(tracks.clone());
    let selection = engine.next(&strategy(), &ctx).expect("selection");
    let remaining = engine.remaining_len();
    engine.abort(selection);
    assert_eq!(engine.remaining_len(), remaining + 1);
  }

  #[test]
  fn previous_uses_history_stack() {
    let tracks = ids(5);
    let mut engine = ShuffleEngine::new(11);
    engine.update_tracks(Source::Advance, &tracks, None);
    let ctx = context(tracks.clone());
    let first = engine.next(&strategy(), &ctx).expect("first");
    engine.commit(first.clone());
    let second = engine.next(&strategy(), &ctx).expect("second");
    engine.commit(second);
    assert_eq!(engine.previous().as_deref(), Some(first.id.as_str()));
    assert_eq!(engine.previous(), None);
  }

  #[test]
  fn update_tracks_keeps_cycle_for_superset_and_resets_disjoint() {
    let mut engine = ShuffleEngine::new(3);
    engine.update_tracks(Source::Advance, &ids(3), None);
    let ctx = context(ids(3));
    let selection = engine.next(&strategy(), &ctx).expect("selection");
    engine.commit(selection);
    assert_eq!(engine.remaining_len(), 2);

    let mut extended = ids(3);
    extended.push("track-9".to_string());
    engine.update_tracks(Source::Advance, &extended, None);
    assert_eq!(engine.remaining_len(), 3);

    engine.update_tracks(Source::Advance, &["x".to_string(), "y".to_string()], None);
    assert_eq!(engine.remaining_len(), 2);
  }

  #[test]
  fn external_play_consumes_round_slot() {
    let tracks = ids(3);
    let mut engine = ShuffleEngine::new(5);
    engine.update_tracks(Source::Advance, &tracks, None);
    engine.on_external_play("track-1");
    assert!(!engine.contains_remaining("track-1"));
    assert_eq!(engine.remaining_len(), 2);
  }

  #[test]
  fn reset_clears_round_and_history() {
    let tracks = ids(3);
    let mut engine = ShuffleEngine::new(9);
    engine.update_tracks(Source::Advance, &tracks, None);
    let ctx = context(tracks);
    let selection = engine.next(&strategy(), &ctx).expect("selection");
    engine.commit(selection);
    engine.reset();
    assert_eq!(engine.remaining_len(), 0);
    assert_eq!(engine.previous(), None);
  }
}
