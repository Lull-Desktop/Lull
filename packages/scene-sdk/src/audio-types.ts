/**
 * 音频响应的场景侧类型与协议校验。
 *
 * 与宿主 `src/sdk/scene/audio.ts` 逐字段对应；两者都属于线上协议，改动必须同步，
 * 否则已发布的场景包会在宿主升级后静默失效。
 *
 * 只读视觉信号：不包含 PCM、音频文件路径、播放控制或音量控制。
 */

export const AUDIO_PROTOCOL = 1 as const;

export const AUDIO_SOURCES = ["music", "noise", "mix", "master"] as const;
export type AudioSource = (typeof AUDIO_SOURCES)[number];

export const AUDIO_FEATURES = [
  "level",
  "bands",
  "spectrum",
  "waveform",
] as const;
export type AudioFeature = (typeof AUDIO_FEATURES)[number];

/** 0–1 的视觉响应刻度；不等于 dB SPL，也不跨来源比较响度。 */
export interface AudioLevel {
  /** 原始均方根能量（未平滑）。 */
  rms: number;
  /** 原始峰值（未平滑）。 */
  peak: number;
  /** 归一化并按视觉策略平滑后的能量。 */
  normalized: number;
}

/**
 * 五段频段（0–1，对数刻度 + 逐段 AGC）。
 *
 * Media Engine 按 dB 能量平均后映射到 −70…−6 dBFS；Rust 侧每个频段围绕自己
 * 约 4s 的近期平均做 ±9 dB 归一化。持续段落通常停在 0.4–0.7，鼓点可达 0.8–1.0；
 * 阈值 0.7–0.85 适合做瞬态强调，整体响度请用 `level.normalized`。
 */
export interface AudioBands {
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
}

export interface AudioFrame {
  protocol: typeof AUDIO_PROTOCOL;
  /** 全局单调时间戳（ms）；同一 tick 的所有来源一致。 */
  timestamp: number;
  /** 每 tick 自增；同一 tick 的所有来源一致。 */
  sequence: number;
  source: AudioSource;
  /** 当前来源是否存在有效信号。 */
  active: boolean;
  level: AudioLevel;
  bands: AudioBands;
  /** P1：压缩频谱（32–64 bin）。 */
  spectrum?: number[];
  /** P1：时域波形。 */
  waveform?: number[];
}

export interface AudioSnapshot {
  protocol: typeof AUDIO_PROTOCOL;
  timestamp: number;
  sources: Record<AudioSource, AudioFrame | null>;
}

export type AudioStatusReason =
  | "not-authorized"
  | "not-supported"
  | "suspended"
  | "inactive";

export interface AudioStatus {
  available: boolean;
  sources: Record<AudioSource, boolean>;
  reason?: AudioStatusReason;
}

export interface AudioSubscribeOptions {
  sources?: AudioSource[];
  features?: AudioFeature[];
}

/** 宿主未做 Manifest 收窄时的默认订阅范围。 */
export const DEFAULT_AUDIO_SOURCES: readonly AudioSource[] = AUDIO_SOURCES;

/** P0 只有 level/bands 生效；spectrum/waveform 为 P1 预留。 */
export const DEFAULT_AUDIO_FEATURES: readonly AudioFeature[] = [
  "level",
  "bands",
];

const MAX_OPTIONAL_SERIES = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAudioSource(value: unknown): value is AudioSource {
  return (
    typeof value === "string" && AUDIO_SOURCES.includes(value as AudioSource)
  );
}

export function isAudioFeature(value: unknown): value is AudioFeature {
  return (
    typeof value === "string" && AUDIO_FEATURES.includes(value as AudioFeature)
  );
}

function isUnit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isUnitSeries(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_OPTIONAL_SERIES &&
    value.every(isUnit)
  );
}

export function isAudioLevel(value: unknown): value is AudioLevel {
  return (
    isRecord(value) &&
    isUnit(value.rms) &&
    isUnit(value.peak) &&
    isUnit(value.normalized)
  );
}

export function isAudioBands(value: unknown): value is AudioBands {
  return (
    isRecord(value) &&
    isUnit(value.bass) &&
    isUnit(value.lowMid) &&
    isUnit(value.mid) &&
    isUnit(value.highMid) &&
    isUnit(value.treble)
  );
}

export function isAudioFrame(value: unknown): value is AudioFrame {
  if (!isRecord(value)) return false;
  if (value.protocol !== AUDIO_PROTOCOL) return false;
  if (!isNonNegativeInt(value.timestamp)) return false;
  if (!isNonNegativeInt(value.sequence)) return false;
  if (!isAudioSource(value.source)) return false;
  if (typeof value.active !== "boolean") return false;
  if (!isAudioLevel(value.level)) return false;
  if (!isAudioBands(value.bands)) return false;
  if (value.spectrum !== undefined && !isUnitSeries(value.spectrum)) {
    return false;
  }
  if (value.waveform !== undefined && !isUnitSeries(value.waveform)) {
    return false;
  }
  return true;
}

export function isAudioSnapshot(value: unknown): value is AudioSnapshot {
  if (!isRecord(value)) return false;
  if (value.protocol !== AUDIO_PROTOCOL) return false;
  if (!isNonNegativeInt(value.timestamp)) return false;
  if (!isRecord(value.sources)) return false;
  for (const source of AUDIO_SOURCES) {
    const frame = value.sources[source];
    if (frame === null || frame === undefined) continue;
    if (!isAudioFrame(frame)) return false;
    if (frame.source !== source) return false;
  }
  return true;
}

export function isAudioStatus(value: unknown): value is AudioStatus {
  if (!isRecord(value)) return false;
  if (typeof value.available !== "boolean") return false;
  if (!isRecord(value.sources)) return false;
  for (const source of AUDIO_SOURCES) {
    if (typeof value.sources[source] !== "boolean") return false;
  }
  if (value.reason !== undefined) {
    const reason = value.reason;
    if (
      reason !== "not-authorized" &&
      reason !== "not-supported" &&
      reason !== "suspended" &&
      reason !== "inactive"
    ) {
      return false;
    }
  }
  return true;
}

export function isAudioSubscribeOptions(
  value: unknown,
): value is AudioSubscribeOptions {
  if (!isRecord(value)) return false;
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources)) return false;
    if (!value.sources.every(isAudioSource)) return false;
  }
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) return false;
    if (!value.features.every(isAudioFeature)) return false;
  }
  return true;
}

export function emptyAudioSnapshot(timestamp = 0): AudioSnapshot {
  return {
    protocol: AUDIO_PROTOCOL,
    timestamp,
    sources: { music: null, noise: null, mix: null, master: null },
  };
}

export function audioStatusAllFalse(reason?: AudioStatusReason): AudioStatus {
  return {
    available: false,
    sources: { music: false, noise: false, mix: false, master: false },
    reason,
  };
}

export function audioStatusAllTrue(): AudioStatus {
  return {
    available: true,
    sources: { music: true, noise: true, mix: true, master: true },
  };
}

/** 去重并保持声明顺序；未知值丢弃。 */
export function normalizeAudioSources(
  value: readonly unknown[] | undefined,
  fallback: readonly AudioSource[] = DEFAULT_AUDIO_SOURCES,
): AudioSource[] {
  if (!value) return [...fallback];
  const out: AudioSource[] = [];
  for (const item of value) {
    if (isAudioSource(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

export function normalizeAudioFeatures(
  value: readonly unknown[] | undefined,
  fallback: readonly AudioFeature[] = DEFAULT_AUDIO_FEATURES,
): AudioFeature[] {
  if (!value) return [...fallback];
  const out: AudioFeature[] = [];
  for (const item of value) {
    if (isAudioFeature(item) && !out.includes(item)) out.push(item);
  }
  return out;
}
