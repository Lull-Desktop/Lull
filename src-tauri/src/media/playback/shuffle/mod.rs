//! 智能随机三层：用户 Profile、算法 Strategy、选曲 Engine。
//!
//! - `profile`：配置与可保存/切换的 profile；
//! - `strategy`：把配置转换成评分、约束与概率；
//! - `engine`：轮次袋、历史栈与候选选择。
//!
//! 三层都不访问数据库；`playback` 负责加载上下文并提交播放结果。

pub mod context;
pub mod engine;
pub mod profile;
pub mod strategy;

#[cfg(test)]
mod simulation;

pub use context::{
  RecentPlay, ShuffleCandidate, ShuffleContext, Source, TrackFeatures, RECENT_LIMIT,
  RECENT_WINDOW_MS,
};
pub use engine::ShuffleEngine;
pub use profile::{
  builtin_profile, builtin_profiles, default_profile, profile_name_key, validate_profile_name,
  SmartShuffleConfig, SmartShuffleProfile, SmartShuffleProfileSummary, BUILTIN_BALANCED_ID,
  MAX_PROFILES,
};
pub use strategy::ShuffleStrategy;
