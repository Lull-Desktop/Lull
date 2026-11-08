/**
 * 鼠标位置换算：把宿主的桌面物理坐标映射成场景绘制坐标系内的 CSS 像素。
 *
 * 宿主在 Tauri 事件里只给桌面物理坐标与移动状态；iframe 需要的是本地坐标：
 * - viewport 布局：本屏 iframe 左上角为原点（frame.view）；
 * - canvas 布局：共享画布左上角为原点（frame.canvas）。
 *
 * 这里不接触任何 DOM 鼠标事件，也不读取按键状态；点击/双击不会进入这条链路。
 */
import type { SceneFrame, ScenePointer } from "@/sdk/scene";

/** Tauri `wallpaper-pointer` 事件的载荷（桌面物理像素）。 */
export type DesktopPointerSample = {
  x: number;
  y: number;
  /** 光标是否落在桌面层（Progman / WorkerW），而不是其他应用窗口上。 */
  overDesktop: boolean;
  /** 宿主是否在最近约 120ms 内观察到移动。 */
  moving: boolean;
};

/** 运行时校验 Tauri 事件载荷；畸形数据直接丢弃，不影响场景。 */
export function isDesktopPointerSample(
  value: unknown,
): value is DesktopPointerSample {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.x === "number" &&
    Number.isFinite(record.x) &&
    typeof record.y === "number" &&
    Number.isFinite(record.y) &&
    typeof record.overDesktop === "boolean" &&
    typeof record.moving === "boolean"
  );
}

/**
 * 把桌面坐标换算成场景本地坐标。
 *
 * - `inside`：光标必须在桌面层上，且落在本场景绘制面内。span 布局下各屏
 *   iframe 都是整块画布，因此画布内的任意位置都算 inside；
 * - `moving`：只有桌面层上的移动才算，移出桌面后场景应淡出。
 * 没有几何信息（例如 URL 哈希缺失）时返回 null，调用方直接跳过该样本。
 */
export function pointerForFrame(
  frame: SceneFrame,
  sample: DesktopPointerSample,
): ScenePointer | null {
  const origin = frame.canvas ?? frame.view;
  if (!origin) return null;
  const dpr = Number.isFinite(frame.dpr) && frame.dpr > 0 ? frame.dpr : 1;
  const x = (sample.x - origin.x) / dpr;
  const y = (sample.y - origin.y) / dpr;
  const inside =
    sample.overDesktop &&
    x >= 0 &&
    y >= 0 &&
    x <= frame.viewport.w &&
    y <= frame.viewport.h;
  return {
    x,
    y,
    inside,
    moving: sample.overDesktop && sample.moving,
  };
}
