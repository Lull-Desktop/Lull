import { LullSceneError } from "./errors.js";
import { SCENE_PROTOCOL, } from "./protocol.js";
import { createWindowSceneTransport, } from "./transport.js";
/** 同一页面重复调用返回同一个连接。 */
let singleton = null;
/**
 * 只复制协议内的移动字段：未来宿主若在 pointer 里追加点击/按键信息，
 * SDK 也不会把它们暴露给场景。
 */
function readPointer(pointer) {
    return {
        x: pointer.x,
        y: pointer.y,
        inside: pointer.inside,
        moving: pointer.moving,
    };
}
export function connectLullScene(options = {}) {
    if (singleton)
        return singleton;
    const connection = createLullSceneClient(options);
    singleton = connection.catch((error) => {
        singleton = null;
        throw error;
    });
    return singleton;
}
/**
 * 创建一个独立连接（不走单例）。测试与多场景页面可以直接使用；
 * 普通场景页面用 `connectLullScene()` 即可。
 */
export function createLullSceneClient(options = {}) {
    return new Promise((resolve, reject) => {
        let transport;
        try {
            transport = options.transport ?? defaultTransport();
        }
        catch (error) {
            reject(error);
            return;
        }
        const timeoutMs = options.timeoutMs ?? 10_000;
        const frameListeners = new Set();
        const paramListeners = new Set();
        const visibilityListeners = new Set();
        const pointerListeners = new Set();
        let init = null;
        let currentFrame = null;
        let currentPointer = null;
        let visible = true;
        let disposed = false;
        let settled = false;
        let timer = null;
        let unsubscribe = null;
        const clearTimer = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
        const cleanup = () => {
            clearTimer();
            unsubscribe?.();
            unsubscribe = null;
        };
        const emitFrame = () => {
            if (!currentFrame)
                return;
            for (const listener of [...frameListeners])
                listener(currentFrame);
            for (const listener of [...paramListeners])
                listener(currentFrame.params);
        };
        const client = {
            get id() {
                return init?.id ?? "";
            },
            get hostApi() {
                return init?.hostApi ?? 0;
            },
            get protocol() {
                return SCENE_PROTOCOL;
            },
            get frame() {
                return currentFrame;
            },
            get params() {
                return currentFrame?.params ?? {};
            },
            get visible() {
                return visible;
            },
            get pointer() {
                return currentPointer;
            },
            onFrame(listener) {
                frameListeners.add(listener);
                if (currentFrame)
                    listener(currentFrame);
                return () => {
                    frameListeners.delete(listener);
                };
            },
            onParams(listener) {
                paramListeners.add(listener);
                if (currentFrame)
                    listener(currentFrame.params);
                return () => {
                    paramListeners.delete(listener);
                };
            },
            onVisibility(listener) {
                visibilityListeners.add(listener);
                listener(visible);
                return () => {
                    visibilityListeners.delete(listener);
                };
            },
            onPointer(listener) {
                pointerListeners.add(listener);
                if (currentPointer)
                    listener(currentPointer);
                return () => {
                    pointerListeners.delete(listener);
                };
            },
            log(message, level = "log") {
                if (disposed)
                    return;
                transport.send({
                    v: SCENE_PROTOCOL,
                    type: "log",
                    level,
                    message,
                });
            },
            destroy() {
                if (disposed)
                    return;
                disposed = true;
                cleanup();
                frameListeners.clear();
                paramListeners.clear();
                visibilityListeners.clear();
                pointerListeners.clear();
                currentPointer = null;
            },
        };
        const handleMessage = (message) => {
            if (disposed)
                return;
            if (message.type === "init") {
                init = message;
                currentFrame = message.frame;
                currentPointer = null;
                visible = message.visible;
                if (!settled) {
                    settled = true;
                    clearTimer();
                    resolve(client);
                }
                emitFrame();
                for (const listener of [...visibilityListeners])
                    listener(visible);
                return;
            }
            if (message.type === "frame") {
                currentFrame = message.frame;
                emitFrame();
                return;
            }
            if (message.type === "pointer") {
                // 只接受 init 之后的指针样本；init 之前的消息没有场景上下文。
                if (!init)
                    return;
                currentPointer = readPointer(message.pointer);
                for (const listener of [...pointerListeners])
                    listener(currentPointer);
                return;
            }
            visible = message.visible;
            for (const listener of [...visibilityListeners])
                listener(visible);
        };
        unsubscribe = transport.listen(handleMessage);
        timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(new LullSceneError("init-timeout", `宿主未在 ${timeoutMs}ms 内发送 scene init。`));
        }, timeoutMs);
        transport.send({
            v: SCENE_PROTOCOL,
            type: "ready",
            protocol: SCENE_PROTOCOL,
        });
    });
}
function defaultTransport() {
    if (typeof window === "undefined" || window.parent === window) {
        throw new LullSceneError("not-embedded", "当前页面不在 Lull 壁纸场景 iframe 中；请从壁纸窗口运行，或注入自定义 transport。");
    }
    return createWindowSceneTransport(window.parent);
}
//# sourceMappingURL=client.js.map