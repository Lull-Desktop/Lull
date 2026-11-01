/**
 * 第三方 Widget 的 Media 传输：通过 `@lull/widget-sdk` 的桥调用宿主壳，
 * 宿主壳再用 Rust bridge token 调 Media Service；插件 iframe 拿不到 Tauri IPC 或 token。
 */
import { createMediaClient, type LullMediaClient } from "./client.js";
import type {
  MediaConnectRequest,
  MediaEvent,
  MediaRequest,
  MediaResponse,
} from "./protocol.js";
import type { MediaTransport } from "./transport.js";

/** `LullWidgetClient` 的结构子集；避免 media-sdk 反向依赖 widget-sdk。 */
export interface WidgetMediaBridge {
  request(
    method: "media.call" | "media.connect" | "media.disconnect",
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  onMediaEvent?(listener: (event: unknown) => void): () => void;
}

export function createWidgetTransport(bridge: WidgetMediaBridge): MediaTransport {
  return {
    async call(request: MediaRequest): Promise<MediaResponse> {
      return bridge.request("media.call", { request }) as Promise<MediaResponse>;
    },
    async connect(request: MediaConnectRequest): Promise<MediaResponse> {
      return bridge.request("media.connect", { request }) as Promise<MediaResponse>;
    },
    async disconnect(): Promise<void> {
      await bridge.request("media.disconnect");
    },
    subscribe(listener: (event: MediaEvent) => void): () => void {
      return bridge.onMediaEvent?.((event) => listener(event as MediaEvent)) ?? (() => {});
    },
  };
}

/** 一行创建 Widget 侧 client；widget 需已获得 `widget.media` 授权。 */
export function createWidgetMediaClient(bridge: WidgetMediaBridge): LullMediaClient {
  return createMediaClient({ transport: createWidgetTransport(bridge) });
}
