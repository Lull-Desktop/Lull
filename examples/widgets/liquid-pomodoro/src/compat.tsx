/**
 * 普通示例包的宿主兼容层：窗口 chrome、主题、fit、KV 都只通过 @lull/widget-sdk。
 */
"use client";

import type { LullWidgetClient } from "@lull/widget-sdk";
import {
  useLullTheme,
  useWidgetFit as useSdkWidgetFit,
} from "@lull/widget-sdk/react";
import type { RefObject } from "react";
import {
  installStorageWriter,
  readStorage,
  seedStorage,
  writeStorage,
} from "./storage";

let widget: LullWidgetClient | null = null;

export function installWidgetBridge(widgetClient: LullWidgetClient): void {
  widget = widgetClient;
  installStorageWriter((key, value) => {
    void widgetClient.setState(key, value).catch(() => {});
  });
}

/** 渲染前读取偏好，组件挂载后的同步读取才能拿到上次状态。 */
export async function preloadWidgetState(): Promise<void> {
  if (!widget) return;
  try {
    const raw = await widget.getState<string | null>("v1", null);
    seedStorage("v1", raw);
  } catch {
    // KV 不可用时使用默认计时设置。
  }
}

export function readWidgetStorage(_id: string, key: string): string | null {
  return readStorage(key);
}

export function writeWidgetStorage(
  _id: string,
  key: string,
  value: string,
): boolean {
  writeStorage(key, value);
  return true;
}

export const widgetHideWindow = (): Promise<void> =>
  widget?.close() ?? Promise.resolve();

export const widgetMinimizeWindow = (): Promise<void> =>
  widget?.minimize() ?? Promise.resolve();

export function widgetIsMinimizable(): Promise<boolean> {
  return Promise.resolve(widget?.minimizable ?? false);
}

/** 窗口偏好变化在普通 Widget SDK 中没有对应事件；首帧读取 minimizable 即可。 */
export function onWidgetPrefsChanged(_handler: () => void): () => void {
  return () => {};
}

export function isWidgetAudioAvailable(): boolean {
  return widget?.has("widget.audio") ?? false;
}

export function useWidgetTheme(): { themeId: string } {
  const theme = useLullTheme();
  return { themeId: theme?.id ?? "blueGold" };
}

export function useWidgetFit(contentRef: RefObject<HTMLElement | null>): void {
  useSdkWidgetFit(contentRef);
}
