/**
 * 智能随机的产品层配置：预设、预设判定与复制 JSON。
 *
 * 用户只接触「听感预设 + 五个参数」；算法参数化在 Rust 侧完成。
 */
import type { SmartShuffleConfig } from "@lull/media-sdk";

export type SmartShufflePresetId = "balanced" | "random" | "diverse" | "custom";

export type SmartShufflePreset = {
  id: Exclude<SmartShufflePresetId, "custom">;
  label: string;
  description: string;
  experience: SmartShuffleConfig["experience"];
  separation: SmartShuffleConfig["separation"];
};

export const SMART_SHUFFLE_PRESETS: readonly SmartShufflePreset[] = [
  {
    id: "balanced",
    label: "均衡随机",
    description: "兼顾随机性、曲风多样性和歌曲间隔。",
    experience: { randomness: 60, diversity: 50, repeatAvoidance: 80 },
    separation: { artist: 3, album: 2 },
  },
  {
    id: "random",
    label: "高度随机",
    description: "减少约束，让曲库中的歌曲更均匀地出现。",
    experience: { randomness: 90, diversity: 25, repeatAvoidance: 50 },
    separation: { artist: 1, album: 1 },
  },
  {
    id: "diverse",
    label: "多样性优先",
    description: "尽量避免连续听到相同歌手、专辑和曲风。",
    experience: { randomness: 40, diversity: 100, repeatAvoidance: 90 },
    separation: { artist: 6, album: 4 },
  },
];

/** 当前配置匹配哪个预设；都不匹配时返回 custom。 */
export function smartShufflePresetId(
  config: SmartShuffleConfig,
): SmartShufflePresetId {
  const preset = SMART_SHUFFLE_PRESETS.find(
    (item) =>
      item.experience.randomness === config.experience.randomness &&
      item.experience.diversity === config.experience.diversity &&
      item.experience.repeatAvoidance === config.experience.repeatAvoidance &&
      item.separation.artist === config.separation.artist &&
      item.separation.album === config.separation.album,
  );
  return preset?.id ?? "custom";
}

/** 应用预设：只替换听感参数，保留版本与预留的音乐特征字段。 */
export function applySmartShufflePreset(
  config: SmartShuffleConfig,
  preset: SmartShufflePreset,
): SmartShuffleConfig {
  return {
    ...config,
    experience: { ...preset.experience },
    separation: { ...preset.separation },
  };
}

/** 复制给用户看的 JSON：不包含尚未生效的 audioFeatures。 */
export function smartShuffleUserJson(config: SmartShuffleConfig): string {
  return JSON.stringify(
    {
      version: config.version,
      experience: config.experience,
      separation: config.separation,
    },
    null,
    2,
  );
}
