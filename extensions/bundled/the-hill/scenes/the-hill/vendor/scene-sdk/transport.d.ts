import { type SceneClientMessage, type SceneHostMessage } from "./protocol.js";
/**
 * 场景与宿主之间的传输层。默认实现是 `window.parent.postMessage`，
 * 内存实现用于插件作者不启动宿主也能写单测（见 `@lull/scene-sdk/testing`）。
 */
export type SceneTransport = {
    send(message: SceneClientMessage): void;
    listen(listener: (message: SceneHostMessage) => void): () => void;
};
export declare function createWindowSceneTransport(target: Window): SceneTransport;
//# sourceMappingURL=transport.d.ts.map