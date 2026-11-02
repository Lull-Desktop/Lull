/**
 * 官方播放器包的宿主兼容层：窗口 chrome、主题、fit、KV 与消息表。
 * 播放器会话直接走 `@lull/media-sdk/react` 的 `usePlayerSession`。
 */
"use client";

import { m } from "virtual:lull-messages";
import type { LullWidgetClient } from "@lull/widget-sdk";
import {
  useLullTheme,
  useWidgetFit as useSdkWidgetFit,
} from "@lull/widget-sdk/react";
import type { RefObject } from "react";
import { installStorageWriter, seedStorage } from "./storage";

let widget: LullWidgetClient | null = null;

export function installPlayerBridge(widgetClient: LullWidgetClient): void {
  widget = widgetClient;
  installStorageWriter((key, value) => {
    void widgetClient.setState(key, value).catch(() => {});
  });
}

export async function preloadPlayerState(): Promise<void> {
  if (!widget) return;
  try {
    const raw = await widget.getState<string | null>("v1", null);
    seedStorage("v1", raw);
  } catch {
    // KV 不可用时使用默认偏好。
  }
}

export const widgetHideWindow = (): Promise<void> =>
  widget?.close() ?? Promise.resolve();

export const widgetMinimizeWindow = (): Promise<void> =>
  widget?.minimize() ?? Promise.resolve();

export function widgetIsMinimizable(): Promise<boolean> {
  return Promise.resolve(widget?.minimizable ?? false);
}

export function onWidgetPrefsChanged(_handler: () => void): () => void {
  return () => {};
}

export function isWidgetAudioAvailable(): boolean {
  return widget?.has("widget.audio") ?? false;
}

export async function widgetResizeWidth(
  width: number,
  anchor: "left" | "right" = "left",
): Promise<void> {
  if (!widget) return;
  await widget.requestResize({ width, anchor }).catch(() => {
    // 授权被撤销或宿主拒绝时保持当前宽度，不影响播放。
  });
}

export async function widgetAlignPlayer(
  currentSide: "left" | "right",
  nextSide: "left" | "right",
  width: number,
  playerAnchor: number,
): Promise<void> {
  if (!widget) return;
  await widget
    .alignPlayer({
      currentSide,
      nextSide,
      width,
      playerAnchor,
    })
    .catch(() => {
      // 换边失败时布局仍会翻面，只是窗口不移动；不阻塞动画。
    });
}

/** 打开（或唤醒）音乐库窗口；`tab` 指定停留页签。需宿主壳转发 window.open。 */
export function widgetOpenLibrary(tab?: string): Promise<void> {
  if (!widget) return Promise.resolve();
  return widget.openWindow({ kind: "library", tab });
}

/** 关闭（隐藏）音乐库窗口。需宿主壳转发 window.close。 */
export function widgetCloseLibrary(): Promise<void> {
  if (!widget) return Promise.resolve();
  return widget.closeWindow({ kind: "library" });
}

/** 音乐库窗口当前是否可见；桥不可用时按「关着」处理。 */
export function widgetLibraryVisible(): Promise<boolean> {
  if (!widget) return Promise.resolve(false);
  return widget.isWindowOpen("library").catch(() => false);
}

/**
 * 订阅音乐库窗口的可见性与当前页签。
 *
 * 除了自己点按钮开关，用户直接关掉库窗口、在库窗口里切换页签、或从托盘 /
 * 设置页隐藏时宿主也会推送，开关按钮据此保持和真实窗口一致。
 */
export function onLibraryState(
  listener: (state: { visible: boolean; tab?: string }) => void,
): () => void {
  if (!widget) return () => {};
  return widget.onWindowState((state) => {
    if (state.kind === "library") {
      listener({ visible: state.visible, tab: state.tab });
    }
  });
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

export function useWidgetFit(
  contentRef: RefObject<HTMLElement | null>,
  options: { fit?: boolean } = {},
): void {
  useSdkWidgetFit(contentRef, options);
}

export { m };
