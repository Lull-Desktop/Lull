/**
 * 应用窗口外壳：自绘顶栏 + 内容独立滚动 + 按内容贴合窗口高度 + 主题与消息提示。
 * 设置窗使用纸色外壳；播放器 / 番茄钟 / 白噪音使用透明沉浸式外壳，
 * 见 src/components/liquid-player、liquid-pomodoro 与 ether-bubbles。
 */
"use client";

import { useRef } from "react";
import { Toaster } from "@/components/ui/sonner";
import { WindowTopbar } from "@/components/window-topbar";
import { ThemeProvider } from "@/hooks/use-theme";
import { useWindowFit } from "@/hooks/use-window-fit";

type WindowShellProps = {
  /** 顶栏里的窗口名（设置 / 播放器 / 番茄钟 / 白噪音），传消息函数以跟随语言切换。 */
  section: () => string;
  children: React.ReactNode;
};

export function WindowShell({ section, children }: WindowShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  useWindowFit(contentRef);

  return (
    <ThemeProvider>
      {/* 顶栏固定、内容区单独滚动：否则页面滚动条会压在顶栏右侧的窗口按钮上 */}
      <div className="window-frame noise-bg flex h-screen flex-col overflow-hidden bg-background">
        {/* 是否真的渲染最小化按钮由全局偏好（窗口 minimizable）决定，见 window_prefs.rs */}
        <WindowTopbar section={section} allowMinimize className="flow-topbar" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 这层随内容伸缩，是「窗口贴合内容」的测量基准，不要加 h-full/min-h */}
          <div ref={contentRef}>{children}</div>
        </div>
        <Toaster
          position="top-right"
          offset={{ top: 56, right: 12 }}
          toastOptions={{
            style: {
              background:
                "color-mix(in srgb, var(--paper-warm) 85%, transparent)",
              backdropFilter: "blur(12px)",
              border:
                "1px solid color-mix(in srgb, var(--paper-deep) 60%, transparent)",
              color: "var(--ink-soft)",
              borderRadius: "10px",
              boxShadow: "0 4px 16px var(--shadow-hover-color)",
            },
          }}
        />
      </div>
    </ThemeProvider>
  );
}
