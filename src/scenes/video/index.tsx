"use client";

/**
 * 内置媒体壁纸场景（图片 / 视频）。
 *
 * 首版只支持一个全局媒体源（display.media），素材选择与播放参数由设置页的
 * 媒体面板维护；这里只负责把 MediaSurface 铺满场景容器，并把宿主的同步开关
 * 透传下去——HTML 视频回退需要按墙钟重新对齐相位。
 */
import { MediaSurface } from "@/scenes/media-surface";
import type { SceneProps } from "@/sdk/scene";

export function VideoScene({ sync }: SceneProps) {
  return (
    <div className="absolute inset-0">
      <MediaSurface syncEnabled={sync.enabled} />
    </div>
  );
}
