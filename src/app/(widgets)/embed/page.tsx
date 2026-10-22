/**
 * 第三方插件窗口的宿主壳路由：窗口 label 为 `widget-<id>`，
 * Rust 通过初始化脚本注入 `window.__LULL_PLUGIN__`，页面只负责顶栏与 iframe。
 */
"use client";

import { WidgetPluginShell } from "@/components/widget-plugin-shell";

export default function EmbedPage() {
  return <WidgetPluginShell />;
}
