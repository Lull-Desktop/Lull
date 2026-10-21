/**
 * EtherBubbles 的声景模型：五种可独立混音的环境声及其初始状态。
 * 这里只描述「声音是什么」，不触碰 Web Audio；音频图在 use-ambient-mixer 中构建。
 */

export type SoundId = "rain" | "thunder" | "wind" | "waves" | "fire";

export type SoundDefinition = {
  id: SoundId;
  /** 大号单字，用于左侧竖排标题。 */
  glyph: string;
  /** 完整名称，用于无障碍标签和提示。 */
  label: string;
  /** 声音充满时的状态词。 */
  mood: string;
  /** 泡泡液体的主色。 */
  tone: string;
};

export const SOUNDS: readonly SoundDefinition[] = [
  {
    id: "rain",
    glyph: "雨",
    label: "雨声",
    mood: "润泽",
    tone: "#8ed9ff",
  },
  {
    id: "thunder",
    glyph: "雷",
    label: "雷鸣",
    mood: "低鸣",
    tone: "#b4a5ff",
  },
  {
    id: "wind",
    glyph: "风",
    label: "风声",
    mood: "穿林",
    tone: "#9fe4c2",
  },
  {
    id: "waves",
    glyph: "浪",
    label: "海浪",
    mood: "涨落",
    tone: "#8cb7ff",
  },
  {
    id: "fire",
    glyph: "火",
    label: "篝火",
    mood: "暖场",
    tone: "#ffc27c",
  },
];

export type ChannelState = {
  enabled: boolean;
  /** 关闭时保留上一次音量，重新点亮可以无缝恢复。 */
  level: number;
};

export type ChannelMap = Record<SoundId, ChannelState>;

export type MixState = {
  channels: ChannelMap;
  master: number;
  muted: boolean;
};

export const INITIAL_MASTER = 75;

/** 初始声场复刻设计稿：雨 / 风 / 火已点亮，雷与浪保持静默。 */
export function initialChannels(): ChannelMap {
  return {
    rain: { enabled: true, level: 70 },
    thunder: { enabled: false, level: 45 },
    wind: { enabled: true, level: 30 },
    waves: { enabled: false, level: 40 },
    fire: { enabled: true, level: 50 },
  };
}

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 亮着的泡泡显示真实音量；熄灭的泡泡显示 0%，但内部仍保留上次音量。 */
export function effectiveLevel(channel: ChannelState): number {
  return channel.enabled ? channel.level : 0;
}

export function channelMood(
  channel: ChannelState,
  definition: SoundDefinition,
): string {
  const level = effectiveLevel(channel);
  if (level === 0) return "静默";
  if (level <= 20) return "微光";
  if (level <= 55) return "初醒";
  if (level < 100) return definition.mood;
  return "满溢";
}

export function masterMood(master: number, muted: boolean): string {
  if (muted) return "静寂";
  if (master === 0) return "归零";
  if (master <= 25) return "低语";
  if (master <= 60) return "回响";
  if (master < 100) return "丰沛";
  return "满潮";
}
