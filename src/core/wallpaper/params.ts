/**
 * 壁纸参数纯函数模块：解析 URL 哈希，并计算显示模式、画布变换与同步动画相位。
 */

export type DisplayMode = "mirror" | "independent" | "span";

export type Rect = { x: number; y: number; w: number; h: number };

export type WallpaperParams = {
  mode: DisplayMode;
  sync: boolean;
  scene: string;
  canvas: Rect | null;
  view: Rect | null;
};

/**
 * 默认场景 id。内置场景注册表据此保持默认值一致；
 * 场景失配时 SceneHost 也会回退到这个 id。
 */
export const DEFAULT_SCENE_ID = "lull.bamboo";

export const DEFAULT_PARAMS: WallpaperParams = {
  mode: "mirror",
  sync: true,
  scene: DEFAULT_SCENE_ID,
  canvas: null,
  view: null,
};

const MODES: readonly DisplayMode[] = ["mirror", "independent", "span"];

function parseRect(raw: string | undefined): Rect | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(",");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n))) {
    return null;
  }
  return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
}

function decodeScene(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseWallpaperParams(hash: string): WallpaperParams {
  const fields = new Map<string, string>();
  for (const token of hash.replace(/^#/, "").split("&")) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      fields.set(token.slice(0, eq), token.slice(eq + 1));
    }
  }
  const rawMode = fields.get("mode");
  const mode = MODES.includes(rawMode as DisplayMode)
    ? (rawMode as DisplayMode)
    : DEFAULT_PARAMS.mode;
  const rawSync = fields.get("sync");
  const sync =
    rawSync === "0" ? false : rawSync === "1" ? true : DEFAULT_PARAMS.sync;
  const scene =
    decodeScene(fields.get("scene") ?? "").trim() || DEFAULT_PARAMS.scene;
  return {
    mode,
    sync,
    scene,
    canvas: parseRect(fields.get("canvas")),
    view: parseRect(fields.get("view")),
  };
}

/** 跨屏强制同步（接缝连续性）；独立恒不同步（spec §6.3：各自以页面加载起跑）；复制沿用用户开关。 */
export function resolveSync(mode: DisplayMode, sync: boolean): boolean {
  if (mode === "span") {
    return true;
  }
  if (mode === "independent") {
    return false;
  }
  return sync;
}

/**
 * 跨屏容器换算：画布单位 = 物理像素；容器 css 尺寸/偏移按本窗 dpr 折算。
 * 结果直接用于 style 的 width/height/left/top（父级 overflow hidden 负责裁切）。
 */
export function canvasTransform(
  canvas: Rect,
  view: Rect,
  dpr: number,
): { width: number; height: number; left: number; top: number } {
  // 规范化 -0（Object.is 下 -0 !== 0，会让断言与样式输出都变得不稳定）。
  const norm = (n: number): number => (n === 0 ? 0 : n);
  return {
    width: canvas.w / dpr,
    height: canvas.h / dpr,
    left: norm(-(view.x - canvas.x) / dpr),
    top: norm(-(view.y - canvas.y) / dpr),
  };
}

/**
 * 同步锚定：负 animation-delay = 从周期中途起播，所有窗相位一致。
 * 用绝对时间（而非帧累加）——WebView 被遮挡时 Chromium 挂起渲染，帧累加必漂移。
 */
export function syncedDelayMs(periodMs: number, nowMs: number): number {
  const phase = nowMs % periodMs;
  return phase === 0 ? 0 : -phase; // 规范化 -0
}
