/**
 * 壁纸库窗口：沿用音乐库窗口的标题 / 内容布局，承载原「壁纸」页签的全部设置。
 */
"use client";

import { LibraryWindowFrame } from "@/components/library/library-window-frame";
import { WallpaperPanel } from "@/components/settings/wallpaper-panel";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

export function WallpaperLibraryWindow() {
  useLocale();

  return (
    <LibraryWindowFrame
      title={m.widget_backdrop_name()}
      description={m.widget_backdrop_description()}
    >
      <section className="min-h-0 flex-1">
        <WallpaperPanel />
      </section>
    </LibraryWindowFrame>
  );
}
