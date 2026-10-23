/**
 * 跨屏同步相位：帧里给出宿主捕获的绝对时间锚点，
 * 用负 `animation-delay` 让所有窗口的周期动画对齐到同一绝对相位。
 *
 * ```css
 * .drift { animation-delay: var(--lull-sync-delay, 0ms); }
 * ```
 */
export function syncedDelayMs(periodMs: number, epochMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  const delay = -(Math.max(0, epochMs) % periodMs);
  return delay === 0 ? 0 : delay;
}
