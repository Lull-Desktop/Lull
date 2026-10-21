/**
 * 主题流光桥：挂在控制面 / 工具窗路由布局里，确保每个应用窗口
 * （即使页面本身不读主题）也会应用存储里的配色并监听其他窗口的切换。
 * 壁纸路由不挂它，保持壁纸页的零 Tauri 依赖。
 */
"use client";

import { useFlowTheme } from "@/hooks/use-flow-theme";

export function FlowThemeRoot(): null {
  useFlowTheme();
  return null;
}
