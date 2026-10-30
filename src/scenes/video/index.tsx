"use client";

/**
 * 内置视频壁纸场景。
 *
 * 首版只支持一个全局视频源（display.media），素材选择与播放参数由设置页的
 * 媒体面板维护；这里只负责把 MediaSurface 铺满场景容器。
 */
import { MediaSurface } from "@/scenes/media-surface";

export function VideoScene() {
  return (
    <div className="absolute inset-0">
      <MediaSurface />
    </div>
  );
}
