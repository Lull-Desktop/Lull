import {
  isSceneHostMessage,
  type SceneClientMessage,
  type SceneHostMessage,
} from "./protocol.js";

/**
 * 场景与宿主之间的传输层。默认实现是 `window.parent.postMessage`，
 * 内存实现用于插件作者不启动宿主也能写单测（见 `@lull/scene-sdk/testing`）。
 */
export type SceneTransport = {
  send(message: SceneClientMessage): void;
  listen(listener: (message: SceneHostMessage) => void): () => void;
};

export function createWindowSceneTransport(target: Window): SceneTransport {
  return {
    send(message) {
      target.postMessage(message, "*");
    },
    listen(listener) {
      const onMessage = (event: MessageEvent): void => {
        // iframe 是 opaque origin，event.origin 为 "null"，只能比较 source。
        if (event.source !== target) return;
        if (!isSceneHostMessage(event.data)) return;
        listener(event.data);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
  };
}
