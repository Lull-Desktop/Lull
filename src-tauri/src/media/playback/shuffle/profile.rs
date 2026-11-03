//! 用户层：智能随机配置与可保存/切换的 Profile。
//!
//! 配置只包含听感参数；评分、概率与轮次属于 `strategy` / `engine`。

use serde::{Deserialize, Serialize};

/// 当前智能随机配置版本。
pub const SMART_SHUFFLE_VERSION: u32 = 1;
/// 内置「均衡随机」profile id。
pub const BUILTIN_BALANCED_ID: &str = "builtin:balanced";
/// 内置「高度随机」profile id。
pub const BUILTIN_RANDOM_ID: &str = "builtin:random";
/// 内置「多样性优先」profile id。
pub const BUILTIN_DIVERSE_ID: &str = "builtin:diverse";
/// 用户 profile 数量上限。
pub const MAX_PROFILES: usize = 50;
/// profile 名称长度上限（字符数）。
pub const MAX_PROFILE_NAME_CHARS: usize = 40;

/// 面向用户的智能随机配置。
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

/// 用户层 Profile：配置 + 身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartShuffleProfile {
  pub id: String,
  pub name: String,
  pub builtin: bool,
  pub config: SmartShuffleConfig,
}

/// 列表页使用的轻量摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartShuffleProfileSummary {
  pub id: String,
  pub name: String,
  pub builtin: bool,
  pub active: bool,
}

/// 内置 profile 的只读定义；迁移 seed 与运行期兜底共用。
#[must_use]
pub fn builtin_profiles() -> Vec<SmartShuffleProfile> {
  vec![
    SmartShuffleProfile {
      id: BUILTIN_BALANCED_ID.to_string(),
      name: "均衡随机".to_string(),
      builtin: true,
      config: SmartShuffleConfig::default(),
    },
    SmartShuffleProfile {
      id: BUILTIN_RANDOM_ID.to_string(),
      name: "高度随机".to_string(),
      builtin: true,
      config: SmartShuffleConfig {
        experience: SmartShuffleExperience {
          randomness: 90,
          diversity: 25,
          repeat_avoidance: 50,
        },
        separation: SmartShuffleSeparation {
          artist: 1,
          album: 1,
        },
        ..SmartShuffleConfig::default()
      },
    },
    SmartShuffleProfile {
      id: BUILTIN_DIVERSE_ID.to_string(),
      name: "多样性优先".to_string(),
      builtin: true,
      config: SmartShuffleConfig {
        experience: SmartShuffleExperience {
          randomness: 40,
          diversity: 100,
          repeat_avoidance: 90,
        },
        separation: SmartShuffleSeparation {
          artist: 6,
          album: 4,
        },
        ..SmartShuffleConfig::default()
      },
    },
  ]
}

#[must_use]
pub fn builtin_profile(id: &str) -> Option<SmartShuffleProfile> {
  builtin_profiles()
    .into_iter()
    .find(|profile| profile.id == id)
}

#[must_use]
pub fn default_profile() -> SmartShuffleProfile {
  builtin_profile(BUILTIN_BALANCED_ID).unwrap_or_else(|| SmartShuffleProfile {
    id: BUILTIN_BALANCED_ID.to_string(),
    name: "均衡随机".to_string(),
    builtin: true,
    config: SmartShuffleConfig::default(),
  })
}

/// 校验并归一化用户填写的 profile 名称。
pub fn validate_profile_name(name: &str) -> Result<String, String> {
  let trimmed = name.trim();
  let chars = trimmed.chars().count();
  if chars == 0 || chars > MAX_PROFILE_NAME_CHARS {
    return Err(format!(
      "配置名称长度需在 1–{MAX_PROFILE_NAME_CHARS} 个字符之间"
    ));
  }
  Ok(trimmed.to_string())
}

/// 名称比较键：大小写不敏感，避免「我的配置」和「我的配置 」并存。
#[must_use]
pub fn profile_name_key(name: &str) -> String {
  name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn config_defaults_and_camel_case_shape() {
    let config = SmartShuffleConfig::default();
    assert_eq!(config.experience.randomness, 60);
    assert_eq!(config.separation.artist, 3);
    let json = serde_json::to_value(&config).expect("config json");
    assert_eq!(json["experience"]["repeatAvoidance"], 80);
    assert_eq!(json["audioFeatures"]["bpmMatching"], 30);
  }

  #[test]
  fn config_normalizes_ranges_and_versions() {
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
    assert_eq!(normalized.separation.artist, 10);
    let wrong = SmartShuffleConfig {
      version: 2,
      ..SmartShuffleConfig::default()
    };
    assert!(wrong.validate().is_err());
  }

  #[test]
  fn builtin_profiles_are_stable_and_unique() {
    let profiles = builtin_profiles();
    assert_eq!(profiles.len(), 3);
    assert_eq!(profiles[0].id, BUILTIN_BALANCED_ID);
    let ids: std::collections::HashSet<_> = profiles.iter().map(|item| &item.id).collect();
    assert_eq!(ids.len(), 3);
    assert!(profiles.iter().all(|item| item.builtin));
  }

  #[test]
  fn profile_names_are_trimmed_and_limited() {
    assert_eq!(validate_profile_name("  夜航  ").as_deref(), Ok("夜航"));
    assert!(validate_profile_name("   ").is_err());
    assert!(validate_profile_name(&"a".repeat(MAX_PROFILE_NAME_CHARS + 1)).is_err());
    assert_eq!(profile_name_key(" Ambient "), "ambient");
  }
}
