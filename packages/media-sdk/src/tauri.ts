import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  MediaConnectRequest,
  MediaEvent,
  MediaRequest,
  MediaResponse,
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
      await invoke("media_disconnect", { bridgeToken: null });
    },
    subscribe(listener: (event: MediaEvent) => void): () => void {
      let stop: (() => void) | null = null;
      let disposed = false;
      void listen<MediaEvent>("media:event", (event) => {
        listener(event.payload);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stop = unlisten;
        })
        .catch(() => {
          // 事件订阅失败不影响命令调用；P2 会补连接状态。
        });
      return () => {
        disposed = true;
        stop?.();
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
