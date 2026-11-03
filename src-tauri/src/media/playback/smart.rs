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

use serde::{Deserialize, Serialize};

/// 最近播放窗口：超过 6 小时的历史不再影响权重。
pub const RECENT_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;
/// 参与权重计算的最近播放条数（固定值，不对用户开放）。
pub const RECENT_LIMIT: usize = 32;
/// 当前智能随机配置版本。
pub const SMART_SHUFFLE_VERSION: u32 = 1;

/// 权重下限：保证任何幸存候选都还有被抽中的机会。
const MIN_WEIGHT: f64 = 1e-6;
/// 权重上限：避免收藏或其他加成把某一首推到独占。
const MAX_WEIGHT: f64 = 8.0;
/// 收藏曲目的权重加成。
const FAVORITE_BOOST: f64 = 1.2;

/// 面向用户的智能随机配置。
///
/// 只暴露听感参数；轮次袋、历史窗口、权重方向等算法细节留在
/// `SmartShuffleTuning`，不随配置暴露。`audioFeatures` 为前向兼容预留，
/// 当前版本不参与选曲，也不在播放器 UI 中展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartShuffleConfig {
  pub version: u32,
  pub experience: SmartShuffleExperience,
  pub separation: SmartShuffleSeparation,
  pub audio_features: SmartShuffleAudioFeatures,
}

impl Default for SmartShuffleConfig {
  fn default() -> Self {
    Self {
      version: SMART_SHUFFLE_VERSION,
      experience: SmartShuffleExperience::default(),
      separation: SmartShuffleSeparation::default(),
      audio_features: SmartShuffleAudioFeatures::default(),
    }
  }
}

impl SmartShuffleConfig {
  /// 把字段夹到文档声明的范围；调用方无需自己处理越界值。
  #[must_use]
  pub fn normalized(self) -> Self {
    Self {
      version: SMART_SHUFFLE_VERSION,
      experience: SmartShuffleExperience {
        randomness: self.experience.randomness.min(100),
        diversity: self.experience.diversity.min(100),
        repeat_avoidance: self.experience.repeat_avoidance.min(100),
      },
      separation: SmartShuffleSeparation {
        artist: self.separation.artist.min(10),
        album: self.separation.album.min(10),
      },
      audio_features: SmartShuffleAudioFeatures {
        bpm_matching: self.audio_features.bpm_matching.min(100),
        energy_matching: self.audio_features.energy_matching.min(100),
        mood_diversity: self.audio_features.mood_diversity.min(100),
        genre_diversity: self.audio_features.genre_diversity.min(100),
      },
    }
  }

  /// 只接受当前版本；更高版本交给未来实现，不静默套用旧语义。
  pub fn validate(self) -> Result<Self, String> {
    if self.version != SMART_SHUFFLE_VERSION {
      return Err(format!("不支持的智能随机配置版本：{}", self.version));
    }
    Ok(self.normalized())
  }
}

/// 随机体验参数；默认值即「均衡随机」预设。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartShuffleExperience {
  /// 0 = 偏向高分，100 = 在剩余候选内更均匀随机。
  pub randomness: u32,
  /// 0 = 允许相似曲风连续，100 = 尽量切换曲风。
  pub diversity: u32,
  /// 0 = 不回避最近播放，100 = 强回避。
  pub repeat_avoidance: u32,
}

impl Default for SmartShuffleExperience {
  fn default() -> Self {
    Self {
      randomness: 60,
      diversity: 50,
      repeat_avoidance: 80,
    }
  }
}

/// 歌手 / 专辑间隔，单位「首」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartShuffleSeparation {
  pub artist: u32,
  pub album: u32,
}

impl Default for SmartShuffleSeparation {
  fn default() -> Self {
    Self {
      artist: 3,
      album: 2,
    }
  }
}

/// 预留的音乐特征参数；v1 不读取，仅保证配置可往返。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartShuffleAudioFeatures {
  pub bpm_matching: u32,
  pub energy_matching: u32,
  pub mood_diversity: u32,
  pub genre_diversity: u32,
}

impl Default for SmartShuffleAudioFeatures {
  fn default() -> Self {
    Self {
      bpm_matching: 30,
      energy_matching: 30,
      mood_diversity: 30,
      genre_diversity: 50,
    }
  }
}

/// 由用户配置推导出的算法参数；不进入 API。
#[derive(Debug, Clone, Copy)]
pub struct SmartShuffleTuning {
  randomness_exp: f64,
  genre_scale: f64,
  recency_exp: f64,
  artist_window: usize,
  album_window: usize,
}

impl SmartShuffleTuning {
  #[must_use]
  pub fn from_config(config: &SmartShuffleConfig) -> Self {
    let experience = &config.experience;
    Self {
      randomness_exp: f64::from(100_u32.saturating_sub(experience.randomness.min(100))) / 40.0,
      genre_scale: f64::from(experience.diversity.min(100)) / 50.0,
      recency_exp: f64::from(experience.repeat_avoidance.min(100)) / 80.0,
      artist_window: usize::try_from(config.separation.artist.min(10)).unwrap_or(0),
      album_window: usize::try_from(config.separation.album.min(10)).unwrap_or(0),
    }
  }
}

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
pub fn weight(
  features: Option<&TrackFeatures>,
  id: &str,
  recent: &[RecentPlay],
  tuning: &SmartShuffleTuning,
) -> f64 {
  let mut value = 1.0;
  if let Some(position) = recent.iter().position(|entry| entry.id == id) {
    let base: f64 = match position {
      0..=2 => 0.02,
      3..=7 => 0.15,
      8..=15 => 0.5,
      16..=31 => 0.85,
      _ => 1.0,
    };
    value *= base.powf(tuning.recency_exp);
  }
  if let Some(features) = features {
    value *= artist_factor(features, recent, tuning.artist_window);
    value *= album_factor(features, recent, tuning.album_window);
    value *= genre_factor(features, recent, tuning.genre_scale);
    if features.favorite {
      value *= FAVORITE_BOOST;
    }
  }
  value
    .powf(tuning.randomness_exp)
    .clamp(MIN_WEIGHT, MAX_WEIGHT)
}

fn artist_factor(features: &TrackFeatures, recent: &[RecentPlay], window: usize) -> f64 {
  if window == 0 || features.artists.is_empty() {
    return 1.0;
  }
  let hits = recent
    .iter()
    .take(window)
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

fn album_factor(features: &TrackFeatures, recent: &[RecentPlay], window: usize) -> f64 {
  if window == 0 {
    return 1.0;
  }
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
    .take(window)
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

fn genre_factor(features: &TrackFeatures, recent: &[RecentPlay], scale: f64) -> f64 {
  if scale <= f64::EPSILON {
    return 1.0;
  }
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
  let hits = f64::from(u32::try_from(hits).unwrap_or(0));
  0.45_f64.powf(hits * scale)
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
  tuning: &SmartShuffleTuning,
  rng: &mut SmartRng,
) -> Option<String> {
  let mut weighted: Vec<(&str, f64)> = Vec::with_capacity(round.remaining.len());
  let mut total = 0.0;
  for id in candidates {
    if !round.remaining.contains(id) {
      continue;
    }
    let value = weight(features.get(id), id, recent, tuning);
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

  fn default_tuning() -> SmartShuffleTuning {
    SmartShuffleTuning::from_config(&SmartShuffleConfig::default())
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
      let picked = pick(
        &candidates,
        &features,
        &recent,
        &round,
        &default_tuning(),
        &mut rng,
      )
      .expect("pick");
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
      let picked = pick(
        &candidates,
        &features,
        &recent,
        &round,
        &default_tuning(),
        &mut rng,
      )
      .expect("pick");
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
      let picked = pick(
        &candidates,
        &empty_features(),
        &[],
        &round,
        &default_tuning(),
        &mut rng,
      )
      .expect("pick");
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
      pick(
        &candidates,
        &empty_features(),
        &[],
        &round,
        &default_tuning(),
        &mut rng
      )
      .as_deref(),
      Some("only")
    );
    round.mark_played("only");
    round.reconcile(Source::Advance, &candidates, Some("only"));
    assert_eq!(
      pick(
        &candidates,
        &empty_features(),
        &[],
        &round,
        &default_tuning(),
        &mut rng
      )
      .as_deref(),
      Some("only")
    );
  }

  #[test]
  fn config_defaults_match_documented_values() {
    let config = SmartShuffleConfig::default();
    assert_eq!(config.version, SMART_SHUFFLE_VERSION);
    assert_eq!(config.experience.randomness, 60);
    assert_eq!(config.experience.diversity, 50);
    assert_eq!(config.experience.repeat_avoidance, 80);
    assert_eq!(config.separation.artist, 3);
    assert_eq!(config.separation.album, 2);
    assert_eq!(config.audio_features.bpm_matching, 30);
    assert_eq!(config.audio_features.energy_matching, 30);
    assert_eq!(config.audio_features.mood_diversity, 30);
    assert_eq!(config.audio_features.genre_diversity, 50);
  }

  #[test]
  fn config_normalizes_ranges_and_rejects_unknown_versions() {
    let config = SmartShuffleConfig {
      version: 1,
      experience: SmartShuffleExperience {
        randomness: 800,
        diversity: 0,
        repeat_avoidance: 120,
      },
      separation: SmartShuffleSeparation {
        artist: 99,
        album: 0,
      },
      audio_features: SmartShuffleAudioFeatures::default(),
    };
    let normalized = config.normalized();
    assert_eq!(normalized.experience.randomness, 100);
    assert_eq!(normalized.experience.repeat_avoidance, 100);
    assert_eq!(normalized.separation.artist, 10);

    let wrong = SmartShuffleConfig {
      version: 2,
      ..SmartShuffleConfig::default()
    };
    assert!(wrong.validate().is_err());
  }

  #[test]
  fn config_deserializes_partial_and_ignores_unknown_fields() {
    let config: SmartShuffleConfig =
      serde_json::from_str(r#"{"experience":{"randomness":90},"future":{"enabled":true}}"#)
        .expect("partial config");
    assert_eq!(config.version, SMART_SHUFFLE_VERSION);
    assert_eq!(config.experience.randomness, 90);
    assert_eq!(config.experience.diversity, 50);
    assert_eq!(config.separation.artist, 3);
  }

  #[test]
  fn config_serializes_with_camel_case_keys() {
    let json = serde_json::to_value(SmartShuffleConfig::default()).expect("config json");
    assert_eq!(json["version"], 1);
    assert_eq!(json["experience"]["repeatAvoidance"], 80);
    assert_eq!(json["separation"]["artist"], 3);
    assert_eq!(json["audioFeatures"]["bpmMatching"], 30);
  }

  #[test]
  fn default_tuning_preserves_previous_exponents_and_windows() {
    let tuning = default_tuning();
    assert!((tuning.randomness_exp - 1.0).abs() < f64::EPSILON);
    assert!((tuning.genre_scale - 1.0).abs() < f64::EPSILON);
    assert!((tuning.recency_exp - 1.0).abs() < f64::EPSILON);
    assert_eq!(tuning.artist_window, 3);
    assert_eq!(tuning.album_window, 2);
  }

  #[test]
  fn tuning_maps_parameters_to_exponents() {
    let mut config = SmartShuffleConfig::default();
    config.experience.randomness = 0;
    config.experience.diversity = 0;
    config.experience.repeat_avoidance = 0;
    config.separation.artist = 0;
    config.separation.album = 0;
    let tuning = SmartShuffleTuning::from_config(&config);
    assert!((tuning.randomness_exp - 2.5).abs() < 1e-9);
    assert!((tuning.genre_scale - 0.0).abs() < f64::EPSILON);
    assert!((tuning.recency_exp - 0.0).abs() < f64::EPSILON);
    assert_eq!(tuning.artist_window, 0);
    assert_eq!(tuning.album_window, 0);

    config.experience.randomness = 100;
    config.experience.diversity = 100;
    config.experience.repeat_avoidance = 100;
    let tuning = SmartShuffleTuning::from_config(&config);
    assert!((tuning.randomness_exp - 0.0).abs() < f64::EPSILON);
    assert!((tuning.genre_scale - 2.0).abs() < 1e-9);
    assert!((tuning.recency_exp - 1.25).abs() < 1e-9);
  }

  #[test]
  fn recent_track_is_heavily_penalized() {
    let tuning = default_tuning();
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let history = vec![recent("track-a", candidate.clone())];
    let fresh = weight(Some(&candidate), "track-b", &history, &tuning);
    let played = weight(Some(&candidate), "track-a", &history, &tuning);
    assert!(played <= fresh * 0.03, "played={played} fresh={fresh}");
  }

  #[test]
  fn same_artist_album_and_genre_are_penalized() {
    let tuning = default_tuning();
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let empty: Vec<RecentPlay> = Vec::new();
    assert!((weight(Some(&candidate), "track-a", &empty, &tuning) - 1.0).abs() < f64::EPSILON);

    let same_artist = vec![
      recent("r1", feats(&["artist-a"], "album-b", "rock", false)),
      recent("r2", feats(&["artist-a"], "album-c", "jazz", false)),
    ];
    assert!((weight(Some(&candidate), "track-a", &same_artist, &tuning) - 0.05).abs() < 1e-9);

    let same_album = vec![recent("r1", feats(&["artist-b"], "album-a", "rock", false))];
    assert!((weight(Some(&candidate), "track-a", &same_album, &tuning) - 0.15).abs() < 1e-9);

    let same_genre = vec![
      recent("r1", feats(&["artist-b"], "album-b", "ambient", false)),
      recent("r2", feats(&["artist-c"], "album-c", "ambient", false)),
      recent("r3", feats(&["artist-d"], "album-d", "ambient", false)),
    ];
    let expected = 0.45_f64.powi(3);
    assert!((weight(Some(&candidate), "track-a", &same_genre, &tuning) - expected).abs() < 1e-9);
  }

  #[test]
  fn randomness_flattens_or_sharpens_penalties() {
    let candidate = feats(&["artist-a"], "album-a", "ambient", true);
    let history = vec![recent("track-a", candidate.clone())];

    let mut flat = SmartShuffleConfig::default();
    flat.experience.randomness = 100;
    let flat_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&flat),
    );
    assert!((flat_weight - 1.0).abs() < 1e-9);

    let mut sharp = SmartShuffleConfig::default();
    sharp.experience.randomness = 0;
    let sharp_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&sharp),
    );
    assert!(sharp_weight < 1e-4, "sharp={sharp_weight}");
  }

  #[test]
  fn repeat_avoidance_zero_removes_recency_penalty() {
    let mut config = SmartShuffleConfig::default();
    config.experience.repeat_avoidance = 0;
    let tuning = SmartShuffleTuning::from_config(&config);
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let history = vec![recent(
      "track-a",
      feats(&["artist-b"], "album-b", "rock", false),
    )];
    let recent_weight = weight(Some(&candidate), "track-a", &history, &tuning);
    let fresh_weight = weight(Some(&candidate), "track-b", &history, &tuning);
    assert!((recent_weight - fresh_weight).abs() < 1e-9);
  }

  #[test]
  fn diversity_zero_removes_genre_penalty() {
    let mut config = SmartShuffleConfig::default();
    config.experience.diversity = 0;
    let tuning = SmartShuffleTuning::from_config(&config);
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let history = vec![
      recent("r1", feats(&["artist-b"], "album-b", "ambient", false)),
      recent("r2", feats(&["artist-c"], "album-c", "ambient", false)),
      recent("r3", feats(&["artist-d"], "album-d", "ambient", false)),
    ];
    assert!((weight(Some(&candidate), "track-a", &history, &tuning) - 1.0).abs() < 1e-9);
  }

  #[test]
  fn separation_windows_control_artist_and_album_penalties() {
    let candidate = feats(&["artist-a"], "album-a", "ambient", false);
    let history = vec![
      recent("r1", candidate.clone()),
      recent("r2", candidate.clone()),
      recent("r3", candidate.clone()),
    ];

    let mut disabled = SmartShuffleConfig::default();
    disabled.experience.diversity = 0;
    disabled.separation.artist = 0;
    disabled.separation.album = 0;
    let disabled_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&disabled),
    );
    assert!((disabled_weight - 1.0).abs() < 1e-9);

    let mut wide = SmartShuffleConfig::default();
    wide.separation.artist = 5;
    wide.separation.album = 5;
    let wide_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&wide),
    );
    assert!(wide_weight < 0.01, "wide={wide_weight}");
  }

  #[test]
  fn audio_features_are_inert() {
    let candidate = feats(&["artist-a"], "album-a", "ambient", true);
    let history = vec![recent("track-a", candidate.clone())];
    let mut first = SmartShuffleConfig::default();
    first.audio_features.bpm_matching = 100;
    first.audio_features.energy_matching = 100;
    first.audio_features.mood_diversity = 100;
    first.audio_features.genre_diversity = 100;
    let mut second = SmartShuffleConfig::default();
    second.audio_features.bpm_matching = 0;
    second.audio_features.energy_matching = 0;
    second.audio_features.mood_diversity = 0;
    second.audio_features.genre_diversity = 0;
    let first_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&first),
    );
    let second_weight = weight(
      Some(&candidate),
      "track-a",
      &history,
      &SmartShuffleTuning::from_config(&second),
    );
    assert!((first_weight - second_weight).abs() < f64::EPSILON);
  }

  #[test]
  fn favorite_gets_a_small_boost() {
    let tuning = default_tuning();
    let plain = feats(&["artist-a"], "album-a", "ambient", false);
    let liked = feats(&["artist-a"], "album-a", "ambient", true);
    let boost =
      weight(Some(&liked), "track-a", &[], &tuning) / weight(Some(&plain), "track-a", &[], &tuning);
    assert!((boost - FAVORITE_BOOST).abs() < 1e-9);
  }

  #[test]
  fn missing_metadata_is_neutral() {
    let tuning = default_tuning();
    let empty = TrackFeatures::default();
    let history = vec![recent("r1", TrackFeatures::default())];
    assert!((weight(Some(&empty), "track-a", &history, &tuning) - 1.0).abs() < f64::EPSILON);
    assert!((weight(None, "track-a", &history, &tuning) - 1.0).abs() < f64::EPSILON);
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
      let picked = pick(
        &candidates,
        &features,
        &[],
        &round,
        &default_tuning(),
        &mut rng,
      )
      .expect("pick");
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
        let picked = pick(
          &candidates,
          &features,
          &[],
          &round,
          &default_tuning(),
          &mut rng,
        )
        .expect("pick");
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
      pick(
        &candidates,
        &empty_features(),
        &[],
        &round,
        &default_tuning(),
        &mut rng
      ),
      None
    );
  }
}
