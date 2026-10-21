/**
 * 让无边框窗口贴合内容：首次渲染后把窗口高度收到「顶栏 + 内容」，并在内容尺寸变化
 * （显示器列表增减、显示模式切换、宽度变化引起重排）时重新贴合，避免窗口留下空白。
 *
 * 窗口在 Rust 侧以隐藏状态创建（window_host 的 `visible(false)`），本 hook 完成首次贴合后
 * 再显示窗口，因此看不到「先 768×600 再跳变」的过程；Rust 侧另有超时兜底显示。
 */
"use client";

import { isTauri } from "@tauri-apps/api/core";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type RefObject, useEffect } from "react";
import { notifyWidgetsChanged } from "@/core/window/controls";
import { fittedWindowHeight } from "@/core/window/fit";

/** 屏幕顶部/底部留白：任务栏与窗口边框，避免贴合后顶到屏幕边缘。 */
const SCREEN_MARGIN = 48;

type WindowFitOptions = {
  /**
   * 是否按内容高度贴合并持续监听尺寸。透明固定浮窗（如液态黑胶播放器）
   * 自带完整画布，只需要在字体落地后显示窗口，不能把 100vh 内容再叠加顶栏高度。
   */
  fit?: boolean;
};

/** 贴合内容高度；`contentRef` 指向随内容伸缩的包裹层（不是滚动容器）。 */
export function useWindowFit(
  contentRef: RefObject<HTMLElement | null>,
  options: WindowFitOptions = {},
): void {
  const fitContent = options.fit ?? true;
  useEffect(() => {
    if (!isTauri()) return;
    const content = contentRef.current;
    if (!content) return;

    const win = getCurrentWindow();
    let frame = 0;
    let disposed = false;
    let revealed = false;

    /** 把窗口高度调整到内容高度；宽度保持不变。 */
    const fit = async (): Promise<void> => {
      if (disposed || !fitContent) return;
      try {
        const [inner, scale] = await Promise.all([
          win.innerSize(),
          win.scaleFactor(),
        ]);
        const height = fittedWindowHeight(
          content.offsetHeight,
          window.screen.availHeight - SCREEN_MARGIN,
        );
        // 只改高度：宽度沿用当前物理宽度，避免缩放换算引入 1px 抖动。
        const target = Math.round(height * scale);
        // 1px 内的差异忽略，避免像素取整导致的来回抖动。
        if (Math.abs(target - inner.height) > 1) {
          await win.setSize(new PhysicalSize(inner.width, target));
        }
      } catch (err) {
        console.error("[window] 自适应窗口高度失败", err);
      }
    };

    /** 首次贴合后显示窗口；已显示（或最小化）则不动，避免把托盘里的窗口弹出来。 */
    const reveal = async (): Promise<void> => {
      if (disposed || revealed) return;
      revealed = true;
      try {
        const [visible, minimized] = await Promise.all([
          win.isVisible(),
          win.isMinimized(),
        ]);
        if (visible || minimized) return;
        await win.show();
        await win.setFocus();
        // 首次显示后通知设置页：该工具窗的开关应变成「开」。
        notifyWidgetsChanged();
      } catch (err) {
        console.error("[window] 显示窗口失败", err);
      }
    };

    const schedule = (): void => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void fit();
      });
    };

    let observer: ResizeObserver | null = null;
    if (fitContent) {
      observer = new ResizeObserver(schedule);
      observer.observe(content);
    }

    void (async () => {
      await fit();
      // Web 字体与首帧 IPC 数据都会改变卡片高度：等它们落地后再贴合一次才显示。
      // 否则窗口会先以「空卡片」的高度出现，数据到达后再突然长高。
      if (document.fonts) {
        await Promise.race([
          document.fonts.ready,
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 500);
          }),
        ]);
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 180);
      });
      await fit();
      await reveal();
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [contentRef, fitContent]);
}
