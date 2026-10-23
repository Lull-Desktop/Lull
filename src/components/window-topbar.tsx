/**
 * 自绘窗口顶栏（Topbar）：替代被隐藏的系统标题栏，提供品牌区、锁定 / 最小化 / 关闭按钮。
 *
 * 拖拽规则：解锁时整条顶栏就是拖拽区（`data-tauri-drag-region="deep"`，双击最大化），
 * 按钮/链接等可点击元素天然不会触发拖拽；锁定后移除拖拽区并关闭窗口缩放，
 * 鼠标无法再移动或改变窗口尺寸，点同一个锁定按钮即可恢复。
 *
 * 最小化按钮只在窗口 `minimizable` 时出现（与是否进任务栏无关）：Rust 侧按
 * WidgetSpec 设置该窗口能力（window_host/spec.rs），这里读 `isMinimizable` 即可，不需要额外传参。
 */
"use client";

import { Lock, LockOpen, Minus, MoonStar, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  hideWindow,
  isWindowMinimizable,
  minimizeWindow,
  onWindowPrefsChanged,
  setWindowResizable,
} from "@/core/window/controls";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

/** 锁定状态跨启动保留：浮窗被误拖动会破坏它在桌面上的位置。 */
const LOCK_STORAGE_KEY = "lull:window:locked";

function readStoredLock(): boolean {
  try {
    return window.localStorage.getItem(LOCK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistLock(locked: boolean): void {
  try {
    window.localStorage.setItem(LOCK_STORAGE_KEY, locked ? "1" : "0");
  } catch {
    // 存储不可用时只影响下次启动的默认值。
  }
}

type WindowTopbarProps = {
  /** 额外的容器类名，供其他无边框窗口复用时微调外观。 */
  className?: string;
  /** 品牌倒第二段（设置 / 播放器）；传消息函数而不是字符串，语言切换时才会更新。 */
  section?: () => string;
  /** 是否尝试渲染最小化按钮（实际以窗口的 minimizable 为准）。 */
  allowMinimize?: boolean;
};

export function WindowTopbar({
  className,
  section = m.window_section_settings,
  allowMinimize = false,
}: WindowTopbarProps) {
  // 订阅语言：切换语言后整条顶栏（窗口名、锁定徽标、提示）都要跟着变。
  useLocale();
  const [locked, setLocked] = useState(false);
  const [canMinimize, setCanMinimize] = useState(false);

  // 挂载后再读存储：静态导出会预渲染 HTML，首帧直接读 localStorage 会造成 hydration 不一致。
  useEffect(() => {
    if (!readStoredLock()) return;
    setLocked(true);
    void setWindowResizable(false);
  }, []);

  // 最小化能力来自 Rust 侧的全局窗口偏好；偏好变化时重新读取（所有窗口共用）。
  // 浏览器预览/测试里 isTauri 为 false，固定不渲染。
  useEffect(() => {
    if (!allowMinimize) return;
    let alive = true;
    const sync = (): void => {
      void isWindowMinimizable().then((value) => {
        if (alive) setCanMinimize(value);
      });
    };
    sync();
    const stop = onWindowPrefsChanged(sync);
    return () => {
      alive = false;
      stop();
    };
  }, [allowMinimize]);

  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    persistLock(next);
    void setWindowResizable(!next);
  }, [locked]);

  return (
    <header
      data-testid="window-topbar"
      {...(locked ? {} : { "data-tauri-drag-region": "deep" })}
      className={cn(
        "z-40 flex h-10 shrink-0 select-none items-center gap-3 border-b border-paper-deep/70 bg-paper-warm/85 px-3 backdrop-blur-md",
        className,
      )}
    >
      {/* 品牌区：既是视觉锚点，也是拖拽时最自然的落点。
          中英文字号不同（13px 衬线 / 11px 无衬线），必须按基线对齐，否则字形底部会错开；
          「已锁定」胶囊也放进这一行，让它的小字与「设置」共用基线（self-center 会整体偏高）。
          胶囊常驻占位、未锁定时只做 invisible：它的盒子比文字行高，若按需挂载会把基线行撑高
          1px，导致锁定/解锁瞬间整行文字上下跳动。 */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-bamboo-mist text-bamboo">
          <MoonStar className="h-3.5 w-3.5" />
        </span>
        <span className="flex min-w-0 items-baseline gap-2 leading-none">
          {/* 窗口窄于 640px（播放器）时隐藏英文品牌，只留窗口名，避免被 truncate 成 "SER…" */}
          <span className="hidden truncate font-serif text-[13px] tracking-[0.26em] text-ink-soft sm:inline">
            LULL
          </span>
          <span
            aria-hidden="true"
            className="hidden h-3 w-px shrink-0 self-center bg-paper-deep sm:inline-block"
          />
          <span className="truncate text-[11px] tracking-wider text-ink-faint">
            {section()}
          </span>
          <span
            aria-hidden={!locked}
            className={cn(
              "ml-1 shrink-0 rounded-full bg-bamboo-mist px-2 py-0.5 text-[10px] leading-none tracking-wider text-bamboo",
              !locked && "invisible",
            )}
          >
            {m.topbar_locked_badge()}
          </span>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="topbar-lock"
          aria-label={locked ? m.topbar_unlock() : m.topbar_lock()}
          aria-pressed={locked}
          title={locked ? m.topbar_unlock_hint() : m.topbar_lock_hint()}
          onClick={toggleLock}
          className={cn(
            "h-7 w-7 cursor-pointer rounded-md text-ink-faint [&_svg]:size-3.5",
            locked &&
              "bg-bamboo-mist text-bamboo hover:bg-bamboo-glow hover:text-bamboo",
          )}
        >
          {locked ? <Lock /> : <LockOpen />}
        </Button>
        {canMinimize && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="topbar-minimize"
            aria-label={m.topbar_minimize()}
            title={m.topbar_minimize()}
            onClick={() => void minimizeWindow()}
            className="h-7 w-7 cursor-pointer rounded-md text-ink-faint [&_svg]:size-3.5"
          >
            <Minus />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="topbar-close"
          aria-label={m.topbar_close()}
          title={m.topbar_close_hint()}
          onClick={() => void hideWindow()}
          className="h-7 w-7 cursor-pointer rounded-md text-ink-faint hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5"
        >
          <X />
        </Button>
      </div>
    </header>
  );
}
