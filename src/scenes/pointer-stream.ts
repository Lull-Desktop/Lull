/**
 * 壁纸顶层页面的鼠标位置事件流。
 *
 * Rust 采样器通过 Tauri 定向事件 `wallpaper-pointer` 下发桌面物理坐标；
 * 这里按当前窗口 label 订阅（不能用 Any，否则多屏会串台），并做载荷校验。
 * 浏览器预览/单测没有 Tauri 事件系统，安全空转。
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentWindowLabel, hasTauriRuntime } from "@/core/window-label";
import { type DesktopPointerSample, isDesktopPointerSample } from "./pointer";

/** 与 Rust `wallpaper/pointer.rs` 的 POINTER_EVENT 保持一致。 */
export const WALLPAPER_POINTER_EVENT = "wallpaper-pointer";

/** 订阅宿主的鼠标位置事件；返回同步的退订函数。 */
export function listenWallpaperPointer(
  handler: (sample: DesktopPointerSample) => void,
): () => void {
  if (!hasTauriRuntime()) return () => {};
  const label = currentWindowLabel();
  if (!label) {
    console.error("[scene] 当前壁纸窗口没有 label，跳过鼠标位置订阅");
    return () => {};
  }

  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  void listen<unknown>(
    WALLPAPER_POINTER_EVENT,
    (event) => {
      if (disposed) return;
      if (!isDesktopPointerSample(event.payload)) return;
      handler(event.payload);
    },
    { target: { kind: "AnyLabel", label } },
  )
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch((error: unknown) => {
      // Tauri 事件系统不可用时只降级指针功能，不影响场景本身。
      console.warn("[scene] 订阅鼠标位置失败", error);
    });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
