//! Audio Reactive 的数据模型与线上形状。
//!
//! `AudioFrame` / `AudioSnapshot` / `AudioStatus` 与前端
//! `src/sdk/scene/audio.ts`、`packages/scene-sdk/src/audio-types.ts` 逐字段对应；
//! 修改字段必须同时改三处（Rust + 宿主 + SDK）与契约测试。
//!
//! 数值范围统一 `0.0–1.0`，且必须是有限数：这是视觉响应刻度，不是 dB SPL。

use serde::{Deserialize, Serialize};

/// 音频协议版本；与前端 `AUDIO_PROTOCOL` 一致。
pub const AUDIO_PROTOCOL: u32 = 1;

/// 壁纸窗订阅音频的 Tauri 定向事件名。
pub const AUDIO_EVENT: &str = "wallpaper-audio";

/// 订阅音频的窗口 label 前缀（`wallpaper-0`、`wallpaper-1`…）。
pub const WALLPAPER_LABEL_PREFIX: &str = "wallpaper-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
  Music,
  Noise,
  Mix,
  Master,
}

impl AudioSource {
  pub const ALL: [AudioSource; 4] = [
    AudioSource::Music,
    AudioSource::Noise,
    AudioSource::Mix,
    AudioSource::Master,
  ];

  #[must_use]
  pub const fn as_str(self) -> &'static str {
    match self {
      AudioSource::Music => "music",
      AudioSource::Noise => "noise",
      AudioSource::Mix => "mix",
      AudioSource::Master => "master",
    }
  }

  #[must_use]
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "music" => Some(AudioSource::Music),
      "noise" => Some(AudioSource::Noise),
      "mix" => Some(AudioSource::Mix),
      "master" => Some(AudioSource::Master),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFeature {
  Level,
  Bands,
  /// P1：压缩频谱。
  Spectrum,
  /// P1：时域波形。
  Waveform,
}

impl AudioFeature {
  #[must_use]
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "level" => Some(AudioFeature::Level),
      "bands" => Some(AudioFeature::Bands),
      "spectrum" => Some(AudioFeature::Spectrum),
      "waveform" => Some(AudioFeature::Waveform),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
  /// 原始 RMS（未平滑）。
  pub rms: f64,
  /// 原始峰值（未平滑）。
  pub peak: f64,
  /// 归一化并按视觉策略平滑后的能量。
  pub normalized: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBands {
  pub bass: f64,
  pub low_mid: f64,
  pub mid: f64,
  pub high_mid: f64,
  pub treble: f64,
}

impl AudioBands {
  #[must_use]
  pub fn silent() -> Self {
    Self {
      bass: 0.0,
      low_mid: 0.0,
      mid: 0.0,
      high_mid: 0.0,
      treble: 0.0,
    }
  }

  /// 依次访问五个频段；用于统一做归一化 / 平滑。
  #[must_use]
  pub fn values(&self) -> [f64; 5] {
    [
      self.bass,
      self.low_mid,
      self.mid,
      self.high_mid,
      self.treble,
    ]
  }

  #[must_use]
  pub fn from_values(values: [f64; 5]) -> Self {
    Self {
      bass: clamp01(values[0]),
      low_mid: clamp01(values[1]),
      mid: clamp01(values[2]),
      high_mid: clamp01(values[3]),
      treble: clamp01(values[4]),
    }
  }
}

impl Default for AudioLevel {
  fn default() -> Self {
    Self {
      rms: 0.0,
      peak: 0.0,
      normalized: 0.0,
    }
  }
}

impl Default for AudioBands {
  fn default() -> Self {
    Self::silent()
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrame {
  pub protocol: u32,
  /// 全局单调时间戳（ms）；同一 tick 的所有来源一致。
  pub timestamp: u64,
  /// 每 tick 自增；同一 tick 的所有来源一致。
  pub sequence: u64,
  pub source: AudioSource,
  pub active: bool,
  pub level: AudioLevel,
  pub bands: AudioBands,
  /// P1：压缩频谱。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub spectrum: Option<Vec<f64>>,
  /// P1：时域波形。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub waveform: Option<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshotSources {
  pub music: Option<AudioFrame>,
  pub noise: Option<AudioFrame>,
  pub mix: Option<AudioFrame>,
  pub master: Option<AudioFrame>,
}

impl AudioSnapshotSources {
  #[must_use]
  pub fn empty() -> Self {
    Self {
      music: None,
      noise: None,
      mix: None,
      master: None,
    }
  }

  pub fn set(&mut self, frame: AudioFrame) {
    match frame.source {
      AudioSource::Music => self.music = Some(frame),
      AudioSource::Noise => self.noise = Some(frame),
      AudioSource::Mix => self.mix = Some(frame),
      AudioSource::Master => self.master = Some(frame),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshot {
  pub protocol: u32,
  pub timestamp: u64,
  pub sources: AudioSnapshotSources,
}

impl AudioSnapshot {
  #[must_use]
  pub fn empty(timestamp: u64) -> Self {
    Self {
      protocol: AUDIO_PROTOCOL,
      timestamp,
      sources: AudioSnapshotSources::empty(),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioStatusReason {
  NotAuthorized,
  NotSupported,
  Suspended,
  Inactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatusSources {
  pub music: bool,
  pub noise: bool,
  pub mix: bool,
  pub master: bool,
}

impl AudioStatusSources {
  #[must_use]
  pub const fn all(value: bool) -> Self {
    Self {
      music: value,
      noise: value,
      mix: value,
      master: value,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
  pub available: bool,
  pub sources: AudioStatusSources,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reason: Option<AudioStatusReason>,
}

impl AudioStatus {
  #[must_use]
  pub fn unavailable(reason: AudioStatusReason) -> Self {
    Self {
      available: false,
      sources: AudioStatusSources::all(false),
      reason: Some(reason),
    }
  }

  #[must_use]
  pub fn available() -> Self {
    Self {
      available: true,
      sources: AudioStatusSources::all(true),
      reason: None,
    }
  }
}

/// 引擎 `audio.frame` 事件里的单个来源；时间戳由 Rust 统一赋予。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAudioFrame {
  pub source: AudioSource,
  #[serde(default)]
  pub active: bool,
  #[serde(default)]
  pub level: EngineAudioLevel,
  #[serde(default)]
  pub bands: AudioBands,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAudioLevel {
  #[serde(default)]
  pub rms: f64,
  #[serde(default)]
  pub peak: f64,
}

impl Default for EngineAudioLevel {
  fn default() -> Self {
    Self {
      rms: 0.0,
      peak: 0.0,
    }
  }
}

/// `audio_connect` 的请求；来源/特征由壁纸页按场景 Manifest 裁剪后传入。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConnectRequest {
  #[serde(default)]
  pub sources: Option<Vec<String>>,
  #[serde(default)]
  pub features: Option<Vec<String>>,
  #[serde(default)]
  pub interval_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConnectResult {
  pub snapshot: AudioSnapshot,
  pub status: AudioStatus,
}

/// 下发给壁纸页的定向事件载荷（`wallpaper-audio`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameEnvelope {
  pub v: u32,
  #[serde(rename = "type")]
  pub kind: &'static str,
  pub timestamp: u64,
  pub sequence: u64,
  pub frames: Vec<AudioFrame>,
}

impl AudioFrameEnvelope {
  pub const KIND: &'static str = "frame";

  #[must_use]
  pub fn new(timestamp: u64, sequence: u64, frames: Vec<AudioFrame>) -> Self {
    Self {
      v: AUDIO_PROTOCOL,
      kind: Self::KIND,
      timestamp,
      sequence,
      frames,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatusEnvelope {
  pub v: u32,
  #[serde(rename = "type")]
  pub kind: &'static str,
  pub status: AudioStatus,
}

impl AudioStatusEnvelope {
  pub const KIND: &'static str = "status";

  #[must_use]
  pub fn new(status: AudioStatus) -> Self {
    Self {
      v: AUDIO_PROTOCOL,
      kind: Self::KIND,
      status,
    }
  }
}

/// 把任意 f64 收进 `0.0–1.0`；NaN / Infinity 视为 0。
#[must_use]
pub fn clamp01(value: f64) -> f64 {
  if !value.is_finite() {
    return 0.0;
  }
  value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frame_serializes_camel_case_and_omits_optional_series() {
    let frame = AudioFrame {
      protocol: AUDIO_PROTOCOL,
      timestamp: 1234,
      sequence: 7,
      source: AudioSource::Music,
      active: true,
      level: AudioLevel {
        rms: 0.25,
        peak: 0.5,
        normalized: 0.75,
      },
      bands: AudioBands {
        bass: 0.8,
        low_mid: 0.6,
        mid: 0.4,
        high_mid: 0.2,
        treble: 0.1,
      },
      spectrum: None,
      waveform: None,
    };
    let value = serde_json::to_value(&frame).expect("serialize frame");
    assert_eq!(value["protocol"], 1);
    assert_eq!(value["source"], "music");
    assert_eq!(value["bands"]["lowMid"], 0.6);
    assert!(value.get("spectrum").is_none());
  }

  #[test]
  fn parses_engine_frame_and_clamps_through_helpers() {
    let frame: EngineAudioFrame = serde_json::from_value(serde_json::json!({
      "source": "noise",
      "active": true,
      "level": { "rms": 0.4, "peak": 0.9 },
      "bands": {
        "bass": 0.1, "lowMid": 0.2, "mid": 0.3, "highMid": 0.4, "treble": 0.5
      }
    }))
    .expect("parse engine frame");
    assert_eq!(frame.source, AudioSource::Noise);
    assert_eq!(frame.bands.low_mid, 0.2);
    assert_eq!(clamp01(f64::NAN), 0.0);
    assert_eq!(clamp01(2.0), 1.0);
  }

  #[test]
  fn status_reasons_use_kebab_case() {
    let status = AudioStatus::unavailable(AudioStatusReason::NotSupported);
    assert_eq!(status.reason, Some(AudioStatusReason::NotSupported));
    let value = serde_json::to_value(&status).expect("serialize status");
    assert_eq!(value["reason"], "not-supported");
    assert_eq!(value["sources"]["master"], false);
  }

  #[test]
  fn snapshot_sources_are_indexed_by_source() {
    let mut sources = AudioSnapshotSources::empty();
    sources.set(AudioFrame {
      protocol: AUDIO_PROTOCOL,
      timestamp: 10,
      sequence: 1,
      source: AudioSource::Mix,
      active: true,
      level: AudioLevel::default(),
      bands: AudioBands::silent(),
      spectrum: None,
      waveform: None,
    });
    assert!(sources.mix.is_some());
    assert!(sources.music.is_none());
    let snapshot = AudioSnapshot {
      protocol: AUDIO_PROTOCOL,
      timestamp: 10,
      sources,
    };
    let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
    assert_eq!(value["sources"]["mix"]["source"], "mix");
    assert_eq!(value["sources"]["music"], serde_json::Value::Null);
  }
}
