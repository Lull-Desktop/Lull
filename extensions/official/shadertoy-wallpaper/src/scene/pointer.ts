/**
 * 指针 → iMouse（RFC §7.1）。
 *
 * 输入是 `@lull/scene-sdk` 的 `ScenePointer`：场景绘制坐标系里的 CSS 像素，
 * 原点是左上角；`iMouse.xy` 需要绘制缓冲像素、原点左下（与 gl_FragCoord 一致）。
 *
 * Shadertoy 的 `iMouse` 在指针离开画布后保留最后位置，而不是清零；宿主只在
 * `inside=true` 时给出有效坐标，因此这里单独记住最后一个有效样本。Lull 的指针
 * 通道没有按键字段，`zw` 恒为 0（Shadertoy 的初始/未点击状态）。
 */
import type { ScenePointer } from "@lull/scene-sdk";

export type MouseUniform = [number, number, number, number];

/** 最后一次有效的指针位置（场景本地 CSS 像素，左上角原点）。 */
export type MousePoint = { x: number; y: number };

export type MouseTracker = {
  /** 只接受落在绘制面内的有限坐标；其余样本被忽略。 */
  update(pointer: ScenePointer): void;
  /** 用当前视口与绘制缓冲尺寸把最后位置换算成 iMouse。 */
  resolve(
    viewport: { w: number; h: number },
    draw: { width: number; height: number },
  ): MouseUniform;
  reset(): void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 把“最后位置”换算成 iMouse。没有有效位置时返回 Shadertoy 的初始状态
 * `(0, 0, 0, 0)`，避免 shader 看到负坐标后把光标画到画面外。
 */
export function pointerToMouse(
  pointer: MousePoint | null,
  viewport: { w: number; h: number },
  draw: { width: number; height: number },
): MouseUniform {
  if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
    return [0, 0, 0, 0];
  }

  const width = dimension(draw.width);
  const height = dimension(draw.height);
  const viewportWidth = dimension(viewport.w);
  const viewportHeight = dimension(viewport.h);

  return [
    clamp(pointer.x * (width / viewportWidth), 0, width),
    clamp(height - pointer.y * (height / viewportHeight), 0, height),
    0,
    0,
  ];
}

export function createMouseTracker(): MouseTracker {
  let last: MousePoint | null = null;

  return {
    update(pointer) {
      if (!pointer.inside) return;
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return;
      last = { x: pointer.x, y: pointer.y };
    },
    resolve(viewport, draw) {
      return pointerToMouse(last, viewport, draw);
    },
    reset() {
      last = null;
    },
  };
}
