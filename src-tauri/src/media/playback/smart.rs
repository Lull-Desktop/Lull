//! 智能随机播放：多因素权重 + 轮次袋。
//!
//! 纯逻辑模块，不访问数据库也不依赖播放服务；候选特征与最近播放由
//! `playback` 查询后传入。`Shuffle` 模式下自然播完与手动上/下一首都走这里：
//!
//! - 轮次袋保证一轮内不重复，全部播完才开启下一轮；
//! - 最近播放、同歌手、同专辑、同曲风依次降权，收藏适度加权；
//! - 最终按权重随机抽取，而不是永远选最高分。
//!
//! 曲库目前没有 BPM 字段，节奏维度留待后续接入，不在这里写占位逻辑。

use std::collections::{HashMap, HashSet};

/// 最近播放窗口：超过 6 小时的历史不再影响权重。
pub const RECENT_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;
/// 参与权重计算的最近播放条数。
pub const RECENT_LIMIT: usize = 32;

/// 权重下限：保证任何幸存候选都还有被抽中的机会。
const MIN_WEIGHT: f64 = 1e-6;
/// 权重上限：避免收藏或其他加成把某一首推到独占。
const MAX_WEIGHT: f64 = 8.0;
/// 收藏曲目的权重加成。
const FAVORITE_BOOST: f64 = 1.2;

/// 参与打分的曲目特征。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrackFeatures {
  /// 主要/合作艺术家 id；同一艺人可能有多个 id，按集合求交。
  pub artists: Vec<String>,
  /// 主专辑 id。
  pub album: Option<String>,
  /// 归一化（trim + 小写）后的曲风。
  pub genre: Option<String>,
  pub favorite: bool,
}

/// 最近播放的一条记录；特征可能缺失（曲目已删除或元数据不可读）。
#[derive(Debug, Clone)]
pub struct RecentPlay {
  pub id: String,
  pub features: Option<TrackFeatures>,
}

/// 轮次袋对应的候选来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
  /// 播放器同步的当前页签列表（`player.setAdvanceList`）。
  Advance,
  /// 用户队列。
  Queue,
}

/// 一轮随机播放的进度。
///
/// `known` 记录本轮见过的候选集合，用于区分分页追加/筛选缩小（保留进度）
/// 与切换页签/换列表（重置一轮）。
#[derive(Debug, Default)]
pub struct RoundState {
  source: Option<Source>,
  known: HashSet<String>,
  remaining: HashSet<String>,
  played: HashSet<String>,
}

impl RoundState {
  #[must_use]
  pub fn new() -> Self {
    Self::default()
  }

  /// 让袋状态与最新的候选列表对齐。
  ///
  /// - 来源切换、首次使用、或新旧列表互不包含时重置一轮；
  /// - 超集/子集（分页、筛选）保留已播进度，新增曲目进入本轮；
  /// - 当前曲目不会留在 `remaining` 中，避免立即重播。
  pub fn reconcile(&mut self, source: Source, candidates: &[String], current: Option<&str>) {
    let set: HashSet<String> = candidates.iter().cloned().collect();
    let reset = self.source != Some(source)
      || self.known.is_empty()
      || !(set.is_superset(&self.known) || set.is_subset(&self.known));
    if reset {
      self.start_new_round(source, &set, current);
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
    if let Some(current) = current {
      self.remaining.remove(current);
    }
    if self.remaining.is_empty() {
      let known = self.known.clone();
      self.start_new_round(source, &known, current);
    }
  }

  /// 记录一次成功播放；不属于当前列表的曲目（例如从资料库点播）不计数。
  pub fn mark_played(&mut self, id: &str) {
    if self.known.contains(id) {
      self.remaining.remove(id);
      self.played.insert(id.to_string());
    }
  }

  /// 播放失败时把曲目移出本轮，避免连续重试同一首。
  pub fn exclude(&mut self, id: &str) {
    self.remaining.remove(id);
    self.played.insert(id.to_string());
  }

  /// 本轮还剩多少首候选（仅测试使用）。
  #[cfg(test)]
  #[must_use]
  pub fn remaining_len(&self) -> usize {
    self.remaining.len()
  }

  fn start_new_round(&mut self, source: Source, set: &HashSet<String>, current: Option<&str>) {
    self.source = Some(source);
    self.known = set.clone();
    self.played.clear();
    self.remaining = set.clone();
    // 单曲列表没有「下一首」可选，允许重播当前曲目。
    if set.len() > 1 {
      if let Some(current) = current {
        self.remaining.remove(current);
      }
    }
  }
}

/// 候选曲目的综合权重；未知特征按中性 1.0 处理。
#[must_use]
pub fn weight(features: Option<&TrackFeatures>, id: &str, recent: &[RecentPlay]) -> f64 {
  let mut value = 1.0;
  if let Some(position) = recent.iter().position(|entry| entry.id == id) {
    value *= match position {
      0..=2 => 0.02,
      3..=7 => 0.15,
      8..=15 => 0.5,
      16..=31 => 0.85,
      _ => 1.0,
    };
  }
  if let Some(features) = features {
    value *= artist_factor(features, recent);
    value *= album_factor(features, recent);
    value *= genre_factor(features, recent);
    if features.favorite {
      value *= FAVORITE_BOOST;
    }
  }
  value.clamp(MIN_WEIGHT, MAX_WEIGHT)
}

fn artist_factor(features: &TrackFeatures, recent: &[RecentPlay]) -> f64 {
  if features.artists.is_empty() {
    return 1.0;
  }
  let hits = recent
    .iter()
    .take(3)
    .filter(|entry| {
      entry.features.as_ref().is_some_and(|other| {
        other
          .artists
          .iter()
          .any(|artist| features.artists.contains(artist))
      })
    })
    .count();
  match hits {
    0 => 1.0,
    1 => 0.2,
    _ => 0.05,
  }
}

fn album_factor(features: &TrackFeatures, recent: &[RecentPlay]) -> f64 {
  let Some(album) = features.album.as_deref() else {
    return 1.0;
  };
  if recent
    .first()
    .is_some_and(|entry| entry_album(entry).is_some_and(|value| value == album))
  {
    return 0.15;
  }
  if recent
    .iter()
    .take(3)
    .any(|entry| entry_album(entry).is_some_and(|value| value == album))
  {
    return 0.5;
  }
  1.0
}

fn entry_album(entry: &RecentPlay) -> Option<&str> {
  entry
    .features
    .as_ref()
    .and_then(|features| features.album.as_deref())
}

fn genre_factor(features: &TrackFeatures, recent: &[RecentPlay]) -> f64 {
  let Some(genre) = features.genre.as_deref() else {
    return 1.0;
  };
  let hits = recent
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
  match hits {
    0 => 1.0,
    1 => 0.45,
    2 => 0.2,
    _ => 0.09,
  }
}

/// 从本轮剩余候选里按权重抽一首。
///
/// 调用前必须先 `reconcile`；本函数不修改轮次状态，成功播放后由调用方
/// `mark_played`（失败则 `exclude`）。
#[must_use]
pub fn pick(
  candidates: &[String],
  features: &HashMap<String, TrackFeatures>,
  recent: &[RecentPlay],
  round: &RoundState,
  rng: &mut SmartRng,
) -> Option<String> {
  let mut weighted: Vec<(&str, f64)> = Vec::with_capacity(round.remaining.len());
  let mut total = 0.0;
  for id in candidates {
    if !round.remaining.contains(id) {
      continue;
    }
    let value = weight(features.get(id), id, recent);
    total += value;
    weighted.push((id.as_str(), value));
  }
  if weighted.is_empty() {
    return None;
  }
  if total <= f64::EPSILON {
    let index = rng.below(weighted.len());
    return weighted.get(index).map(|(id, _)| (*id).to_string());
  }

  let mut roll = rng.unit() * total;
  let mut last = None;
  for (id, value) in weighted {
    last = Some(id.to_string());
    roll -= value;
    if roll <= 0.0 {
      return Some(id.to_string());
    }
  }
  last
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

  fn feats(artists: &[&str], album: &str, genre: &str, favorite: bool) -> TrackFeatures {
    TrackFeatures {
      artists: artists.iter().map(|value| (*value).to_string()).collect(),
      album: Some(album.to_string()),
      genre: Some(genre.to_string()),
      favorite,
    }
  }

  fn recent(id: &str, features: TrackFeatures) -> RecentPlay {
    RecentPlay {
      id: id.to_string(),
      features: Some(features),
    }
  }

  fn ids(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("track-{index}")).collect()
  }

  fn empty_features() -> HashMap<String, TrackFeatures> {
    HashMap::new()
  }

  #[test]
  fn round_covers_every_track_once_before_restart() {
    let candidates = ids(20);
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &candidates, None);
    let features = empty_features();
    let recent = Vec::new();
    let mut rng = SmartRng::seeded(42);
    let mut seen = HashSet::new();
    let mut last = String::new();

    for _ in 0..candidates.len() {
      let picked = pick(&candidates, &features, &recent, &round, &mut rng).expect("pick");
      assert!(
        seen.insert(picked.clone()),
        "round must not repeat: {picked}"
      );
      last = picked.clone();
      round.mark_played(&picked);
    }

    assert_eq!(seen.len(), candidates.len());
    assert_eq!(round.remaining_len(), 0);

    round.reconcile(Source::Advance, &candidates, Some(&last));
    assert_eq!(round.remaining_len(), candidates.len() - 1);
    for _ in 0..50 {
      let picked = pick(&candidates, &features, &recent, &round, &mut rng).expect("pick");
      assert_ne!(picked, last, "new round must not replay the previous track");
    }
  }

  #[test]
  fn five_hundred_tracks_cover_one_round_without_repeats() {
    let candidates = ids(500);
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &candidates, None);
    let mut rng = SmartRng::seeded(11);
    let mut seen = HashSet::new();
    for _ in 0..candidates.len() {
      let picked = pick(&candidates, &empty_features(), &[], &round, &mut rng).expect("pick");
      assert!(
        seen.insert(picked.clone()),
        "round must not repeat: {picked}"
      );
      round.mark_played(&picked);
    }
    assert_eq!(seen.len(), candidates.len());
    assert_eq!(round.remaining_len(), 0);
  }

  #[test]
  fn round_keeps_progress_on_superset_and_resets_on_disjoint_list() {
    let list = ids(3);
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &list, None);
    round.mark_played("track-0");
    assert_eq!(round.remaining_len(), 2);

    let mut extended = list.clone();
    extended.push("track-3".to_string());
    round.reconcile(Source::Advance, &extended, Some("track-0"));
    assert_eq!(round.remaining_len(), 3);

    let other = vec!["other-a".to_string(), "other-b".to_string()];
    round.reconcile(Source::Advance, &other, Some("other-b"));
    assert_eq!(round.remaining_len(), 1);
  }

  #[test]
  fn round_resets_when_source_changes() {
    let list = ids(3);
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &list, None);
    round.mark_played("track-0");
    round.reconcile(Source::Queue, &list, Some("track-1"));
    assert_eq!(round.remaining_len(), 2);
  }

  #[test]
  fn single_track_round_replays_current() {
    let mut candidates = ids(1);
    candidates[0] = "only".to_string();
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &candidates, None);
    let mut rng = SmartRng::seeded(7);
    assert_eq!(
      pick(&candidates, &empty_features(), &[], &round, &mut rng).as_deref(),
      Some("only")
    );
    round.mark_played("only");
    round.reconcile(Source::Advance, &candidates, Some("only"));
    assert_eq!(
      pick(&candidates, &empty_features(), &[], &round, &mut rng).as_deref(),
      Some("only")
    );
  }

  #[test]
  fn recent_track_is_heavily_penalized() {
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let history = vec![recent("track-a", candidate.clone())];
    let fresh = weight(Some(&candidate), "track-b", &history);
    let played = weight(Some(&candidate), "track-a", &history);
    assert!(played <= fresh * 0.03, "played={played} fresh={fresh}");
  }

  #[test]
  fn same_artist_album_and_genre_are_penalized() {
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let empty: Vec<RecentPlay> = Vec::new();
    assert!((weight(Some(&candidate), "track-a", &empty) - 1.0).abs() < f64::EPSILON);

    let same_artist = vec![
      recent("r1", feats(&["artist-a"], "album-b", "rock", false)),
      recent("r2", feats(&["artist-a"], "album-c", "jazz", false)),
    ];
    assert!((weight(Some(&candidate), "track-a", &same_artist) - 0.05).abs() < 1e-9);

    let same_album = vec![recent("r1", feats(&["artist-b"], "album-a", "rock", false))];
    assert!((weight(Some(&candidate), "track-a", &same_album) - 0.15).abs() < 1e-9);

    let same_genre = vec![
      recent("r1", feats(&["artist-b"], "album-b", "ambient", false)),
      recent("r2", feats(&["artist-c"], "album-c", "ambient", false)),
      recent("r3", feats(&["artist-d"], "album-d", "ambient", false)),
    ];
    assert!((weight(Some(&candidate), "track-a", &same_genre) - 0.09).abs() < 1e-9);
  }

  #[test]
  fn favorite_gets_a_small_boost() {
    let plain = feats(&["artist-a"], "album-a", "ambient", false);
    let liked = feats(&["artist-a"], "album-a", "ambient", true);
    let boost = weight(Some(&liked), "track-a", &[]) / weight(Some(&plain), "track-a", &[]);
    assert!((boost - FAVORITE_BOOST).abs() < 1e-9);
  }

  #[test]
  fn missing_metadata_is_neutral() {
    let empty = TrackFeatures::default();
    let history = vec![recent("r1", TrackFeatures::default())];
    assert!((weight(Some(&empty), "track-a", &history) - 1.0).abs() < f64::EPSILON);
    assert!((weight(None, "track-a", &history) - 1.0).abs() < f64::EPSILON);
  }

  #[test]
  fn weighted_pick_favors_heavier_candidates() {
    let candidates = ids(3);
    let mut features = HashMap::new();
    features.insert(
      "track-0".to_string(),
      feats(&["artist-a"], "album-a", "ambient", true),
    );
    features.insert(
      "track-1".to_string(),
      feats(&["artist-b"], "album-b", "rock", false),
    );
    features.insert(
      "track-2".to_string(),
      feats(&["artist-c"], "album-c", "jazz", false),
    );
    let mut round = RoundState::new();
    round.reconcile(Source::Advance, &candidates, None);
    let mut rng = SmartRng::seeded(2026);
    let mut favorite = 0;
    for _ in 0..1_000 {
      let picked = pick(&candidates, &features, &[], &round, &mut rng).expect("pick");
      if picked == "track-0" {
        favorite += 1;
      }
    }
    assert!(favorite > 340, "favorite picked {favorite}/1000 times");
  }

  #[test]
  fn pick_is_deterministic_for_a_seed() {
    let candidates = ids(10);
    let features = empty_features();
    let run = |seed: u64| {
      let mut round = RoundState::new();
      round.reconcile(Source::Advance, &candidates, None);
      let mut rng = SmartRng::seeded(seed);
      let mut picks = Vec::new();
      for _ in 0..10 {
        let picked = pick(&candidates, &features, &[], &round, &mut rng).expect("pick");
        round.mark_played(&picked);
        picks.push(picked);
      }
      picks
    };
    assert_eq!(run(99), run(99));
    assert_ne!(run(99), run(100));
  }

  #[test]
  fn empty_round_returns_none() {
    let candidates = ids(2);
    let round = RoundState::new();
    let mut rng = SmartRng::seeded(1);
    assert_eq!(
      pick(&candidates, &empty_features(), &[], &round, &mut rng),
      None
    );
  }
}
