/** 媒体事件订阅：浏览器预览/测试下为空操作。 */
import { listen } from "@tauri-apps/api/event";
import { isMediaDesktop } from "./media-api";
import type { MediaDegradedEvent } from "./types";

export function onMediaChanged(handler: () => void): () => void {
  if (!isMediaDesktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen("media-changed", handler)
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

export function onMediaConfigChanged(handler: () => void): () => void {
  if (!isMediaDesktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen("media-config-changed", handler)
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

export function onMediaDegraded(
  handler: (event: MediaDegradedEvent) => void,
): () => void {
  if (!isMediaDesktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<MediaDegradedEvent>("media-degraded", (event) => {
    if (event.payload) handler(event.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

export function onMediaMasterVisible(
  handler: (visible: boolean) => void,
): () => void {
  if (!isMediaDesktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<boolean>("media-master-visible", (event) => {
    if (typeof event.payload === "boolean") handler(event.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

/** 设置页触发：所有壁纸页把 HTML 视频 seek 到同一位置；原生已由 Rust seek。 */
export function onMediaResync(
  handler: (positionMs: number) => void,
): () => void {
  if (!isMediaDesktop()) return () => {};
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<number>("media-resync", (event) => {
    if (typeof event.payload === "number") handler(event.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}
