import {
  type GameClientMessage,
  type GameHostMessage,
  isGameHostMessage,
} from "./protocol.js";

/**
 * 游戏 iframe 与宿主壳之间的传输层。默认实现是 `window.parent.postMessage`，
 * 内存实现用于不启动宿主的单元测试（见 `@lull/game-sdk/testing`）。
 */
export type GameTransport = {
  post(message: GameClientMessage): void;
  listen(listener: (message: GameHostMessage) => void): () => void;
};

export function createWindowGameTransport(target: Window): GameTransport {
  return {
    post(message) {
      target.postMessage(message, "*");
    },
    listen(listener) {
      const onMessage = (event: MessageEvent): void => {
        // iframe 是 opaque origin，event.origin 为 "null"，只能比较 source。
        if (event.source !== target) return;
        if (!isGameHostMessage(event.data)) return;
        listener(event.data);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
  };
}
