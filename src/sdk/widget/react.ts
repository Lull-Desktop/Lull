/**
 * Widget SDK 的 React 适配层：只给内置工具用；第三方工具走 iframe 桥（后续阶段）。
 * 依赖 React 的入口单独拆出来，纯模型模块（如 player-model）只依赖 `@/sdk/widget`。
 */
"use client";

import { type RefObject, useCallback, useEffect, useState } from "react";
import { useFlowTheme } from "@/hooks/use-flow-theme";
import { useWindowFit } from "@/hooks/use-window-fit";
import {
  DEFAULT_FLOW_THEME_ID,
  type FlowTheme,
  type FlowThemeId,
  getFlowTheme,
} from "@/lib/flow-theme";
import {
  hasWidgetCapability,
  readWidgetStorage,
  writeWidgetStorage,
} from "./runtime";

/**
 * 只读主题：`widget.theme` 未授权时退回宿主默认主题，工具仍然可以正常渲染。
 * 工具不能通过这个 hook 改全局主题（宿主的设置页才有写入口）。
 */
export function useWidgetTheme(): {
  themeId: FlowThemeId;
  theme: FlowTheme;
} {
  const { themeId, theme } = useFlowTheme();
  if (!hasWidgetCapability("widget.theme")) {
    return {
      themeId: DEFAULT_FLOW_THEME_ID,
      theme: getFlowTheme(DEFAULT_FLOW_THEME_ID),
    };
  }
  return { themeId, theme };
}

/** 贴合内容高度并显示窗口；属于宿主布局契约，不单独要求能力。 */
export function useWidgetFit(
  contentRef: RefObject<HTMLElement | null>,
  options: { fit?: boolean } = {},
): void {
  useWindowFit(contentRef, options);
}

/**
 * 带命名空间的 JSON 状态：先按默认值渲染，挂载后再读存储，避免静态导出首帧不一致。
 * 写入走 `writeWidgetStorage`，能力缺失时只更新内存、不落盘。
 */
export function useWidgetState<T>(
  id: string,
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    const raw = readWidgetStorage(id, key);
    if (raw === null) return;
    try {
      setValue(JSON.parse(raw) as T);
    } catch {
      // 存储里的旧值损坏时保留默认值，下一次写入会覆盖它。
    }
  }, [id, key]);

  const save = useCallback(
    (next: T): void => {
      setValue(next);
      try {
        writeWidgetStorage(id, key, JSON.stringify(next));
      } catch {
        // 序列化失败（循环引用等）只影响持久化，不影响当前会话。
      }
    },
    [id, key],
  );

  return [value, save];
}
