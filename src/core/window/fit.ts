/**
 * 无边框窗口的自适应尺寸计算：窗口高度 = 顶栏 + 内容高度，并限制在可用屏幕范围内。
 * 保持为纯函数，便于单测覆盖边界（内容过短 / 超出屏幕 / 上下限冲突）。
 */

/** 自绘顶栏高度（px），必须与 window-topbar.tsx 的 `h-10` 保持一致。 */
export const TOPBAR_HEIGHT = 40;

/** 窗口最小高度（px），与 Rust 侧 `min_inner_size` 的纵向值保持一致。 */
export const MIN_WINDOW_HEIGHT = 320;

/**
 * 按内容高度算出窗口应取的高度。
 *
 * @param contentHeight 内容区实际渲染高度（CSS px）
 * @param maxHeight 可用屏幕高度上限（通常是显示器工作区高度减去边距）
 * @returns 已经过上下限夹取的窗口高度（CSS px）
 */
export function fittedWindowHeight(
  contentHeight: number,
  maxHeight: number,
): number {
  const target = TOPBAR_HEIGHT + Math.max(0, contentHeight);
  // 上限低于下限时（超小屏 / 异常值）优先保证最小高度，避免负区间。
  const max = Math.max(MIN_WINDOW_HEIGHT, maxHeight);
  return Math.min(Math.max(target, MIN_WINDOW_HEIGHT), max);
}
