import { LullSceneError } from "./errors.js";
import {
  SCENE_PROTOCOL,
  type SceneFrame,
  type SceneHostMessage,
  type SceneInitMessage,
  type SceneParamValue,
} from "./protocol.js";
import {
  createWindowSceneTransport,
  type SceneTransport,
} from "./transport.js";

export type LullSceneClient = {
  /** 场景 id（来自 Manifest）。 */
  readonly id: string;
  /** 宿主 Scene Host API 版本。 */
  readonly hostApi: number;
  /** 桥协议版本，固定为 1。 */
  readonly protocol: typeof SCENE_PROTOCOL;
  /** 最近一帧；init 之前为 null。 */
  readonly frame: SceneFrame | null;
  /** 当前参数（已按 Manifest 类型还原）；init 之前为空对象。 */
  readonly params: Record<string, SceneParamValue>;
  /** 当前窗口是否可见（关闭/隐藏时由宿主下发）。 */
  readonly visible: boolean;

  /** 订阅帧更新；注册时立即回放当前帧。 */
  onFrame(listener: (frame: SceneFrame) => void): () => void;
  /** 只订阅参数变化；注册时立即回放当前参数。 */
  onParams(
    listener: (params: Record<string, SceneParamValue>) => void,
  ): () => void;
  /** 订阅窗口可见性；注册时立即回放当前值。 */
  onVisibility(listener: (visible: boolean) => void): () => void;
  /** 转发到宿主控制台，前缀 `[scene:<id>]`。 */
  log(message: string, level?: "log" | "warn" | "error"): void;
  /** 退订全部监听并拒绝后续调用。 */
  destroy(): void;
};

export type ConnectLullSceneOptions = {
  /** 替换传输层；测试用 `@lull/scene-sdk/testing` 的内存实现。 */
  transport?: SceneTransport;
  /** 等待宿主 init 的超时；默认 10s。 */
  timeoutMs?: number;
};

/** 同一页面重复调用返回同一个连接。 */
let singleton: Promise<LullSceneClient> | null = null;

export function connectLullScene(
  options: ConnectLullSceneOptions = {},
): Promise<LullSceneClient> {
  if (singleton) return singleton;
  const connection = createLullSceneClient(options);
  singleton = connection.catch((error: unknown) => {
    singleton = null;
    throw error;
  });
  return singleton;
}

/**
 * 创建一个独立连接（不走单例）。测试与多场景页面可以直接使用；
 * 普通场景页面用 `connectLullScene()` 即可。
 */
export function createLullSceneClient(
  options: ConnectLullSceneOptions = {},
): Promise<LullSceneClient> {
  return new Promise((resolve, reject) => {
    let transport: SceneTransport;
    try {
      transport = options.transport ?? defaultTransport();
    } catch (error) {
      reject(error);
      return;
    }

    const timeoutMs = options.timeoutMs ?? 10_000;
    const frameListeners = new Set<(frame: SceneFrame) => void>();
    const paramListeners = new Set<
      (params: Record<string, SceneParamValue>) => void
    >();
    const visibilityListeners = new Set<(visible: boolean) => void>();

    let init: SceneInitMessage | null = null;
    let currentFrame: SceneFrame | null = null;
    let visible = true;
    let disposed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const cleanup = (): void => {
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
    };

    const emitFrame = (): void => {
      if (!currentFrame) return;
      for (const listener of [...frameListeners]) listener(currentFrame);
      for (const listener of [...paramListeners]) listener(currentFrame.params);
    };

    const client: LullSceneClient = {
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
      onFrame(listener) {
        frameListeners.add(listener);
        if (currentFrame) listener(currentFrame);
        return () => {
          frameListeners.delete(listener);
        };
      },
      onParams(listener) {
        paramListeners.add(listener);
        if (currentFrame) listener(currentFrame.params);
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
      log(message, level = "log") {
        if (disposed) return;
        transport.send({
          v: SCENE_PROTOCOL,
          type: "log",
          level,
          message,
        });
      },
      destroy() {
        if (disposed) return;
        disposed = true;
        cleanup();
        frameListeners.clear();
        paramListeners.clear();
        visibilityListeners.clear();
      },
    };

    const handleMessage = (message: SceneHostMessage): void => {
      if (disposed) return;

      if (message.type === "init") {
        init = message;
        currentFrame = message.frame;
        visible = message.visible;
        if (!settled) {
          settled = true;
          clearTimer();
          resolve(client);
        }
        emitFrame();
        for (const listener of [...visibilityListeners]) listener(visible);
        return;
      }

      if (message.type === "frame") {
        currentFrame = message.frame;
        emitFrame();
        return;
      }

      visible = message.visible;
      for (const listener of [...visibilityListeners]) listener(visible);
    };

    unsubscribe = transport.listen(handleMessage);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new LullSceneError(
          "init-timeout",
          `宿主未在 ${timeoutMs}ms 内发送 scene init。`,
        ),
      );
    }, timeoutMs);

    transport.send({
      v: SCENE_PROTOCOL,
      type: "ready",
      protocol: SCENE_PROTOCOL,
    });
  });
}

function defaultTransport(): SceneTransport {
  if (typeof window === "undefined" || window.parent === window) {
    throw new LullSceneError(
      "not-embedded",
      "当前页面不在 Lull 壁纸场景 iframe 中；请从壁纸窗口运行，或注入自定义 transport。",
    );
  }
  return createWindowSceneTransport(window.parent);
}
