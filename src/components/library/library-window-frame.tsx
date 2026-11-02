/**
 * 库窗口统一布局：标题 / 说明 / 横向页签 / 内容。
 *
 * 音乐库、壁纸库、白噪音库三个窗口共用这一层，尺寸与间距以音乐库为准：
 * 1080×760（min 900×600）、内容最大 1180px、`p-5`、`gap-4`。
 */
"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type LibraryWindowFrameTab = {
  id: string;
  /** 渲染期取文案，语言切换后跟随重渲染。 */
  label: () => string;
  icon: LucideIcon;
};

type LibraryWindowFrameProps = {
  title: string;
  description: string;
  /** 空数组时不渲染页签条；只有传了才出现。 */
  tabs?: readonly LibraryWindowFrameTab[];
  activeTab?: string;
  onSelectTab?: (id: string) => void;
  /** 标题右侧的操作区，例如音乐库的“刷新”。 */
  actions?: ReactNode;
  children: ReactNode;
};

export function LibraryWindowFrame({
  title,
  description,
  tabs = [],
  activeTab,
  onSelectTab,
  actions,
  children,
}: LibraryWindowFrameProps) {
  return (
    <div className="mx-auto flex h-full min-h-[560px] w-full max-w-[1180px] flex-col gap-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl text-ink">{title}</h1>
          <p className="mt-1 text-sm text-ink-soft">{description}</p>
        </div>
        {actions}
      </header>

      {tabs.length > 0 && (
        <nav className="flex flex-wrap gap-2" aria-label={title}>
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                type="button"
                variant={activeTab === item.id ? "default" : "outline"}
                size="sm"
                onClick={() => onSelectTab?.(item.id)}
              >
                <Icon className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {item.label()}
              </Button>
            );
          })}
        </nav>
      )}

      {children}
    </div>
  );
}
