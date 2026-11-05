/**
 * 场景 / 游戏包 replica 侧的只读游戏渲染桥（`@lull/game-sdk/scene`）。
 *
 * 宿主有两种挂载方式，消息协议相同：
 * - 场景包在 manifest 里声明 `game: { id, role: "replica" }` 且同时声明
 *   `wallpaper.script`；
 * - 游戏包自带 `entry.replica`，被直接设为壁纸。
 *
 * 宿主通过 iframe 的 postMessage 通道下发
 * `game.init / game.snapshot / game.event / game.render / game.lifecycle`
 * （或以 `game.unavailable` 告知当前没有可渲染的实例）。
 *
 * 这里只暴露只读能力：没有 commitState / command / publishEvent。
 */
import {
  GAME_PROTOCOL,
  type GameContext,
  type GameEvent,
  type GameLifecycleEvent,
  type GameRenderContext,
  type GameRenderState,
  type GameSnapshot,
  isGameContext,
  isGameEvent,
  isGameLifecycleEvent,
  isGameRenderContext,
  isGameRenderState,
  isGameSnapshot,
} from "./protocol.js";

export type SceneGameInitMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.init";
  context: GameContext;
  snapshot: GameSnapshot | null;
};

export type SceneGameSnapshotMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.snapshot";
  snapshot: GameSnapshot;
};

export type SceneGameEventMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.event";
  event: GameEvent;
};

export type SceneGameRenderMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.render";
  renderState: GameRenderState;
};

export type SceneGameLifecycleMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.lifecycle";
  event: GameLifecycleEvent;
};

export type SceneGameUnavailableMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.unavailable";
  reason?: string;
};

export type SceneGameHostMessage =
  | SceneGameInitMessage
  | SceneGameSnapshotMessage
  | SceneGameEventMessage
  | SceneGameRenderMessage
  | SceneGameLifecycleMessage
  | SceneGameUnavailableMessage;

export type SceneGameReadyMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.ready";
};

export type SceneGameRequestSnapshotMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.requestSnapshot";
};

export type SceneGameReportErrorMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.reportError";
  code: string;
  message: string;
};

export type SceneGameDetachMessage = {
  v: typeof GAME_PROTOCOL;
  type: "game.detach";
};

export type SceneGameClientMessage =
  | SceneGameReadyMessage
  | SceneGameRequestSnapshotMessage
  | SceneGameReportErrorMessage
  | SceneGameDetachMessage;

export type SceneGameTransport = {
  post(message: SceneGameClientMessage): void;
  listen(listener: (message: SceneGameHostMessage) => void): () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宿主 → 场景消息的最低校验；字段级校验按 type 分支。 */
export function isSceneGameHostMessage(
  value: unknown,
): value is SceneGameHostMessage {
  if (!isRecord(value) || value.v !== GAME_PROTOCOL) return false;
  switch (value.type) {
    case "game.init":
      return (
        isGameContext(value.context) &&
        (value.snapshot === null ||
          value.snapshot === undefined ||
          isGameSnapshot(value.snapshot))
      );
    case "game.snapshot":
      return isGameSnapshot(value.snapshot);
    case "game.event":
      return isGameEvent(value.event);
    case "game.render":
      return isGameRenderState(value.renderState);
    case "game.lifecycle":
      return isGameLifecycleEvent(value.event);
    case "game.unavailable":
      return value.reason === undefined || typeof value.reason === "string";
    default:
      return false;
  }
}

export function createWindowSceneGameTransport(
  target: Window,
): SceneGameTransport {
  return {
    post(message) {
      target.postMessage(message, "*");
    },
    listen(listener) {
      const onMessage = (event: MessageEvent): void => {
        // 场景 iframe 是 opaque origin，event.origin 为 "null"，只能比较 source。
        if (event.source !== target) return;
        if (!isSceneGameHostMessage(event.data)) return;
        listener(event.data);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
  };
}

export type LullGameRenderClient = {
  readonly context: GameContext;
  /** 当前显示器的渲染几何；replica 一定非 null。 */
  readonly render: GameRenderContext;
  getSnapshot<T = unknown>(): Promise<GameSnapshot<T> | null>;
  onSnapshot<T = unknown>(
    listener: (snapshot: GameSnapshot<T>) => void,
  ): () => void;
  onEvent<T = unknown>(
    type: string | "*",
    listener: (event: GameEvent<T>) => void,
  ): () => void;
  onRenderState<T = unknown>(
    listener: (state: GameRenderState<T>) => void,
  ): () => void;
  onLifecycle(listener: (event: GameLifecycleEvent) => void): () => void;
  /** 检测到 revision 缺口时主动重取快照。 */
  requestSnapshot(): void;
  destroy(): void;
};

export type ConnectLullGameRenderOptions = {
  /** 替换传输层；测试用内存实现。 */
  transport?: SceneGameTransport;
  /** 等待 `game.init` / `game.unavailable` 的超时；默认 12s（冷启动 authority 可能较慢）。 */
  timeoutMs?: number;
};

function defaultTransport(): SceneGameTransport | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  return createWindowSceneGameTransport(window.parent);
}

function reportError(
  transport: SceneGameTransport,
  code: string,
  message: string,
): void {
  try {
    transport.post({
      v: GAME_PROTOCOL,
      type: "game.reportError",
      code,
      message,
    });
  } catch {
    // 场景销毁/跨源异常时不打断渲染。
  }
}

/**
 * 连接宿主提供的只读游戏渲染桥。
 *
 * resolve 为 `null` 表示当前没有可渲染的实例（游戏未运行、场景未绑定或
 * 浏览器预览），调用方应回退到自己的静态视觉，而不是报错。
 */
export function connectLullGameRender(
  options: ConnectLullGameRenderOptions = {},
): Promise<LullGameRenderClient | null> {
  const transport = options.transport ?? defaultTransport();
  if (!transport) return Promise.resolve(null);
  const timeoutMs = options.timeoutMs ?? 12_000;

  return new Promise<LullGameRenderClient | null>((resolve) => {
    const snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
    const eventListeners = new Set<{
      type: string;
      listener: (event: GameEvent) => void;
    }>();
    const renderListeners = new Set<(state: GameRenderState) => void>();
    const lifecycleListeners = new Set<(event: GameLifecycleEvent) => void>();

    let settled = false;
    let disposed = false;
    let context: GameContext | null = null;
    let snapshot: GameSnapshot | null = null;
    let lastRevision = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stopListening = transport.listen((message) => {
      if (disposed) return;
      switch (message.type) {
        case "game.init": {
          const render = message.context.render;
          if (
            message.context.role !== "replica" ||
            !isGameRenderContext(render)
          ) {
            if (!settled) settle(null);
            return;
          }
          if (settled) {
            // iframe 重载/重连：更新 context 与渲染几何，不重建客户端。
            context = message.context;
            if (message.snapshot) {
              snapshot = message.snapshot;
              lastRevision = Math.max(lastRevision, message.snapshot.revision);
            }
            return;
          }
          context = message.context;
          lastRevision = message.context.revision;
          snapshot = message.snapshot ?? null;
          if (snapshot) lastRevision = snapshot.revision;
          settle(gameClient);
          return;
        }
        case "game.unavailable":
          settle(null);
          return;
        case "game.snapshot":
          if (!settled) return;
          snapshot = message.snapshot;
          lastRevision = Math.max(lastRevision, message.snapshot.revision);
          for (const listener of [...snapshotListeners])
            listener(message.snapshot);
          return;
        case "game.event": {
          if (!settled || !context) return;
          if (message.event.authorityEpoch !== context.authorityEpoch) {
            requestSnapshot();
            return;
          }
          if (message.event.revision > lastRevision + 1) {
            requestSnapshot();
            return;
          }
          lastRevision = Math.max(lastRevision, message.event.revision);
          for (const entry of [...eventListeners]) {
            if (entry.type === "*" || entry.type === message.event.type) {
              entry.listener(message.event);
            }
          }
          return;
        }
        case "game.render":
          if (!settled) return;
          for (const listener of [...renderListeners]) {
            listener(message.renderState);
          }
          return;
        case "game.lifecycle": {
          if (!settled || !context) return;
          context.authorityEpoch = message.event.authorityEpoch;
          context.revision = Math.max(context.revision, message.event.revision);
          lastRevision = Math.max(lastRevision, message.event.revision);
          for (const listener of [...lifecycleListeners]) {
            listener(message.event);
          }
          return;
        }
      }
    });

    const requestSnapshot = (): void => {
      if (disposed) return;
      transport.post({ v: GAME_PROTOCOL, type: "game.requestSnapshot" });
    };

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    function settle(client: LullGameRenderClient | null): void {
      if (settled) return;
      settled = true;
      clearTimer();
      if (client === null) {
        stopListening();
        disposed = true;
      }
      resolve(client);
    }

    const gameClient: LullGameRenderClient = {
      get context() {
        return context as GameContext;
      },
      get render() {
        return (context as GameContext).render as GameRenderContext;
      },
      getSnapshot<T>(): Promise<GameSnapshot<T> | null> {
        return Promise.resolve(snapshot as GameSnapshot<T> | null);
      },
      onSnapshot<T>(listener: (next: GameSnapshot<T>) => void) {
        snapshotListeners.add(listener as (next: GameSnapshot) => void);
        if (snapshot) listener(snapshot as GameSnapshot<T>);
        return () => {
          snapshotListeners.delete(listener as (next: GameSnapshot) => void);
        };
      },
      onEvent<T>(type: string | "*", listener: (event: GameEvent<T>) => void) {
        const entry = {
          type,
          listener: listener as (event: GameEvent) => void,
        };
        eventListeners.add(entry);
        return () => {
          eventListeners.delete(entry);
        };
      },
      onRenderState<T>(listener: (state: GameRenderState<T>) => void) {
        renderListeners.add(listener as (state: GameRenderState) => void);
        return () => {
          renderListeners.delete(listener as (state: GameRenderState) => void);
        };
      },
      onLifecycle(listener) {
        lifecycleListeners.add(listener);
        return () => {
          lifecycleListeners.delete(listener);
        };
      },
      requestSnapshot,
      destroy() {
        if (disposed) return;
        disposed = true;
        clearTimer();
        stopListening();
        snapshotListeners.clear();
        eventListeners.clear();
        renderListeners.clear();
        lifecycleListeners.clear();
        transport.post({ v: GAME_PROTOCOL, type: "game.detach" });
      },
    };

    // 双保险：宿主可能先于监听器发送 init，因此先监听再发 ready。
    transport.post({ v: GAME_PROTOCOL, type: "game.ready" });
    timer = setTimeout(() => {
      if (settled) return;
      settle(null);
    }, timeoutMs);

    // 让宿主在场景侧尚未 ready 时也能报告显式错误之外的问题。
    if (typeof window !== "undefined") {
      // no-op：真正的错误上报入口在 client.destroy/reportError 之外由宿主处理。
    }
  });
}

/** 上报渲染错误（不触发 Authority failover）。 */
export function reportSceneGameError(
  transport: SceneGameTransport,
  error: { code: string; message: string },
): void {
  reportError(transport, error.code, error.message);
}
