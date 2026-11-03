import type { SmartShuffleConfig } from "./types";

/**
 * 智能随机默认配置，与 Rust `SmartShuffleConfig::default()` 保持一致。
 *
 * 默认值即播放器里的「均衡随机」预设；`randomness=60` 时算法使用与旧版
 * 智能随机相同的权重强度。
 */
export const DEFAULT_SMART_SHUFFLE_CONFIG: SmartShuffleConfig = {
  version: 1,
  experience: {
    randomness: 60,
    diversity: 50,
    repeatAvoidance: 80,
  },
  separation: {
    artist: 3,
    album: 2,
  },
  audioFeatures: {
    bpmMatching: 30,
    energyMatching: 30,
    moodDiversity: 30,
    genreDiversity: 50,
  },
};
