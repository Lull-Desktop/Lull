/**
 * 控制窗口路由组布局：设置页复用统一窗口外壳，并挂全局主题流光桥。
 */
"use client";

import { FlowThemeRoot } from "@/components/flow-theme-root";
import { WindowShell } from "@/components/window-shell";

export default function ControlLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {/* 主题流光桥只挂在应用窗口组；壁纸页保持零 Tauri 依赖。 */}
      <FlowThemeRoot />
      <WindowShell section="设置">{children}</WindowShell>
    </>
  );
}
