/**
 * Widget 运行时门面：能力校验、受限状态、窗口 chrome 与媒体闸门。
 *
 * 这是 `src/sdk/**` 唯一允许直接依赖宿主实现（`src/core/window`）的边：
 * Rust 在窗口创建时注入 `window.__LULL_WIDGET__`，这里的每个入口都先查能力；
 * 浏览器预览 / 单元测试没有注入，按“开发环境”放行，Tauri 里缺上下文则失败关闭。
 */
import {
  alignPlayerWindow,
  hideWindow,
  isDesktopWindow,
  isWindowMinimizable,
  minimizeWindow,
  onWindowPrefsChanged,
  setWindowResizable,
  setWindowWidth,
  startWindowDrag,
} from "@/core/window/controls";
import { parseWidgetContext } from "./manifest";
import type { WidgetCapability, WidgetContext } from "./types";

declare global {
  interface Window {
    /**
     * Rust 在页面脚本执行前注入的 Widget 上下文。
     * 内置页面与宿主同信任级；第三方页面必须走独立源 iframe，不能依赖这个全局变量。
     */
    __LULL_WIDGET__?: unknown;
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

let cachedContext: WidgetContext | null | undefined;
const denied = new Set<WidgetCapability>();

export class WidgetCapabilityError extends Error {
  readonly capability: WidgetCapability;

  constructor(capability: WidgetCapability, detail?: string) {
    super(detail ? `${capability} 未授权：${detail}` : `${capability} 未授权`);
    this.name = "WidgetCapabilityError";
    this.capability = capability;
  }
}

/** 测试用：清掉上下文缓存与失败日志去重。 */
export function resetWidgetRuntimeForTests(): void {
  cachedContext = undefined;
  denied.clear();
}

/** 当前窗口的宿主上下文；浏览器 / jsdom 下返回 null。 */
export function getWidgetContext(): WidgetContext | null {
  if (cachedContext !== undefined) return cachedContext;
  if (typeof window === "undefined") {
    cachedContext = null;
    return null;
  }
  const injected = window.__LULL_WIDGET__;
  cachedContext = injected === undefined ? null : parseWidgetContext(injected);
  return cachedContext;
}

/** 是否运行在 Tauri 宿主里（不依赖上下文注入）。 */
export function isWidgetHosted(): boolean {
  return isDesktopWindow();
}

/** 能力是否可用。没有上下文时：浏览器放行，Tauri 失败关闭。 */
export function hasWidgetCapability(capability: WidgetCapability): boolean {
  const context = getWidgetContext();
  if (context) return context.capabilities.includes(capability);
  return !isWidgetHosted();
}

function deny(capability: WidgetCapability, detail?: string): void {
  if (denied.has(capability)) return;
  denied.add(capability);
  console.warn(
    `[widget] ${capability} 未授权，本次调用已忽略${detail ? `（${detail}）` : ""}`,
  );
}

/** 严格入口：能力缺失时抛错，供页面初始化或测试断言使用。 */
export function requireWidgetCapability(
  capability: WidgetCapability,
  detail?: string,
): void {
  if (hasWidgetCapability(capability)) return;
  deny(capability, detail);
  throw new WidgetCapabilityError(capability, detail);
}

/**
 * 把状态键约束在 `lull:<id>:<key>` 命名空间里。
 * 窗口上下文存在时必须与 id 一致，避免 A 工具读写 B 工具的状态。
 */
export function widgetStorageKey(id: string, key: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`[widget] 非法 widget id: ${id}`);
  }
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error(`[widget] 非法状态键: ${key}`);
  }
  const context = getWidgetContext();
  if (context && context.id !== id) {
    throw new Error(
      `[widget] 状态命名空间不属于当前窗口：${context.id} 不能访问 ${id}`,
    );
  }
  return `lull:${id}:${key}`;
}

/** 读取自己的状态；能力缺失或存储不可用时返回 null。 */
export function readWidgetStorage(id: string, key: string): string | null {
  if (!hasWidgetCapability("widget.state")) {
    deny("widget.state", `读取 ${id}:${key}`);
    return null;
  }
  const storageKey = widgetStorageKey(id, key);
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    // 存储被禁用（隐私模式 / 配额）时按无状态处理，不影响本次会话。
    return null;
  }
}

/** 写入自己的状态；返回是否真正落盘。 */
export function writeWidgetStorage(
  id: string,
  key: string,
  value: string,
): boolean {
  if (!hasWidgetCapability("widget.state")) {
    deny("widget.state", `写入 ${id}:${key}`);
    return false;
  }
  const storageKey = widgetStorageKey(id, key);
  try {
    window.localStorage.setItem(storageKey, value);
    return true;
  } catch {
    return false;
  }
}

/** 音频是否可用：未授权时工具应静音运行，而不是报错。 */
export function isWidgetAudioAvailable(): boolean {
  if (hasWidgetCapability("widget.audio")) return true;
  deny("widget.audio");
  return false;
}

/** 媒体（本地文件 / 曲库）是否可用。 */
export function isWidgetMediaAvailable(): boolean {
  if (hasWidgetCapability("widget.media")) return true;
  deny("widget.media");
  return false;
}

function runChrome(detail: string, action: () => Promise<void>): Promise<void> {
  if (!hasWidgetCapability("widget.chrome")) {
    deny("widget.chrome", detail);
    return Promise.resolve();
  }
  return action();
}

/** 隐藏当前窗口（关闭 = 隐藏到托盘）。 */
export function widgetHideWindow(): Promise<void> {
  return runChrome("隐藏窗口", () => hideWindow());
}

/** 最小化当前窗口。 */
export function widgetMinimizeWindow(): Promise<void> {
  return runChrome("最小化窗口", () => minimizeWindow());
}

/** 显式发起系统拖拽（按钮式拖动区）。 */
export function widgetStartWindowDrag(): Promise<void> {
  return runChrome("拖动窗口", () => startWindowDrag());
}

/** 开关窗口缩放（锁定浮窗时同时关掉边缘拖拽）。 */
export function widgetSetResizable(resizable: boolean): Promise<void> {
  return runChrome("切换缩放", () => setWindowResizable(resizable));
}

/** 当前窗口是否允许最小化；无能力或非 Tauri 时为 false。 */
export function widgetIsMinimizable(): Promise<boolean> {
  if (!hasWidgetCapability("widget.chrome")) {
    deny("widget.chrome", "查询最小化能力");
    return Promise.resolve(false);
  }
  return isWindowMinimizable();
}

/** 订阅全局窗口偏好（任务栏 / 最小化）变化；无能力时返回空退订。 */
export function onWidgetPrefsChanged(handler: () => void): () => void {
  if (!hasWidgetCapability("widget.chrome")) {
    deny("widget.chrome", "订阅窗口偏好");
    return () => {};
  }
  return onWindowPrefsChanged(handler);
}

/**
 * 把请求宽度夹在清单声明的 `[minWidth, width]` 之间。
 * 初始宽度即该工具允许的最大画布宽度，避免工具把自己撑出设计范围。
 */
function clampChromeWidth(width: number): number {
  const context = getWidgetContext();
  if (!context) return width;
  const { minWidth } = context.window;
  const maxWidth = Math.max(context.window.width, minWidth);
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

/** 只改窗口宽度：`anchor` 决定固定哪条竖边。 */
export function widgetResizeWidth(
  width: number,
  anchor: "left" | "right" = "left",
): Promise<void> {
  if (!hasWidgetCapability("widget.chrome")) {
    deny("widget.chrome", "调整窗口宽度");
    return Promise.resolve();
  }
  return setWindowWidth(clampChromeWidth(width), anchor);
}

/** 换边时同时改宽度与横向位置，保持工具锚点在屏幕上的坐标不变。 */
export function widgetAlignPlayer(
  currentSide: "left" | "right",
  nextSide: "left" | "right",
  targetWidth: number,
  playerAnchor: number,
): Promise<void> {
  if (!hasWidgetCapability("widget.chrome")) {
    deny("widget.chrome", "换边");
    return Promise.resolve();
  }
  return alignPlayerWindow(
    currentSide,
    nextSide,
    clampChromeWidth(targetWidth),
    playerAnchor,
  );
}
