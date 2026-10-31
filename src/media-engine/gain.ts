/**
 * Shared audio graph 的纯增益计算。
 *
 * 这些常量是 Music + Noise 共用一个输出链路时的增益基线；实际节点在
 * `audio-graph.ts` 中应用。单独抽出是为了在没有 Web Audio 的测试环境里锁定
 * 增益/静音/削波余量，避免把“直接相加 PCM”写进实现。
 */

export const NOISE_TRACK_TRIM = 0.28;
export const NOISE_MASTER_TRIM = 0.8;
export const OUTPUT_HEADROOM = 0.9;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 总线增益：muted 时为 0，否则为 clamp 后的音量。 */
export function busGain(volume: number, muted: boolean): number {
  return muted ? 0 : clamp01(volume);
}

/** Noise 单轨增益：session 不在播放或 track 未启用时为 0。 */
export function trackGain(
  volume: number,
  enabled: boolean,
  sessionAudible: boolean,
): number {
  if (!enabled || !sessionAudible) return 0;
  return clamp01(volume) * NOISE_TRACK_TRIM;
}

/** 输出总线：master 音量再留一点余量，交给 limiter 兜底。 */
export function outputGain(volume: number, muted: boolean): number {
  return busGain(volume, muted) * OUTPUT_HEADROOM;
}

/** Noise 整体总线：session master 再留余量。 */
export function noiseBusGain(volume: number, muted: boolean): number {
  return busGain(volume, muted) * NOISE_MASTER_TRIM;
}
