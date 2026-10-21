/**
 * 主题流光的全局状态：一个窗口内共享一份快照，跨窗口通过 Tauri 事件 +
 * localStorage 同步；控制面 / 工具窗的 `<html>` 上都会写入 `--flow-*` 变量。
 */
"use client";

import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  applyFlowThemeToDocument,
  DEFAULT_FLOW_THEME_ID,
  FLOW_THEME_CHANGED_EVENT,
  FLOW_THEME_STORAGE_KEY,
  type FlowTheme,
  type FlowThemeId,
  getFlowTheme,
  isFlowThemeId,
  persistFlowThemeId,
  readStoredFlowThemeId,
} from "@/lib/flow-theme";

type FlowThemeSnapshot = {
  themeId: FlowThemeId;
  theme: FlowTheme;
};

/** 首帧前先应用一次存储里的主题，避免窗口显示后从蓝金跳到用户的选择。 */
let currentThemeId: FlowThemeId =
  typeof window === "undefined"
    ? DEFAULT_FLOW_THEME_ID
    : readStoredFlowThemeId();

if (typeof window !== "undefined") {
  applyFlowThemeToDocument(getFlowTheme(currentThemeId));
}

const subscribers = new Set<() => void>();
let detachGlobalListeners: (() => void) | null = null;

function emitChange(): void {
  for (const listener of subscribers) listener();
}

function broadcastTheme(id: FlowThemeId): void {
  if (!isDesktopWindow()) return;
  void emit(FLOW_THEME_CHANGED_EVENT, { id }).catch((err: unknown) => {
    console.error("[flow-theme] 广播主题流光失败", err);
  });
}

/** 收到其他窗口的选择：先落盘，再刷新当前窗口。 */
function applyExternalTheme(id: FlowThemeId): void {
  persistFlowThemeId(id);
  if (id === currentThemeId) {
    applyFlowThemeToDocument(getFlowTheme(id));
    return;
  }
  currentThemeId = id;
  applyFlowThemeToDocument(getFlowTheme(id));
  emitChange();
}

function attachGlobalListeners(): void {
  if (typeof window === "undefined" || detachGlobalListeners) return;

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== FLOW_THEME_STORAGE_KEY) return;
    applyExternalTheme(
      isFlowThemeId(event.newValue) ? event.newValue : DEFAULT_FLOW_THEME_ID,
    );
  };
  window.addEventListener("storage", onStorage);

  let disposed = false;
  let stopTauriListener: (() => void) | null = null;
  if (isDesktopWindow()) {
    void listen<{ id?: string }>(FLOW_THEME_CHANGED_EVENT, (event) => {
      const id = event.payload?.id;
      if (isFlowThemeId(id)) applyExternalTheme(id);
    })
      .then((stop) => {
        if (disposed) stop();
        else stopTauriListener = stop;
      })
      .catch((err: unknown) => {
        console.error("[flow-theme] 订阅主题流光失败", err);
      });
  }

  detachGlobalListeners = () => {
    disposed = true;
    window.removeEventListener("storage", onStorage);
    stopTauriListener?.();
    stopTauriListener = null;
  };
}

function detachListeners(): void {
  detachGlobalListeners?.();
  detachGlobalListeners = null;
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (subscribers.size === 1) attachGlobalListeners();
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) detachListeners();
  };
}

function getSnapshot(): FlowThemeId {
  return currentThemeId;
}

function getServerSnapshot(): FlowThemeId {
  return DEFAULT_FLOW_THEME_ID;
}

/** 把 localStorage 的当前值重新灌进内存快照；挂载时调用，测试清空存储后也能回到默认。 */
export function syncFlowThemeFromStorage(): void {
  if (typeof window === "undefined") return;
  const id = readStoredFlowThemeId();
  if (id === currentThemeId) {
    applyFlowThemeToDocument(getFlowTheme(id));
    return;
  }
  currentThemeId = id;
  applyFlowThemeToDocument(getFlowTheme(id));
  emitChange();
}

/** 设置窗口 / 其他入口统一切换入口：落盘、换肤、广播给已打开的其他窗口。 */
export function setFlowTheme(id: FlowThemeId): void {
  if (!isFlowThemeId(id)) return;
  persistFlowThemeId(id);
  if (id !== currentThemeId) {
    currentThemeId = id;
    applyFlowThemeToDocument(getFlowTheme(id));
    emitChange();
  } else {
    applyFlowThemeToDocument(getFlowTheme(id));
  }
  broadcastTheme(id);
}

export function useFlowTheme(): FlowThemeSnapshot & {
  setTheme: (id: FlowThemeId) => void;
} {
  const themeId = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  // 组件挂载时再对齐一次存储：静态导出首帧可能与模块求值时机不同，
  // 单元测试也会在 import 之后清空 localStorage。
  useEffect(() => {
    syncFlowThemeFromStorage();
  }, []);

  const setTheme = useCallback((id: FlowThemeId) => {
    setFlowTheme(id);
  }, []);

  return { themeId, theme: getFlowTheme(themeId), setTheme };
}
