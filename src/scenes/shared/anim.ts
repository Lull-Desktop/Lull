/**
 * 场景共享的纯函数：同步相位与跨屏画布尺寸。
 */
import { type SceneRect, type SceneSync, syncedDelayMs } from "@/sdk/scene";

/** 同步模式下用负 animation-delay 从周期中途起播；异步模式返回 undefined。 */
export function delay(periodMs: number, sync: SceneSync): string | undefined {
  return sync.enabled
    ? `${syncedDelayMs(periodMs, sync.epochMs)}ms`
    : undefined;
}

export function canvasSize(canvas: SceneRect | null): { w: number; h: number } {
  return { w: canvas?.w ?? 1920, h: canvas?.h ?? 1080 };
}

/**
 * 跨屏画布上的字号：画布物理像素通常远大于 CSS 像素，
 * 这里按画布宽度做温和缩放，避免 4K 拼接副屏上的文字小到不可读。
 */
export function canvasFont(canvas: SceneRect | null, base: number): number {
  const { w } = canvasSize(canvas);
  return Math.round(Math.max(base, Math.min(base * 2.4, w * 0.021)));
}
