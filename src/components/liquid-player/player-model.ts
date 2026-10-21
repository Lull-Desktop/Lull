/**
 * Liquid Player 的纯数据与纯函数层：
 * 曲目、封面色板、播放模式、本地曲名解析、偏好持久化都在这里，
 * 组件只负责把它们映射成玻璃 UI；这样模型可以在 Vitest 里脱离 DOM 单测。
 */

export type PlayerSource = "local" | "online";

export type PlayMode = "sequence" | "shuffle" | "repeat-one";

export type CoverPalette = {
  id: string;
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  sun: string;
  sunGlow: string;
  far: string;
  mid: string;
  near: string;
  water: string;
  waterLight: string;
  accent: string;
  accentSoft: string;
  night: boolean;
  aurora: boolean;
  sunX: number;
  sunY: number;
  sunR: number;
};

/**
 * 在线精选曲目的「行封面」。
 * 全部由 SVG 现绘，不依赖网络图片；同一套色板同时驱动主球氛围光、进度环与列表缩略图。
 */
const AURORA_LAKE: CoverPalette = {
  id: "aurora-lake",
  skyTop: "#071a2e",
  skyMid: "#1e5d78",
  skyBottom: "#f0a46b",
  sun: "#ffe6b0",
  sunGlow: "rgba(255, 195, 124, 0.62)",
  far: "#3c6b7e",
  mid: "#1d495e",
  near: "#071f2d",
  water: "#0a2938",
  waterLight: "#7ed6e8",
  accent: "#8fe4ff",
  accentSoft: "rgba(143, 228, 255, 0.42)",
  night: false,
  aurora: true,
  sunX: 212,
  sunY: 118,
  sunR: 24,
};

export const COVER_PALETTES: readonly CoverPalette[] = [
  AURORA_LAKE,
  {
    id: "star-sea",
    skyTop: "#050b24",
    skyMid: "#152f62",
    skyBottom: "#2e6d8f",
    sun: "#d7f5ff",
    sunGlow: "rgba(167, 219, 255, 0.48)",
    far: "#2b4b74",
    mid: "#132b50",
    near: "#06152b",
    water: "#071c38",
    waterLight: "#8fd7ff",
    accent: "#8fe4ff",
    accentSoft: "rgba(143, 228, 255, 0.38)",
    night: true,
    aurora: false,
    sunX: 88,
    sunY: 78,
    sunR: 20,
  },
  {
    id: "moonlit",
    skyTop: "#160b2b",
    skyMid: "#4a285f",
    skyBottom: "#b8648f",
    sun: "#ffd7ef",
    sunGlow: "rgba(255, 183, 228, 0.44)",
    far: "#5b3a75",
    mid: "#342049",
    near: "#160b24",
    water: "#26102f",
    waterLight: "#ff9ddd",
    accent: "#ff9ddd",
    accentSoft: "rgba(255, 157, 221, 0.42)",
    night: true,
    aurora: false,
    sunX: 214,
    sunY: 92,
    sunR: 25,
  },
  {
    id: "dream-tide",
    skyTop: "#0a2037",
    skyMid: "#23617a",
    skyBottom: "#8ed6d0",
    sun: "#ffe8c2",
    sunGlow: "rgba(255, 226, 184, 0.4)",
    far: "#2f6d7c",
    mid: "#174a5b",
    near: "#082633",
    water: "#0b2f3a",
    waterLight: "#b8a4ff",
    accent: "#b8a4ff",
    accentSoft: "rgba(184, 164, 255, 0.4)",
    night: false,
    aurora: true,
    sunX: 152,
    sunY: 76,
    sunR: 18,
  },
  {
    id: "return-current",
    skyTop: "#061a2a",
    skyMid: "#0e4b58",
    skyBottom: "#45b6ae",
    sun: "#a6fff2",
    sunGlow: "rgba(141, 255, 226, 0.38)",
    far: "#1e5e66",
    mid: "#0d3942",
    near: "#031a22",
    water: "#062b31",
    waterLight: "#8dffe2",
    accent: "#8dffe2",
    accentSoft: "rgba(141, 255, 226, 0.4)",
    night: true,
    aurora: true,
    sunX: 236,
    sunY: 98,
    sunR: 17,
  },
  {
    id: "last-light",
    skyTop: "#2a1026",
    skyMid: "#7c2f45",
    skyBottom: "#f2a26b",
    sun: "#fff1c9",
    sunGlow: "rgba(255, 210, 152, 0.58)",
    far: "#7a3a4f",
    mid: "#4b2037",
    near: "#22101d",
    water: "#331827",
    waterLight: "#ffb56f",
    accent: "#ffb56f",
    accentSoft: "rgba(255, 181, 111, 0.45)",
    night: false,
    aurora: false,
    sunX: 104,
    sunY: 126,
    sunR: 30,
  },
];

export type AmbientPreset = {
  /** 每分钟拍数；一小节固定四拍。 */
  bpm: number;
  /** 四小节循环，每个和弦是一组 MIDI 音高。 */
  chords: readonly (readonly number[])[];
  /** 高音铃的候选 MIDI 音高。 */
  melody: readonly number[];
  wave: "sine" | "triangle";
  /** 低通滤波截止频率，越高越亮。 */
  brightness: number;
  /** 空气底噪电平，0–1。 */
  air: number;
  seed: number;
};

export type PlayerTrack = {
  id: string;
  title: string;
  artist: string;
  /** 秒；本地文件在元数据回来前是 0。 */
  duration: number;
  source: PlayerSource;
  /** COVER_PALETTES 的下标。 */
  tone: number;
  /** 本地曲目的 object URL。 */
  url?: string;
  /** 在线精选曲目的实时合成参数。 */
  ambient?: AmbientPreset;
};

/** 在线精选：设计稿里的六首曲目，用本地实时合成替代网络串流。 */
export const ONLINE_TRACKS: readonly PlayerTrack[] = [
  {
    id: "online-beyond-the-horizon",
    title: "Beyond the Horizon",
    artist: "Aurora Lane",
    duration: 252,
    source: "online",
    tone: 0,
    ambient: {
      bpm: 54,
      chords: [
        [50, 57, 62, 66],
        [47, 54, 59, 62],
        [43, 50, 55, 59],
        [45, 52, 57, 61],
      ],
      melody: [74, 78, 81, 76, 73, 69, 74, 81],
      wave: "sine",
      brightness: 1650,
      air: 0.14,
      seed: 7,
    },
  },
  {
    id: "online-star-sea",
    title: "星海漫游",
    artist: "Lumine",
    duration: 236,
    source: "online",
    tone: 1,
    ambient: {
      bpm: 48,
      chords: [
        [45, 52, 57, 60],
        [41, 48, 53, 57],
        [43, 50, 55, 58],
        [40, 47, 52, 55],
      ],
      melody: [76, 72, 69, 67, 64, 69, 72, 79],
      wave: "sine",
      brightness: 1250,
      air: 0.2,
      seed: 19,
    },
  },
  {
    id: "online-moonlit-solitude",
    title: "月光下的孤独",
    artist: "The Midnight",
    duration: 265,
    source: "online",
    tone: 2,
    ambient: {
      bpm: 46,
      chords: [
        [42, 49, 54, 57],
        [38, 45, 50, 54],
        [45, 52, 57, 61],
        [44, 51, 56, 59],
      ],
      melody: [73, 69, 66, 61, 66, 69, 76, 73],
      wave: "triangle",
      brightness: 980,
      air: 0.12,
      seed: 31,
    },
  },
  {
    id: "online-lost-in-dreams",
    title: "Lost in Dreams",
    artist: "Silva",
    duration: 228,
    source: "online",
    tone: 3,
    ambient: {
      bpm: 50,
      chords: [
        [51, 58, 63, 67],
        [48, 55, 60, 63],
        [46, 53, 58, 62],
        [43, 50, 55, 58],
      ],
      melody: [75, 70, 67, 63, 67, 72, 75, 82],
      wave: "sine",
      brightness: 1480,
      air: 0.18,
      seed: 43,
    },
  },
  {
    id: "online-back-to-future",
    title: "回到未来",
    artist: "Echoes",
    duration: 260,
    source: "online",
    tone: 4,
    ambient: {
      bpm: 58,
      chords: [
        [48, 55, 60, 63],
        [44, 51, 56, 60],
        [46, 53, 58, 62],
        [43, 50, 55, 58],
      ],
      melody: [72, 75, 79, 82, 79, 75, 72, 70],
      wave: "triangle",
      brightness: 1750,
      air: 0.16,
      seed: 59,
    },
  },
  {
    id: "online-the-last-light",
    title: "The Last Light",
    artist: "Sunset Riders",
    duration: 312,
    source: "online",
    tone: 5,
    ambient: {
      bpm: 44,
      chords: [
        [43, 50, 55, 59],
        [40, 47, 52, 55],
        [36, 43, 48, 52],
        [38, 45, 50, 54],
      ],
      melody: [74, 71, 67, 62, 67, 71, 74, 79],
      wave: "sine",
      brightness: 1120,
      air: 0.22,
      seed: 71,
    },
  },
];

export const PLAY_MODE_OPTIONS = [
  { id: "sequence", label: "顺序播放" },
  { id: "shuffle", label: "随机播放" },
  { id: "repeat-one", label: "单曲循环" },
] as const satisfies readonly { id: PlayMode; label: string }[];

export function playModeLabel(mode: PlayMode): string {
  return (
    PLAY_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? "顺序播放"
  );
}

export function isPlayMode(value: unknown): value is PlayMode {
  return PLAY_MODE_OPTIONS.some((option) => option.id === value);
}

export function nextPlayMode(mode: PlayMode): PlayMode {
  const index = PLAY_MODE_OPTIONS.findIndex((option) => option.id === mode);
  const next = PLAY_MODE_OPTIONS[(index + 1) % PLAY_MODE_OPTIONS.length];
  return next?.id ?? "sequence";
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 列表时长：本地文件元数据未到时用占位符，而不是误导性的 00:00。 */
export function formatTrackDuration(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0
    ? formatClock(seconds)
    : "--:--";
}

export function totalDuration(tracks: readonly PlayerTrack[]): number {
  return tracks.reduce(
    (sum, track) =>
      sum + (Number.isFinite(track.duration) ? track.duration : 0),
    0,
  );
}

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 78;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function coverPalette(tone: number): CoverPalette {
  if (!Number.isFinite(tone)) return AURORA_LAKE;
  const index =
    ((Math.trunc(tone) % COVER_PALETTES.length) + COVER_PALETTES.length) %
    COVER_PALETTES.length;
  return COVER_PALETTES[index] ?? AURORA_LAKE;
}

/** 用一个稳定哈希把本地文件名映射到封面色板，同名文件每次打开颜色一致。 */
export function coverToneForText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % COVER_PALETTES.length;
}

/** 从「Artist - Title.mp3」里拆出艺术家与标题；失败时用文件名兜底。 */
export function parseTrackName(fileName: string): {
  title: string;
  artist: string;
} {
  const cleaned = fileName.replace(/\.[^.]+$/, "").trim();
  if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) {
    return { title: "未命名音频", artist: "本地曲目" };
  }
  const parts = cleaned.split(/\s+[-–—]\s+/);
  const artist = parts.length > 1 ? parts[0]?.trim() : "";
  const title = parts.length > 1 ? parts.slice(1).join(" - ").trim() : cleaned;
  return {
    title: title || cleaned,
    artist: artist || "本地曲目",
  };
}

/**
 * 自动切下一首的索引。repeat-one 由调用方直接重播当前曲目，
 * 这里的随机模式会避开当前行，列表只有一首时仍返回 0。
 */
export function nextIndexForMode(
  currentIndex: number,
  length: number,
  mode: PlayMode,
  random: () => number = Math.random,
): number {
  if (length <= 0) return 0;
  if (length === 1) return 0;
  if (mode === "shuffle") {
    const base = ((currentIndex % length) + length) % length;
    const offset = 1 + Math.floor(random() * (length - 1));
    return (base + offset) % length;
  }
  return (currentIndex + 1) % length;
}

export function previousIndex(currentIndex: number, length: number): number {
  if (length <= 0) return 0;
  return (currentIndex - 1 + length) % length;
}

export function findTrackById(
  tracks: readonly PlayerTrack[],
  id: string,
): PlayerTrack | null {
  return tracks.find((track) => track.id === id) ?? null;
}

export const PLAYER_PREFS_KEY = "lull:player:v1";

export type PlayerPrefs = {
  mode: PlayMode;
  volume: number;
};

export function readPlayerPrefs(): Partial<PlayerPrefs> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PLAYER_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    const prefs: Partial<PlayerPrefs> = {};
    if (isPlayMode(value.mode)) prefs.mode = value.mode;
    if (typeof value.volume === "number")
      prefs.volume = clampVolume(value.volume);
    return prefs;
  } catch {
    return {};
  }
}

export function persistPlayerPrefs(prefs: PlayerPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用只影响下次启动的默认值，不影响本次播放。
  }
}
