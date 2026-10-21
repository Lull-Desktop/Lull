/**
 * 同步动画相位：所有窗口共享同一个绝对时间锚点，
 * 负 animation-delay 让周期动画在挂载时对齐到同一相位。
 */
export function syncedDelayMs(periodMs: number, epochMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  const delay = -(Math.max(0, epochMs) % periodMs);
  return delay === 0 ? 0 : delay; // 规范化 -0
}
