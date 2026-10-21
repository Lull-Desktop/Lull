/**
 * 工具窗口路由组布局：播放器 / 番茄钟 / 白噪音都是透明沉浸式浮窗，
 * 自己绘制拖拽区与窗口按钮，页面不铺背景。
 *
 * 全局主题流光只挂在这里与控制面；壁纸页保持零 Tauri 依赖。
 */
"use client";

import { FlowThemeRoot } from "@/components/flow-theme-root";

export default function WidgetLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <FlowThemeRoot />
      {children}
    </>
  );
}
