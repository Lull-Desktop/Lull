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
  /**
   * 是否按内容高度贴合窗口。设置/资料库这类可缩放窗口传 false，保持清单里的
   * 初始尺寸；沉浸式工具窗保持默认 true。
   */
  fit?: boolean;
  children: React.ReactNode;
};

export function WindowShell({
  section,
  fit = true,
  children,
}: WindowShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  useWindowFit(contentRef, { fit });

  return (
    <ThemeProvider>
      {/* 顶栏固定、内容区单独滚动：否则页面滚动条会压在顶栏右侧的窗口按钮上 */}
      <div className="window-frame noise-bg flex h-screen flex-col overflow-hidden bg-background">
        {/* 是否真的渲染最小化按钮由全局偏好（窗口 minimizable）决定，见 window_prefs.rs */}
        <WindowTopbar section={section} allowMinimize className="flow-topbar" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* fit=true 时这层随内容伸缩；fit=false（资料库）时撑满可用高度。 */}
          <div ref={contentRef} className={fit ? undefined : "h-full"}>
            {children}
          </div>
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
