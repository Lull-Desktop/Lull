/**
 * 壁纸素材库窗口：沿用库窗口的标题 / 内容布局，只承载媒体素材的导入、预览与管理。
 *
 * 壁纸层本身（显示模式、场景、每屏配置）已迁到设置窗的「壁纸」页签，这里不再有
 * 页签导航，素材列表在自己的滚动区里。
 */
"use client";

import { LibraryWindowFrame } from "@/components/library/library-window-frame";
import { MediaManagerPanel } from "@/components/library/media-manager-panel";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

export function WallpaperLibraryWindow() {
  // 订阅语言：窗口标题与说明跟着界面语言走。
  useLocale();

  return (
    <LibraryWindowFrame
      title={m.widget_backdrop_name()}
      description={m.widget_backdrop_description()}
    >
      <section
        data-testid="wallpaper-media-pane"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <MediaManagerPanel active />
      </section>
    </LibraryWindowFrame>
  );
}
