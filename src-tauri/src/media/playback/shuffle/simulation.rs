//! 智能随机的模拟校准：合成曲库 + 指标，不依赖数据库。
//!
//! 只作为测试运行；输出 metrics 供调参，断言只锁定体验底线。

use std::collections::{HashMap, HashSet};

use super::context::{RecentPlay, ShuffleCandidate, ShuffleContext, Source, TrackFeatures};
use super::engine::ShuffleEngine;
use super::profile::{SmartShuffleConfig, SmartShuffleExperience, SmartShuffleSeparation};
use super::strategy::ShuffleStrategy;

const TRACKS: usize = 500;
const ARTISTS: usize = 40;
const ALBUMS: usize = 80;
const GENRES: usize = 8;

fn features(index: usize) -> TrackFeatures {
  TrackFeatures {
    artists: vec![format!("artist-{}", index % ARTISTS)],
    album: Some(format!("album-{}", index % ALBUMS)),
    genre: Some(format!("genre-{}", index % GENRES)),
    favorite: index.is_multiple_of(5),
  }
}

fn candidates() -> Vec<ShuffleCandidate> {
  (0..TRACKS)
    .map(|index| ShuffleCandidate {
      id: format!("track-{index}"),
      features: Some(features(index)),
    })
    .collect()
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

struct Report {
  coverage: Vec<usize>,
  immediate_repeats: usize,
  same_artist: usize,
  same_album: usize,
  same_genre: usize,
  favorite_lift: f64,
  recent_hits: usize,
}

fn run(profile: &SmartShuffleConfig, cycles: usize) -> Report {
  let pool = candidates();
  let ids: Vec<String> = pool.iter().map(|item| item.id.clone()).collect();
  let by_id: HashMap<String, TrackFeatures> = pool
    .iter()
    .filter_map(|item| {
      item
        .features
        .clone()
        .map(|features| (item.id.clone(), features))
    })
    .collect();
  let mut engine = ShuffleEngine::new(2026);
  engine.update_tracks(Source::Advance, &ids, None);
  let strategy = ShuffleStrategy::from_config(profile);
  let hard_window = strategy.hard_recent();
  let mut recent: Vec<RecentPlay> = Vec::new();
  let mut current: Option<String> = None;
  let mut coverage = Vec::new();
  let mut seen = HashSet::new();
  let mut previous: Option<TrackFeatures> = None;
  let mut stats = Report {
    coverage: Vec::new(),
    immediate_repeats: 0,
    same_artist: 0,
    same_album: 0,
    same_genre: 0,
    favorite_lift: 0.0,
    recent_hits: 0,
  };
  let mut favorite_hits = 0usize;
  let mut cycle_picks = 0usize;
  let mut picks = 0usize;

  for _ in 0..cycles * TRACKS {
    picks += 1;
    let context = ShuffleContext {
      candidates: pool.clone(),
      recent: recent.clone(),
      current: current.clone(),
    };
    let Some(selection) = engine.next(&strategy, &context) else {
      break;
    };
    let id = selection.id.clone();
    let features = by_id.get(&id).cloned();
    cycle_picks += 1;
    if cycle_picks <= 100 && features.as_ref().is_some_and(|item| item.favorite) {
      favorite_hits += 1;
    }
    if id == current.clone().unwrap_or_default() {
      stats.immediate_repeats += 1;
    }
    if let (Some(previous), Some(features)) = (previous.as_ref(), features.as_ref()) {
      if previous
        .artists
        .iter()
        .any(|a| features.artists.contains(a))
      {
        stats.same_artist += 1;
      }
      if previous.album == features.album {
        stats.same_album += 1;
      }
      if previous.genre == features.genre {
        stats.same_genre += 1;
      }
    }
    for entry in recent.iter().take(hard_window) {
      if entry.id == id {
        stats.recent_hits += 1;
        break;
      }
    }
    previous = features.clone();
    seen.insert(id.clone());
    recent.insert(
      0,
      RecentPlay {
        id: id.clone(),
        features,
      },
    );
    recent.truncate(super::context::RECENT_LIMIT);
    current = Some(id);
    engine.commit(selection);
    if seen.len() == TRACKS {
      coverage.push(seen.len());
      seen.clear();
      cycle_picks = 0;
    }
  }
  stats.coverage = coverage;
  stats.favorite_lift = favorite_hits as f64 / (cycles.saturating_mul(100)) as f64 / 0.2;
  eprintln!(
    "picks={picks} coverage={:?} seen={} immediate={} recent={}",
    stats.coverage,
    seen.len(),
    stats.immediate_repeats,
    stats.recent_hits
  );
  stats
}

#[test]
fn default_profile_has_no_immediate_repeats_and_covers_cycles() {
  let report = run(&SmartShuffleConfig::default(), 3);
  assert_eq!(report.coverage, vec![TRACKS, TRACKS, TRACKS]);
  assert_eq!(report.immediate_repeats, 0);
  assert_eq!(report.recent_hits, 0);
  assert!(
    report.favorite_lift > 1.0,
    "favorite_lift={}",
    report.favorite_lift
  );
  println!(
    "default: artist={} album={} genre={} favorite_lift={:.2}",
    report.same_artist, report.same_album, report.same_genre, report.favorite_lift
  );
}

#[test]
fn randomness_hundred_is_uniform_and_keeps_hard_recent_window() {
  let report = run(&config(100, 50, 100, 3, 2), 3);
  assert_eq!(report.immediate_repeats, 0);
  assert_eq!(report.recent_hits, 0);
  assert_eq!(report.coverage, vec![TRACKS, TRACKS, TRACKS]);
}

#[test]
fn diversity_priority_reduces_genre_adjacency() {
  let balanced = run(&SmartShuffleConfig::default(), 2);
  let diverse = run(&config(40, 100, 90, 6, 4), 2);
  assert!(
    diverse.same_genre <= balanced.same_genre,
    "balanced={} diverse={}",
    balanced.same_genre,
    diverse.same_genre
  );
}
