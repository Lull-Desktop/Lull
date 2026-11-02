/**
 * 壁纸库窗口：沿用音乐库窗口的标题 / 页签 / 内容布局。
 *
 * - 「壁纸层」承载原「壁纸」页签的全部设置；
 * - 「素材管理」负责媒体素材的导入、预览与管理。
 *
 * 两个面板常驻挂载，切换只做 CSS 隐藏：`WallpaperPanel` 挂载即拉显示器与场景
 * 配置，条件渲染会让每次切回都重发请求并闪一次「查询中」。
 */
"use client";

import { Images, Monitor } from "lucide-react";
import { useState } from "react";
import {
  LibraryWindowFrame,
  type LibraryWindowFrameTab,
} from "@/components/library/library-window-frame";
import { MediaManagerPanel } from "@/components/library/media-manager-panel";
import { WallpaperPanel } from "@/components/settings/wallpaper-panel";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type WallpaperTab = "layer" | "media";

const TABS: readonly LibraryWindowFrameTab[] = [
  { id: "layer", label: m.wallpaper_tab_layer, icon: Monitor },
  { id: "media", label: m.wallpaper_tab_media, icon: Images },
];

export function WallpaperLibraryWindow() {
  useLocale();
  const [tab, setTab] = useState<WallpaperTab>("layer");

  return (
    <LibraryWindowFrame
      title={m.widget_backdrop_name()}
      description={m.widget_backdrop_description()}
      tabs={TABS}
      activeTab={tab}
      onSelectTab={(id) => setTab(id as WallpaperTab)}
    >
      <section
        data-testid="wallpaper-layer-pane"
        aria-hidden={tab === "layer" ? undefined : true}
        inert={tab === "layer" ? undefined : true}
        className={cn("min-h-0 flex-1", tab === "layer" ? undefined : "hidden")}
      >
        <WallpaperPanel />
      </section>
      <section
        data-testid="wallpaper-media-pane"
        aria-hidden={tab === "media" ? undefined : true}
        inert={tab === "media" ? undefined : true}
        className={cn("min-h-0 flex-1", tab === "media" ? undefined : "hidden")}
      >
        <MediaManagerPanel active={tab === "media"} />
      </section>
    </LibraryWindowFrame>
  );
}
