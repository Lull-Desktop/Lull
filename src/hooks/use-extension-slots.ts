"use client";

/**
 * 功能槽位列表：选择、运行状态和候选 Provider。
 *
 * `slots-changed` 覆盖选择/启动/失败；`extensions-changed` 覆盖安装/启用/授权；
 * `widgets-changed` 覆盖窗口显示/隐藏，三者都只触发一次重新拉取。
 */
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  listExtensionSlots,
  type SlotInfo,
  toExtensionFailure,
} from "@/lib/extensions";

export type ExtensionSlotsState = {
  slots: SlotInfo[] | null;
  issues: string[];
  refresh: () => Promise<void>;
};

export function useExtensionSlots(): ExtensionSlotsState {
  const [slots, setSlots] = useState<SlotInfo[] | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listExtensionSlots();
      setSlots(list);
      setIssues([]);
    } catch (error) {
      const failure = toExtensionFailure(error);
      setSlots([]);
      setIssues([`读取功能槽位失败：${failure.message}`]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isDesktopWindow()) return;
    const stops: Array<() => void> = [];
    let disposed = false;
    const subscribe = (event: string): void => {
      void listen(event, () => {
        void refresh();
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stops.push(unlisten);
        })
        .catch(() => {
          // 事件通道不可用不影响首屏；用户仍可手动刷新。
        });
    };
    subscribe("slots-changed");
    subscribe("extensions-changed");
    subscribe("widgets-changed");
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [refresh]);

  return { slots, issues, refresh };
}
