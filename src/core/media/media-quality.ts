/**
 * HTML 播放质量上报 / 订阅。
 *
 * 壁纸窗每 5s 采样一次 `getVideoPlaybackQuality()`，设置页聚合显示丢帧率；
 * 非 Tauri 环境（浏览器预览、Vitest）全部降级为空操作。
 */
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MediaPlaybackQuality } from "./types";

export const MEDIA_QUALITY_EVENT = "media-playback-quality";

function desktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** 壁纸窗上报一次采样。 */
export function reportMediaQuality(
  sample: Omit<MediaPlaybackQuality, "label" | "at">,
): void {
  if (!desktop()) return;
  let label = "";
  try {
    label = getCurrentWindow().label;
  } catch {
    return;
  }
  void emit(MEDIA_QUALITY_EVENT, {
    ...sample,
    label,
    at: Date.now(),
  }).catch(() => {
    // 窗口销毁/事件总线不可用：质量采样失败不应影响播放。
  });
}

/** 设置页订阅各壁纸窗的质量采样；返回取消订阅函数。 */
export function onMediaQuality(
  handler: (quality: MediaPlaybackQuality) => void,
): () => void {
  if (!desktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<MediaPlaybackQuality>(MEDIA_QUALITY_EVENT, (event) => {
    if (event.payload) handler(event.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {
      // 权限缺失/非 Tauri：设置页不显示质量行即可。
    });
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}
