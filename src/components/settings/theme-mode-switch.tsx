/**
 * 黑白样式切换：嵌在「主题流光」参数里，切换控制窗口已有的明暗外观。
 *
 * 主题状态与持久化都在 ThemeProvider（src/hooks/use-theme.tsx）里：这里只负责
 * 把 light / dark 两个选项画成与语言、流光色板一致的纸色胶囊，点击后由
 * Provider 统一维护 `<html>` 的 class 与 localStorage（`ui-theme`）。
 */
"use client";

import { Moon, Sun } from "lucide-react";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type ThemeModeOption = {
  value: Theme;
  /** 取消息函数而不是字符串：语言切换后选项文案要跟着变。 */
  label: () => string;
  ariaLabel: () => string;
  icon: typeof Sun;
};

const THEME_MODE_OPTIONS: readonly ThemeModeOption[] = [
  {
    value: "light",
    label: m.theme_light,
    ariaLabel: m.theme_light_aria,
    icon: Sun,
  },
  {
    value: "dark",
    label: m.theme_dark,
    ariaLabel: m.theme_dark_aria,
    icon: Moon,
  },
];

export function ThemeModeSwitch() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="settings-theme-mode"
    >
      <div className="space-y-0.5">
        <span className="text-sm text-ink-soft">
          {m.settings_theme_mode_title()}
        </span>
        <p className="text-xs text-muted-foreground">
          {m.settings_theme_mode_description()}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label={m.settings_theme_mode_title()}
        className="flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-paper-warm/70 p-0.5"
      >
        {THEME_MODE_OPTIONS.map((option) => {
          const active = theme === option.value;
          const Icon = option.icon;
          return (
            // biome-ignore lint/a11y/useSemanticElements: light/dark pills intentionally use ARIA radio semantics with custom paper styling
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.ariaLabel()}
              onClick={() => setTheme(option.value)}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors",
                active
                  ? "bg-paper text-ink shadow-sm"
                  : "text-muted-foreground hover:text-ink-soft",
              )}
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />
              {option.label()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
