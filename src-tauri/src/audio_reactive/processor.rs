//! 每个来源的分析状态机：原始测量 → 归一化 → 平滑 → 可分发帧。
//!
//! 时间戳与序号由 Rust 统一赋予：一次 ingest 对应一个 tick，四个来源共享
//! 同一个 `timestamp` / `sequence`，多显示器因此拥有同一时间基准。

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use super::config::{AudioReactiveConfig, FIXED_LEVEL_GAIN};
use super::model::{
  clamp01, AudioBands, AudioFrame, AudioLevel, AudioSnapshot, AudioSnapshotSources, AudioSource,
  EngineAudioFrame, AUDIO_PROTOCOL,
};
use super::normalizer::{BandNormalizers, EnvelopeNormalizer};
use super::smoothing::Smoother;

/// 单次 tick 的 dt 上限；引擎重载/长时间暂停后恢复时避免数值跳变。
const MAX_DT_MS: f64 = 500.0;

struct SourceState {
  level: EnvelopeNormalizer,
  bands: BandNormalizers,
  smooth_level: Smoother,
  smooth_bands: [Smoother; 5],
  last_ms: Option<u64>,
  frame: Option<AudioFrame>,
}

impl SourceState {
  fn new() -> Self {
    Self {
      level: EnvelopeNormalizer::level(),
      bands: BandNormalizers::new(),
      smooth_level: Smoother::new(),
      smooth_bands: [
        Smoother::new(),
        Smoother::new(),
        Smoother::new(),
        Smoother::new(),
        Smoother::new(),
      ],
      last_ms: None,
      frame: None,
    }
  }
}

pub struct Processor {
  config: AudioReactiveConfig,
  states: BTreeMap<AudioSource, SourceState>,
  sequence: u64,
  timestamp: u64,
}

impl Processor {
  #[must_use]
  pub fn new(config: AudioReactiveConfig) -> Self {
    Self {
      config,
      states: BTreeMap::new(),
      sequence: 0,
      timestamp: 0,
    }
  }

  /// 处理一个引擎 tick；没有有效帧时返回 `None`（不消耗序号）。
  pub fn ingest(
    &mut self,
    frames: &[EngineAudioFrame],
    timestamp: u64,
  ) -> Option<(u64, Vec<AudioFrame>)> {
    let mut by_source: BTreeMap<AudioSource, &EngineAudioFrame> = BTreeMap::new();
    for frame in frames {
      by_source.insert(frame.source, frame);
    }
    if by_source.is_empty() {
      return None;
    }

    self.sequence = self.sequence.saturating_add(1);
    self.timestamp = timestamp;
    let strategy = self.config.normalization;
    let sensitivity = self.config.sensitivity;
    let attack_ms = self.config.attack_ms();
    let release_ms = self.config.release_ms();
    let band_attack_ms = self.config.band_attack_ms();
    let band_release_ms = self.config.band_release_ms();
    let mut out = Vec::with_capacity(by_source.len());

    for source in AudioSource::ALL {
      let Some(input) = by_source.get(&source) else {
        continue;
      };
      let state = self.states.entry(source).or_insert_with(SourceState::new);
      let dt_ms = state
        .last_ms
        .map_or(self.config.interval_ms as f64, |last| {
          (timestamp.saturating_sub(last) as f64).clamp(1.0, MAX_DT_MS)
        });
      state.last_ms = Some(timestamp);

      let rms = clamp01(input.level.rms);
      let peak = clamp01(input.level.peak);

      let level_target = state
        .level
        .normalize(rms, dt_ms, strategy, sensitivity, FIXED_LEVEL_GAIN);
      let normalized = state
        .smooth_level
        .step(level_target, dt_ms, attack_ms, release_ms);

      let raw_bands = input.bands.values();
      let band_targets = state
        .bands
        .normalize(raw_bands, dt_ms, strategy, sensitivity);
      let mut smoothed_bands = [0.0; 5];
      for (index, smoother) in state.smooth_bands.iter_mut().enumerate() {
        smoothed_bands[index] =
          smoother.step(band_targets[index], dt_ms, band_attack_ms, band_release_ms);
      }

      let frame = AudioFrame {
        protocol: AUDIO_PROTOCOL,
        timestamp,
        sequence: self.sequence,
        source,
        active: input.active && rms > 0.0,
        level: AudioLevel {
          rms,
          peak,
          normalized,
        },
        bands: AudioBands::from_values(smoothed_bands),
        spectrum: None,
        waveform: None,
      };
      state.frame = Some(frame.clone());
      out.push(frame);
    }

    if out.is_empty() {
      return None;
    }
    Some((self.sequence, out))
  }

  /// 当前缓存的最新一帧集合；可按订阅来源裁剪。
  #[must_use]
  pub fn latest(&self, sources: Option<&BTreeSet<AudioSource>>) -> AudioSnapshot {
    let mut snapshot_sources = AudioSnapshotSources::empty();
    for source in AudioSource::ALL {
      if sources.is_some_and(|set| !set.contains(&source)) {
        continue;
      }
      if let Some(frame) = self
        .states
        .get(&source)
        .and_then(|state| state.frame.clone())
      {
        snapshot_sources.set(frame);
      }
    }
    AudioSnapshot {
      protocol: AUDIO_PROTOCOL,
      timestamp: self.timestamp,
      sources: snapshot_sources,
    }
  }

  /// 引擎丢失 / 无订阅者：清空缓存与归一化包络，保留单调序号。
  pub fn clear(&mut self) {
    self.states.clear();
    self.timestamp = 0;
  }
}

impl Default for Processor {
  fn default() -> Self {
    Self::new(AudioReactiveConfig::default())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::audio_reactive::model::AudioBands;

  fn input(source: AudioSource, rms: f64, peak: f64, active: bool) -> EngineAudioFrame {
    EngineAudioFrame {
      source,
      active,
      level: crate::audio_reactive::model::EngineAudioLevel { rms, peak },
      bands: AudioBands {
        bass: 0.5,
        low_mid: 0.4,
        mid: 0.3,
        high_mid: 0.2,
        treble: 0.1,
      },
    }
  }

  #[test]
  fn one_tick_shares_timestamp_and_sequence() {
    let mut processor = Processor::default();
    let frames = [
      input(AudioSource::Music, 0.2, 0.5, true),
      input(AudioSource::Noise, 0.1, 0.3, true),
    ];
    let (sequence, out) = processor.ingest(&frames, 1234).expect("tick");
    assert_eq!(sequence, 1);
    assert_eq!(out.len(), 2);
    assert!(out.iter().all(|frame| frame.timestamp == 1234));
    assert!(out.iter().all(|frame| frame.sequence == 1));
    // 固定输出顺序，方便多屏对齐与快照稳定。
    assert_eq!(out[0].source, AudioSource::Music);
    assert_eq!(out[1].source, AudioSource::Noise);
  }

  #[test]
  fn duplicate_sources_keep_the_last_frame() {
    let mut processor = Processor::default();
    let frames = [
      input(AudioSource::Music, 0.1, 0.2, true),
      input(AudioSource::Music, 0.4, 0.6, true),
    ];
    let (_, out) = processor.ingest(&frames, 10).expect("tick");
    assert_eq!(out.len(), 1);
    assert!((out[0].level.rms - 0.4).abs() < f64::EPSILON);
  }

  #[test]
  fn empty_tick_does_not_consume_sequence() {
    let mut processor = Processor::default();
    assert!(processor.ingest(&[], 10).is_none());
    let (sequence, _) = processor
      .ingest(&[input(AudioSource::Mix, 0.2, 0.4, true)], 20)
      .expect("tick");
    assert_eq!(sequence, 1);
  }

  #[test]
  fn silent_source_stays_inactive_and_zeroed() {
    let mut processor = Processor::default();
    let mut silent = input(AudioSource::Music, 0.0, 0.0, false);
    silent.bands = AudioBands::silent();
    let (_, out) = processor.ingest(&[silent], 10).expect("tick");
    assert!(!out[0].active);
    assert_eq!(out[0].level.normalized, 0.0);
    assert_eq!(out[0].bands.bass, 0.0);
  }

  #[test]
  fn snapshot_is_filtered_by_subscribed_sources() {
    let mut processor = Processor::default();
    processor.ingest(
      &[
        input(AudioSource::Music, 0.2, 0.4, true),
        input(AudioSource::Noise, 0.2, 0.4, true),
      ],
      50,
    );
    let only_music: BTreeSet<AudioSource> = [AudioSource::Music].into_iter().collect();
    let snapshot = processor.latest(Some(&only_music));
    assert_eq!(snapshot.timestamp, 50);
    assert!(snapshot.sources.music.is_some());
    assert!(snapshot.sources.noise.is_none());
    assert!(snapshot.sources.mix.is_none());
    assert!(snapshot.sources.master.is_none());
  }

  #[test]
  fn clear_drops_cached_frames_but_keeps_monotonic_sequence() {
    let mut processor = Processor::default();
    processor.ingest(&[input(AudioSource::Music, 0.2, 0.4, true)], 10);
    processor.clear();
    let snapshot = processor.latest(None);
    assert!(snapshot.sources.music.is_none());
    assert_eq!(snapshot.timestamp, 0);
    let (sequence, _) = processor
      .ingest(&[input(AudioSource::Music, 0.2, 0.4, true)], 20)
      .expect("tick");
    assert_eq!(sequence, 2);
  }

  #[test]
  fn output_stays_in_unit_range() {
    let mut processor = Processor::default();
    let frames = [input(AudioSource::Master, 2.0, 4.0, true)];
    let (_, out) = processor.ingest(&frames, 10).expect("tick");
    let frame = &out[0];
    for value in [
      frame.level.rms,
      frame.level.peak,
      frame.level.normalized,
      frame.bands.bass,
      frame.bands.treble,
    ] {
      assert!((0.0..=1.0).contains(&value));
    }
  }

  #[test]
  fn fast_band_changes_remain_visible() {
    let mut processor = Processor::default();
    let frame = |bands: [f64; 5]| EngineAudioFrame {
      source: AudioSource::Music,
      active: true,
      level: crate::audio_reactive::model::EngineAudioLevel {
        rms: 0.5,
        peak: 0.5,
      },
      bands: AudioBands::from_values(bands),
    };
    let loud = [0.95, 0.8, 0.65, 0.5, 0.35];
    let soft = [0.55, 0.45, 0.38, 0.3, 0.22];
    let mut min_bass: f64 = 1.0;
    let mut max_bass: f64 = 0.0;

    for tick in 0..40u64 {
      // 每 4 tick（200ms）切换一次，模拟 150 BPM 的快速鼓点。
      let values = if (tick / 4) % 2 == 0 { loud } else { soft };
      let (_, out) = processor.ingest(&[frame(values)], tick * 50).expect("tick");
      let bass = out[0].bands.bass;
      min_bass = min_bass.min(bass);
      max_bass = max_bass.max(bass);
    }

    assert!(
      max_bass - min_bass > 0.3,
      "fast beats should swing visibly: {min_bass}..{max_bass}"
    );
  }

  #[test]
  fn loud_music_keeps_headroom_and_quiet_passage_falls_back() {
    let mut processor = Processor::default();
    let frame = |rms: f64, bands: [f64; 5]| EngineAudioFrame {
      source: AudioSource::Music,
      active: true,
      level: crate::audio_reactive::model::EngineAudioLevel { rms, peak: rms },
      bands: AudioBands::from_values(bands),
    };

    for tick in 0..20u64 {
      processor.ingest(&[frame(0.2, [0.85, 0.7, 0.6, 0.5, 0.4])], tick * 50);
    }
    let strong = processor.latest(None).sources.music.expect("loud frame");
    assert!(
      strong.bands.bass > strong.bands.treble + 0.1,
      "spectral shape should survive: {:?}",
      strong.bands
    );
    assert!(
      strong.bands.bass < 0.8,
      "sustained loud content should sit mid-scale: {:?}",
      strong.bands
    );

    for tick in 20..40u64 {
      processor.ingest(&[frame(0.05, [0.35, 0.3, 0.26, 0.22, 0.18])], tick * 50);
    }
    let quiet = processor.latest(None).sources.music.expect("quiet frame");
    assert!(
      quiet.bands.bass < strong.bands.bass - 0.2,
      "quiet passage should fall back: {:?}",
      quiet.bands
    );
  }
}
