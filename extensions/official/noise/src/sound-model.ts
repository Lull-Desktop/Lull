/**
 * EtherBubbles 的动态轨模型：把后端 Session 音轨派生成显示视图。
 * 这里只描述「这条轨怎么显示」，不触碰 Web Audio；音频图在隐藏的 media-engine 中构建。
 *
 * 内置五种声景（noise:builtin:*）保留定制字标/配色/图标；其余轨按名称、
 * assetId 哈希与素材分类派生外观，轨数完全跟随 `NoiseSession.tracks`。
 */
import type { NoiseSession, NoiseTrack } from "@lull/media-sdk";

export type TrackIconKey =
  | "droplet"
  | "zap"
  | "leaf"
  | "waves"
  | "flame"
  | "cloud-rain"
  | "target"
  | "music"
  | "sparkles";

/** 某条轨的纯视觉派生（不含音量）。 */
export type TrackVisuals = {
  /** 大号单字，用于左侧竖排标题。 */
  glyph: string;
  /** 完整名称，用于无障碍标签和提示。 */
  label: string;
  /** 声音充满时的状态词。 */
  mood: string;
  /** 泡泡液体的主色。 */
  tone: string;
  /** 泡泡内的图形。 */
  icon: TrackIconKey;
};

/** 某条轨的显示层视图：视觉派生 + 音量派生，纯函数无副作用。 */
export type TrackView = TrackVisuals & {
  track: NoiseTrack;
  /** clampLevel(track.volume * 100)，0-100。 */
  level: number;
  /** 亮着的泡泡显示真实音量；熄灭的显示 0%。 */
  effective: number;
};

/** 内置五种声景的视觉兜底表：键为 assetId，值与旧版定制外观完全一致。 */
export const BUILTIN_VISUALS: Readonly<Record<string, TrackVisuals>> = {
  "noise:builtin:rain": {
    glyph: "雨",
    label: "雨声",
    mood: "润泽",
    tone: "#8ed9ff",
    icon: "droplet",
  },
  "noise:builtin:thunder": {
    glyph: "雷",
    label: "雷鸣",
    mood: "低鸣",
    tone: "#b4a5ff",
    icon: "zap",
  },
  "noise:builtin:wind": {
    glyph: "风",
    label: "风声",
    mood: "穿林",
    tone: "#9fe4c2",
    icon: "leaf",
  },
  "noise:builtin:waves": {
    glyph: "浪",
    label: "海浪",
    mood: "涨落",
    tone: "#8cb7ff",
    icon: "waves",
  },
  "noise:builtin:fire": {
    glyph: "火",
    label: "篝火",
    mood: "暖场",
    tone: "#ffc27c",
    icon: "flame",
  },
};

/** 与内置五色同调的粉彩池；按 assetId 哈希取色，同素材跨会话稳定。 */
export const PASTEL_TONES: readonly string[] = [
  "#8ed9ff",
  "#b4a5ff",
  "#9fe4c2",
  "#8cb7ff",
  "#ffc27c",
  "#ffb3c8",
  "#ffd9a0",
  "#a8e6cf",
  "#c9c2ff",
  "#9fd8d2",
];

/** 非内置轨在中高音量档的状态词。 */
export const GENERIC_MOOD = "回荡";

/** 丝带可视行上限；超出后 `.trackList` 内部滚动（安全网，正常使用 ≤8 轨）。 */
export const MAX_VISIBLE_ROWS = 8;

/** 素材→分类、分类→图标名（catalog 的 leaf/cloud-rain/waves/flame/target）。 */
export type LibraryMeta = {
  assetCategory: Map<string, string>;
  categoryIcon: Map<string, string>;
};

const CATEGORY_ICONS: Readonly<Record<string, TrackIconKey>> = {
  leaf: "leaf",
  "cloud-rain": "cloud-rain",
  waves: "waves",
  flame: "flame",
  target: "target",
};

/** FNV-1a 32-bit，用于 tone 派生。 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const CJK_RANGE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** 名称首码位：汉字原样、拉丁字母大写、其余回退 ♪。 */
function deriveGlyph(name: string): string {
  const first = [...name.trim()][0] ?? "";
  if (!first) return "♪";
  if (CJK_RANGE.test(first)) return first;
  return /^[a-z]$/i.test(first) ? first.toUpperCase() : "♪";
}

/** 纯视觉派生（不含音量）。先查内置兜底表，再按 name/assetId/meta 推导。 */
export function deriveTrackVisuals(
  assetId: string,
  name: string,
  meta?: LibraryMeta | null,
): TrackVisuals {
  const builtin = BUILTIN_VISUALS[assetId];
  if (builtin) return { ...builtin };
  const categoryId = meta?.assetCategory.get(assetId);
  const iconName = categoryId ? meta?.categoryIcon.get(categoryId) : undefined;
  return {
    glyph: deriveGlyph(name),
    label: name.trim() || "未命名轨道",
    mood: GENERIC_MOOD,
    tone: PASTEL_TONES[hashString(assetId) % PASTEL_TONES.length] ?? "#9fd8d2",
    icon: (iconName && CATEGORY_ICONS[iconName]) || "music",
  };
}

/** 组装完整视图；音量派生在这层完成。 */
export function toTrackView(
  track: NoiseTrack,
  meta?: LibraryMeta | null,
): TrackView {
  const level = clampLevel(track.volume * 100);
  return {
    track,
    ...deriveTrackVisuals(track.assetId, track.name, meta),
    level,
    effective: track.enabled ? level : 0,
  };
}

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function trackMood(view: Pick<TrackView, "mood" | "effective">): string {
  const level = view.effective;
  if (level === 0) return "静默";
  if (level <= 20) return "微光";
  if (level <= 55) return "初醒";
  if (level < 100) return view.mood;
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

export const INITIAL_MASTER = 75;

const DEMO_LEVELS: ReadonlyArray<{
  assetId: string;
  level: number;
  enabled: boolean;
}> = [
  { assetId: "noise:builtin:rain", level: 70, enabled: true },
  { assetId: "noise:builtin:thunder", level: 45, enabled: false },
  { assetId: "noise:builtin:wind", level: 30, enabled: true },
  { assetId: "noise:builtin:waves", level: 40, enabled: false },
  { assetId: "noise:builtin:fire", level: 50, enabled: true },
];

/** 演示/预览用假轨；id 与后端 `noise_track_*` 不冲突，不会被误发后端。 */
export function buildDemoTrack(
  assetId: string,
  overrides?: Partial<NoiseTrack>,
): NoiseTrack {
  const visuals = BUILTIN_VISUALS[assetId];
  return {
    id: `demo-${assetId.replace(/[^a-z0-9]+/gi, "-")}`,
    assetId,
    name: visuals?.label ?? assetId,
    state: "playing",
    volume: 0.5,
    enabled: true,
    loop: true,
    positionMs: 0,
    order: 0,
    ...overrides,
  };
}

/** 演示/预览兜底：无 Media Client 时的假会话，复刻旧版初始声场。 */
export function buildDemoSession(): NoiseSession {
  return {
    id: "demo",
    state: "playing",
    masterVolume: INITIAL_MASTER / 100,
    muted: false,
    tracks: DEMO_LEVELS.map((entry, index) =>
      buildDemoTrack(entry.assetId, {
        volume: entry.level / 100,
        enabled: entry.enabled,
        order: index,
      }),
    ),
    sleep: { timerMinutes: 0 },
    revision: 0,
    createdAt: 0,
  };
}
