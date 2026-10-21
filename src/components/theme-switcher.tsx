/**
 * 主题切换控件：在当前控制窗口中切换明暗主题。
 * 定位交给容器（控制面里挂自绘顶栏 Topbar 的右侧），不再自行 fixed 到右上角。
 */
"use client";

import { Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isTheme, useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

type ThemeSwitcherProps = {
  /** 额外的容器类名（控制面用来和顶栏背景融合）。 */
  className?: string;
};

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(value) => {
        if (isTheme(value)) setTheme(value);
      }}
      variant="outline"
      size="sm"
      className={cn("shrink-0 rounded-md", className)}
    >
      <ToggleGroupItem value="light" aria-label="浅色模式" className="gap-1">
        <Sun className="h-3.5 w-3.5" />
        <span className="text-xs hidden sm:inline">浅色</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="深色模式" className="gap-1">
        <Moon className="h-3.5 w-3.5" />
        <span className="text-xs hidden sm:inline">深色</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
