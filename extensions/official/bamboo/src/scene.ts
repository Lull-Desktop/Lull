/**
 * 竹影场景的 DOM 状态层：把宿主下发的 SceneFrame 写到 CSS 变量与内联样式上。
 *
 * 这里不依赖 React / 宿主 CSS，所有选择器都属于包内页面；测试直接拿
 * jsdom document 断言雾浓度、同步相位与画布字号，避免官方场景回归靠肉眼。
 */
import { type SceneFrame, syncedDelayMs } from "@lull/scene-sdk";

type MistBand = {
  id: string;
  baseHeight: number;
  alpha: number;
  periodMs: number;
};

type Stalk = {
  id: string;
  periodMs: number;
};

export const MIST_BANDS: readonly MistBand[] = [
  { id: "mist-band-0", baseHeight: 18, alpha: 0.5, periodMs: 26000 },
  { id: "mist-band-1", baseHeight: 14, alpha: 0.42, periodMs: 31000 },
  { id: "mist-band-2", baseHeight: 11, alpha: 0.34, periodMs: 23000 },
];

export const STALKS: readonly Stalk[] = [
  { id: "stalk-0", periodMs: 11000 },
  { id: "stalk-1", periodMs: 9000 },
  { id: "stalk-2", periodMs: 13000 },
  { id: "stalk-3", periodMs: 12000 },
  { id: "stalk-4", periodMs: 10000 },
  { id: "stalk-5", periodMs: 14000 },
];

const MOON_PERIOD_MS = 9000;
const DEFAULT_MIST = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mistFrom(frame: SceneFrame): number {
  return typeof frame.params.mist === "number"
    ? clamp01(frame.params.mist)
    : DEFAULT_MIST;
}

function canvasWidth(frame: SceneFrame): number {
  return frame.canvas?.w ?? 1920;
}

/** 跨屏画布上的字号：画布物理像素通常远大于 CSS 像素，按宽度温和缩放。 */
export function canvasFont(canvasW: number, base: number): number {
  return Math.round(Math.max(base, Math.min(base * 2.4, canvasW * 0.021)));
}

function element(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

/** 把一帧写到页面上；重复调用是幂等的。 */
export function applySceneFrame(root: Document, frame: SceneFrame): void {
  const scene = element(root, "scene");
  if (!scene) return;

  const mist = mistFrom(frame);
  const isCanvas = frame.layout === "canvas";
  scene.dataset.layout = frame.layout;
  scene.dataset.reducedMotion = String(frame.reducedMotion);

  const veil = element(root, "mist-veil");
  if (veil) veil.style.opacity = String(mist * 0.62);

  for (const band of MIST_BANDS) {
    const node = element(root, band.id);
    if (!node) continue;
    node.style.opacity = String(mist * band.alpha);
    node.style.height = `${band.baseHeight + mist * 6}%`;
    node.style.animationDuration = `${band.periodMs / 1000}s`;
    setSyncDelay(node, band.periodMs, frame, null);
  }

  const moon = element(root, "moon");
  if (moon) {
    moon.style.animationDuration = `${MOON_PERIOD_MS / 1000}s`;
    setSyncDelay(moon, MOON_PERIOD_MS, frame, null);
  }

  for (const stalk of STALKS) {
    const node = element(root, stalk.id);
    if (!node) continue;
    node.style.animationDuration = `${stalk.periodMs / 1000}s`;
    setSyncDelay(node, stalk.periodMs, frame, node.dataset.staticDelay ?? null);
  }

  const width = canvasWidth(frame);
  const wordmarkSize = isCanvas ? canvasFont(width, 40) : 40;
  const clockSize = isCanvas ? canvasFont(width, 88) : 88;
  const subtitleSize = isCanvas ? canvasFont(width, 20) : 20;
  scene.style.setProperty("--wordmark-size", `${wordmarkSize}px`);
  scene.style.setProperty("--clock-size", `${clockSize}px`);
  scene.style.setProperty("--subtitle-size", `${subtitleSize}px`);

  const label = element(root, "canvas-label");
  if (label) {
    label.hidden = !isCanvas;
    if (isCanvas)
      label.textContent = `${frame.canvas?.w ?? width}×${frame.canvas?.h ?? 1080} · CANVAS`;
  }
}

function setSyncDelay(
  node: HTMLElement,
  periodMs: number,
  frame: SceneFrame,
  fallback: string | null,
): void {
  if (frame.sync.enabled) {
    node.style.animationDelay = `${syncedDelayMs(periodMs, frame.sync.epochMs)}ms`;
  } else if (fallback) {
    node.style.animationDelay = fallback;
  } else {
    node.style.removeProperty("animation-delay");
  }
}

/** 每秒刷新一次本地时钟；返回清理函数，便于测试与页面卸载。 */
export function startClock(root: Document): () => void {
  const node = element(root, "clock");
  if (!node) return () => {};
  const update = (): void => {
    node.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
    });
  };
  update();
  const timer = window.setInterval(update, 1000);
  return () => window.clearInterval(timer);
}
