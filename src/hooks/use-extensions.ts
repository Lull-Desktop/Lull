"use client";

/**
 * 扩展列表：挂载时拉取，安装/卸载/授权后由 Rust 的 `extensions-changed` 触发刷新。
 *
 * 列表失败不阻塞设置页其它卡片：退化成空列表 + 一条可读问题。
 */
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  type ExtensionInfo,
  listExtensions,
  toExtensionFailure,
} from "@/lib/extensions";

export type ExtensionsState = {
  items: ExtensionInfo[] | null;
  issues: string[];
  refresh: () => Promise<void>;
};

export function useExtensions(): ExtensionsState {
  const [items, setItems] = useState<ExtensionInfo[] | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listExtensions();
      setItems(list);
      setIssues([]);
    } catch (error) {
      const failure = toExtensionFailure(error);
      setItems([]);
      setIssues([`读取扩展失败：${failure.message}`]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isDesktopWindow()) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen("extensions-changed", () => {
      void refresh();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 事件通道不可用不影响首屏；用户仍可手动刷新。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);

  return { items, issues, refresh };
}
