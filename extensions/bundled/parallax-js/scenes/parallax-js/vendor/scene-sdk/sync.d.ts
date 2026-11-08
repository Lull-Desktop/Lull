/**
 * 跨屏同步相位：帧里给出宿主捕获的绝对时间锚点，
 * 用负 `animation-delay` 让所有窗口的周期动画对齐到同一绝对相位。
 *
 * ```css
 * .drift { animation-delay: var(--lull-sync-delay, 0ms); }
 * ```
 */
export declare function syncedDelayMs(periodMs: number, epochMs: number): number;
//# sourceMappingURL=sync.d.ts.map