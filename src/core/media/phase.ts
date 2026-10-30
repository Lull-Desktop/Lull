/**
 * 壁纸视频的墙钟相位。
 *
 * 所有壁纸窗共享同一台机器的 `Date.now()`，所以镜像/拼接模式下各屏算出的
 * 目标位置天然一致，不需要宿主注入锚点或跨窗 IPC。只在起播/恢复时 seek 一次，
 * 稳态靠播放器自己走；长时间漂移由调用方低频兜底。
 */

/**
 * 当前墙钟时刻在循环视频内的相位（秒）。
 *
 * `rate` 是 playbackRate：媒体时间按 `墙钟 × rate` 前进。时长未知（元数据未到、
 * 直播流、`NaN`）时返回 null，调用方跳过对齐。
 */
export function videoPhase(
  nowMs: number,
  durationSec: number,
  rate = 1,
): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const phase = ((nowMs / 1000) * speed) % durationSec;
  return phase < 0 ? phase + durationSec : phase;
}

/** 循环内两点的最短距离：把 loop 回卷的两端当作同一帧。 */
export function loopDistance(a: number, b: number, duration: number): number {
  const delta = Math.abs(a - b);
  return Math.min(delta, Math.max(0, duration - delta));
}

/**
 * 让视频跳到墙钟相位；偏差在容差内不动。
 *
 * seek 会 flush 解码器，因此这里只应在起播、恢复可见或低频兜底时调用，
 * 不要放进逐帧/高频定时器。
 */
export function alignVideoPhase(
  video: HTMLVideoElement,
  toleranceSec: number,
  rate = 1,
): void {
  const target = videoPhase(Date.now(), video.duration, rate);
  if (target === null) return;
  if (loopDistance(video.currentTime, target, video.duration) <= toleranceSec) {
    return;
  }
  video.currentTime = target;
}
