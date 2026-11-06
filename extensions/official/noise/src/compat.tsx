/**
 * 官方白噪音包的宿主兼容层。
 *
 * 组件原本直接 import 宿主的 `@/sdk/widget` / `@/paraglide/messages` /
 * `@/hooks/use-media-client`；迁移成标准 Widget 包后，这些入口换成
 * `@lull/widget-sdk`、`@lull/media-sdk/widget` 与构建期消息表。
 */
"use client";

import { m } from "virtual:lull-messages";
import type { LullMediaClient } from "@lull/media-sdk";
import type { LullWidgetClient } from "@lull/widget-sdk";
import {
  useLullTheme,
  useWidgetFit as useSdkWidgetFit,
} from "@lull/widget-sdk/react";
import type { RefObject } from "react";

let widget: LullWidgetClient | null = null;
let media: LullMediaClient | null = null;
const stateCache = new Map<string, string | null>();

export function installNoiseBridge(
  widgetClient: LullWidgetClient,
  mediaClient: LullMediaClient,
): void {
  widget = widgetClient;
  media = mediaClient;
}

/** 启动前置读取 KV，组件的同步 `readWidgetStorage` 才能拿到偏好。 */
export async function preloadNoiseState(): Promise<void> {
  if (!widget) return;
  try {
    const startup = await widget.getState<string | null>("startup", null);
    stateCache.set("startup", startup);
  } catch {
    // KV 不可用时保持默认。
  }
}

export function getMediaClient(): LullMediaClient {
  if (!media) throw new Error("媒体桥尚未初始化");
  return media;
}

/** 演示/独立预览下桥可能未安装；取不到时返回 null，由调用方走本地演示态。 */
export function peekMediaClient(): LullMediaClient | null {
  return media;
}

/**
 * 独立浏览器预览用的内存桩：`connectLullWidget` 在非 iframe 下会拒绝，
 * 这里补一个只实现兼容层实际触达成员的客户端，让 `useLull*` hooks 可用。
 */
export function createDemoWidgetClient(): LullWidgetClient {
  const viewport = {
    width: typeof window === "undefined" ? 600 : window.innerWidth,
    height: typeof window === "undefined" ? 420 : window.innerHeight,
    dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio,
  };
  const mediaListeners = new Set<(event: unknown) => void>();
  const subscribe = (): (() => void) => () => {};
  function demoGetState(key: string, fallback?: unknown): Promise<unknown> {
    const cached = stateCache.get(key) ?? null;
    if (cached !== null) return Promise.resolve(cached);
    return Promise.resolve(fallback ?? null);
  }
  const getState = demoGetState as LullWidgetClient["getState"];
  return {
    protocol: 1,
    id: "noise",
    hostApi: 1,
    minimizable: false,
    transparent: true,
    window: {
      width: 600,
      height: 420,
      minWidth: 560,
      minHeight: 320,
      resizable: false,
      transparent: true,
      chrome: "custom",
      fit: "content",
    },
    capabilities: [],
    theme: null,
    viewport,
    visible: true,
    locale: "zh-CN",
    has: () => false,
    request: (() =>
      Promise.reject(
        new Error("演示模式：宿主桥不可用"),
      )) as LullWidgetClient["request"],
    getState,
    setState: (key, value) => {
      stateCache.set(
        key,
        typeof value === "string" ? value : JSON.stringify(value ?? null),
      );
      return Promise.resolve();
    },
    removeState: (key) => {
      stateCache.delete(key);
      return Promise.resolve();
    },
    requestAudio: () => Promise.resolve(false),
    requestResize: () => Promise.resolve({ ...viewport, applied: false }),
    startDrag: () => Promise.resolve(),
    minimize: () => Promise.resolve(),
    setTransparent: () => Promise.resolve(),
    alignPlayer: () => Promise.resolve({ ...viewport, applied: false }),
    close: () => Promise.resolve(),
    openWindow: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    isWindowOpen: () => Promise.resolve(false),
    onWindowState: subscribe,
    log: () => {},
    onTheme: subscribe,
    onViewport: subscribe,
    onVisibility: subscribe,
    onLocale: subscribe,
    onMediaEvent: (listener) => {
      mediaListeners.add(listener);
      return () => {
        mediaListeners.delete(listener);
      };
    },
    destroy: () => {
      mediaListeners.clear();
    },
  };
}

export function readWidgetStorage(_id: string, key: string): string | null {
  return stateCache.get(key) ?? null;
}

export function writeWidgetStorage(
  _id: string,
  key: string,
  value: string,
): boolean {
  stateCache.set(key, value);
  void widget?.setState(key, value).catch(() => {});
  return true;
}

export const widgetHideWindow = (): Promise<void> =>
  widget?.close() ?? Promise.resolve();

export const widgetMinimizeWindow = (): Promise<void> =>
  widget?.minimize() ?? Promise.resolve();

export function widgetIsMinimizable(): Promise<boolean> {
  return Promise.resolve(widget?.minimizable ?? false);
}

/** 窗口偏好在 Widget SDK 里由宿主决定；组件只需要一个可退订的空订阅。 */
export function onWidgetPrefsChanged(_handler: () => void): () => void {
  return () => {};
}

const THEME_LABELS: Record<string, () => string> = {
  blueGold: m.flow_theme_blue_gold,
  jade: m.flow_theme_forest,
  amber: m.flow_theme_warm_gold,
  violet: m.flow_theme_star_violet,
  aurora: m.flow_theme_aurora,
};

export function useWidgetTheme(): {
  themeId: string;
  theme: { id: string; label: () => string };
} {
  const hostTheme = useLullTheme();
  const id = hostTheme?.id ?? "blueGold";
  const label = THEME_LABELS[id] ?? m.flow_theme_blue_gold;
  return { themeId: id, theme: { id, label } };
}

export function useWidgetFit(contentRef: RefObject<HTMLElement | null>): void {
  useSdkWidgetFit(contentRef);
}

export { m };
