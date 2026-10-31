import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  MEDIA_PROTOCOL,
  type MediaConnectRequest,
  type MediaEvent,
  type MediaRequest,
  type MediaResponse,
} from "./protocol";
import type { MediaTransport } from "./transport";

/** 官方窗口使用的 Tauri 传输。 */
export function createTauriTransport(): MediaTransport {
  return {
    async call(request: MediaRequest): Promise<MediaResponse> {
      return invoke<MediaResponse>("media_call", { request });
    },
    async connect(request: MediaConnectRequest): Promise<MediaResponse> {
      return invoke<MediaResponse>("media_connect", { request });
    },
    async disconnect(): Promise<void> {
      await invoke("media_disconnect");
    },
    subscribe(listener: (event: MediaEvent) => void): () => void {
      let stopMedia: (() => void) | null = null;
      let stopLibrary: (() => void) | null = null;
      let disposed = false;
      void listen<MediaEvent>("media:event", (event) => {
        listener(event.payload);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stopMedia = unlisten;
        })
        .catch(() => {
          // 事件订阅失败不影响命令调用；P2 会补连接状态。
        });
      // 资料库事件是 P1 的独立事件；映射到统一 MediaEvent，避免播放器直接
      // 依赖 Tauri 的 event 名字。
      void listen("library-changed", () => {
        listener({
          protocol: MEDIA_PROTOCOL,
          topic: "library.changed",
          revision: 0,
          at: Date.now(),
          payload: null,
        });
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stopLibrary = unlisten;
        })
        .catch(() => {});
      return () => {
        disposed = true;
        stopMedia?.();
        stopLibrary?.();
      };
    },
  };
}

/** 是否运行在 Tauri WebView 中；浏览器预览/单测返回 false。 */
export function isTauriRuntime(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}
