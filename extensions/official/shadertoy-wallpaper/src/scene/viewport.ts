/**
 * 绘制尺寸计算（RFC §7.2）：CSS 像素 → 绘制缓冲像素，并施加渲染比例与像素上限。
 *
 * iResolution 必须是真实的绘制缓冲尺寸，不能拿 CSS px 顶替。
 */

export const MIN_RENDER_SCALE = 0.25;
export const MAX_RENDER_SCALE = 1;
/** 4K（3840×2160）像素数；超过就按比例缩小，避免壁纸常驻时把 GPU 打满。 */
export const MAX_DRAW_PIXELS = 3_840 * 2_160;
/** 多 Pass 时的单 Pass 像素预算（1080p）：每个 buffer 都有两张纹理，需控制显存。 */
export const MAX_MULTIPASS_PIXELS = 1_920 * 1_080;

export type ViewportInfo = {
  w: number;
  h: number;
  dpr: number;
};

export type DrawSize = {
  width: number;
  height: number;
  /** 实际生效的渲染比例（可能低于用户请求值）。 */
  scale: number;
};

export function clampRenderScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, value));
}

export function computeDrawSize(
  viewport: ViewportInfo,
  renderScale: number,
): DrawSize {
  const dpr =
    Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
  const cssWidth = Math.max(1, viewport.w);
  const cssHeight = Math.max(1, viewport.h);
  let scale = clampRenderScale(renderScale);
  let width = Math.max(1, Math.round(cssWidth * dpr * scale));
  let height = Math.max(1, Math.round(cssHeight * dpr * scale));

  const pixels = width * height;
  if (pixels > MAX_DRAW_PIXELS) {
    const factor = Math.sqrt(MAX_DRAW_PIXELS / pixels);
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
    // 像素上限优先于最小渲染比例：超宽屏/8K 下允许低于 0.25。
    scale *= factor;
  }

  return { width, height, scale };
}
