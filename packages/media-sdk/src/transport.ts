import type {
  MediaConnectRequest,
  MediaEvent,
  MediaRequest,
  MediaResponse,
} from "./protocol";

/** 传输层：官方用 Tauri，第三方 Widget 后续用宿主壳桥，测试用内存实现。 */
export interface MediaTransport {
  call(request: MediaRequest): Promise<MediaResponse>;
  connect?(request: MediaConnectRequest): Promise<MediaResponse>;
  disconnect?(): Promise<void>;
  subscribe?(listener: (event: MediaEvent) => void): () => void;
}
