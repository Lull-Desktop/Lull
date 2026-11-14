/**
 * 音频特征提取的纯函数：时域 RMS/Peak 与五段频段聚合。
 *
 * 与 `audio-graph.ts` 的 AnalyserNode 读取解耦，便于在 jsdom 里直接用
 * `Float32Array` 做回归测试。所有输出 `0–1` 且有限。
 *
 * 刻度约定：
 * - `rms` 是真实均方根（不做 ×7.5 的仪表增益），保留动态范围交给
 *   Rust 的 adaptive 归一化处理；饱和会让视觉响应失去层次。
 * - `peak` 是真实绝对峰值，不放大（放大后长期停在 1）。
 * - 频段使用 `getFloatFrequencyData` 的 dB 值做能量平均，再按
 *   `AUDIO_BAND_DB_FLOOR…AUDIO_BAND_DB_CEIL` 线性映射到 0–1：即“对数模式”。
 *   不要退回 `getByteFrequencyData`：字节刻度在 −30 dBFS 以上全部截断为 255，
 *   低频会长期满格，视觉上无法回落。
 */
import type { AudioBands } from "@/sdk/scene";

/** 低于该 RMS 视为无有效信号（约 -66 dBFS）。 */
export const AUDIO_ACTIVE_RMS = 0.0005;

/**
 * 频段映射下限：低于该值视为静音（约 -70 dBFS）。
 *
 * 这是视觉刻度而不是物理声压；有意留出约 6 dB 的顶部余量，
 * 让瞬态仍能继续推高柱子，而不是一直贴在 1.0。
 */
export const AUDIO_BAND_DB_FLOOR = -70;

/** 频段映射上限：满幅正弦的峰值 bin 约 -6 dBFS。 */
export const AUDIO_BAND_DB_CEIL = -6;

/** 频段边界（Hz）；treble 上界会被采样率 Nyquist 截断。 */
export const AUDIO_BAND_EDGES: ReadonlyArray<{
  key: keyof AudioBands;
  lo: number;
  hi: number;
}> = [
  { key: "bass", lo: 20, hi: 250 },
  { key: "lowMid", lo: 250, hi: 500 },
  { key: "mid", lo: 500, hi: 2000 },
  { key: "highMid", lo: 2000, hi: 4000 },
  { key: "treble", lo: 4000, hi: 16000 },
];

export type TimeDomainMetrics = {
  rms: number;
  peak: number;
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 从 `getByteTimeDomainData` 的 8bit 采样计算 RMS 与峰值。
 *
 * 8bit 时域数据以 128 为静音中心；空数组返回 0。
 */
export function timeDomainMetrics(samples: Uint8Array): TimeDomainMetrics {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    const value = (sample - 128) / 128;
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sum / samples.length);
  return { rms: clamp01(rms), peak: clamp01(peak) };
}

/** 单帧是否算"有信号"；供 `AudioFrame.active` 使用。 */
export function isAudioActive(rms: number): boolean {
  return Number.isFinite(rms) && rms > AUDIO_ACTIVE_RMS;
}

function binFor(hz: number, sampleRate: number, binCount: number): number {
  const nyquist = sampleRate / 2;
  if (!Number.isFinite(hz) || nyquist <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, hz / nyquist));
  return Math.min(binCount, Math.round(ratio * binCount));
}

/** 把 dBFS 线性映射到 0–1；低于下限/非法值都是 0。 */
export function bandDbToUnit(db: number): number {
  if (!Number.isFinite(db) || db <= AUDIO_BAND_DB_FLOOR + 1e-9) return 0;
  return clamp01(
    (db - AUDIO_BAND_DB_FLOOR) / (AUDIO_BAND_DB_CEIL - AUDIO_BAND_DB_FLOOR),
  );
}

/**
 * 把 `getFloatFrequencyData` 的 dB 频谱聚合为五段。
 *
 * 每段先把 bin 的 dB 还原成功率再做算术平均（能量平均），
 * 最后取 dB 并映射到 0–1：这样宽频段（treble）不会被 bin 数量稀释，
 * 得到的也是“对数模式”的可视化刻度，而不是被字节刻度截断的线性值。
 * 空区间回落到相邻 bin，避免采样率过低导致某段恒为 0。
 */
export function bandValuesFromDb(
  frequency: Float32Array,
  sampleRate: number,
  fftSize: number,
): AudioBands {
  const binCount = frequency.length;
  const bands: AudioBands = {
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    treble: 0,
  };
  if (binCount === 0 || fftSize <= 0) return bands;

  const floorPower = 10 ** (AUDIO_BAND_DB_FLOOR / 10);
  for (const edge of AUDIO_BAND_EDGES) {
    const lo = Math.min(binCount - 1, binFor(edge.lo, sampleRate, binCount));
    const hi = Math.min(
      binCount,
      Math.max(lo + 1, binFor(edge.hi, sampleRate, binCount)),
    );
    let power = 0;
    for (let index = lo; index < hi; index += 1) {
      const db = frequency[index] ?? AUDIO_BAND_DB_FLOOR;
      const finite = Number.isFinite(db) ? db : AUDIO_BAND_DB_FLOOR;
      power += 10 ** (Math.max(finite, AUDIO_BAND_DB_FLOOR) / 10);
    }
    const mean = Math.max(power / (hi - lo), floorPower);
    bands[edge.key] = bandDbToUnit(10 * Math.log10(mean));
  }
  return bands;
}
