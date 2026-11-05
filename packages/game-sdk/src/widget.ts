/**
 * Controller Widget 侧客户端：通过 `@lull/widget-sdk` 的桥方法连接游戏，
 * 再监听宿主壳转发的 `game.snapshot` / `game.event` / `game.lifecycle`。
 *
 * 这里不 import `@lull/widget-sdk`，避免 SDK 包构建依赖另一个包的产物；
 * `GameWidgetHost` 只声明实际用到的 4 个桥方法与 `has()`，与
 * `LullWidgetClient` 结构兼容，控制器工程可以直接把 `connectLullWidget()`
 * 的返回值传进来。
 */
import { LullGameError } from "./errors.js";
import {
  GAME_DEFAULT_LIMITS,
  GAME_HOST_API,
  GAME_PROTOCOL,
  type GameCommandResult,
  type GameContext,
  type GameEvent,
  type GameLifecycleEvent,
  type GameSnapshot,
  isGameCommandResult,
  isGameConnectResult,
  isGameEvent,
  isGameLifecycleEvent,
  isGameSnapshot,
} from "./protocol.js";

/** 只用到的 Widget 桥方法；字段与 `@lull/widget-sdk` 的 `WidgetBridgeMethods` 一致。 */
export type GameWidgetBridgeMethods = {
  "game.connect": {
    params: { gameId: string };
    result: unknown;
  };
  "game.snapshot": {
    params: Record<string, never>;
    result: unknown;
  };
  "game.command": {
    params: {
      requestId: string;
      type: string;
      payload: unknown;
      expectedRevision?: number;
    };
    result: unknown;
  };
  "game.disconnect": {
    params: Record<string, never>;
    result: { disconnected: boolean };
  };
};

/**
 * `LullWidgetClient` 的结构子集。控制器工程传入真实客户端即可；
 * 单独测试时实现这两个方法就能驱动 Game SDK。
 */
export type GameWidgetHost = {
  readonly locale?: string;
  has(capability: string): boolean;
  request<M extends keyof GameWidgetBridgeMethods>(
    method: M,
    params: GameWidgetBridgeMethods[M]["params"],
  ): Promise<GameWidgetBridgeMethods[M]["result"]>;
};

export type ConnectLullGameWidgetOptions = {
  gameId: string;
  /** 连接 / 取快照的超时；默认 10s。 */
  timeoutMs?: number;
};

export type LullGameCommandOptions = {
  /** 不传时由 SDK 生成。 */
  requestId?: string;
  expectedRevision?: number;
  /** 单次命令超时；默认沿用连接超时。 */
  timeoutMs?: number;
};

export type LullGameWidgetClient = {
  /** 角色固定为 controller；实例未运行时 `instanceId` 为 null。 */
  readonly context: GameContext;
  /** 最近一份快照；尚未取过且宿主没推过时为 null。 */
  readonly snapshot: GameSnapshot | null;
  /**
   * 先返回缓存；没有缓存时调用桥方法 `game.snapshot`。
   * 游戏未运行时返回 null（正常态，不抛错）。
   */
  getSnapshot<T = unknown>(): Promise<GameSnapshot<T> | null>;
  /** 订阅后续快照推送；注册时不自动回放。 */
  onSnapshot(listener: (snapshot: GameSnapshot) => void): () => void;
  /** 订阅事件；`type` 传 `"*"` 表示全部类型。 */
  onEvent<T = unknown>(
    type: string,
    listener: (event: GameEvent<T>) => void,
  ): () => void;
  onLifecycle(listener: (event: GameLifecycleEvent) => void): () => void;
  /** 发送命令；`requestId` 缺省由 SDK 生成。 */
  command<T = unknown>(
    type: string,
    payload?: T,
    options?: LullGameCommandOptions,
  ): Promise<GameCommandResult>;
  /** 退订、移除监听并通知宿主断开；之后所有调用返回 `disposed`。 */
  destroy(): void;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 连接 Controller Widget 与指定游戏。
 *
 * ```ts
 * const widget = await connectLullWidget();
 * const game = await connectLullGameWidget(widget, {
 *   gameId: "community.living-world",
 * });
 * ```
 */
export async function connectLullGameWidget(
  host: GameWidgetHost,
  options: ConnectLullGameWidgetOptions,
): Promise<LullGameWidgetClient> {
  const gameId = options.gameId.trim();
  if (!gameId) {
    throw new LullGameError("bad-init", "gameId 不能为空。");
  }
  if (
    !host.has("game.state.read") &&
    !host.has("game.command.send") &&
    !host.has("game.event.read")
  ) {
    throw new LullGameError(
      "permission-denied",
      "Widget 未获得任何 game.* 能力，无法连接游戏。",
    );
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
  const eventListeners = new Map<string, Set<(event: GameEvent) => void>>();
  const anyEventListeners = new Set<(event: GameEvent) => void>();
  const lifecycleListeners = new Set<(event: GameLifecycleEvent) => void>();

  let context: GameContext | null = null;
  let currentSnapshot: GameSnapshot | null = null;
  let disposed = false;

  const requireContext = (): GameContext => {
    if (!context) {
      throw new LullGameError("not-connected", "尚未连接游戏。");
    }
    return context;
  };

  const assertActive = (): void => {
    if (disposed) {
      throw new LullGameError("disposed", "客户端已销毁。");
    }
  };

  const syncContext = (snapshot: GameSnapshot): void => {
    if (!context) return;
    context.instanceId = snapshot.instanceId;
    context.revision = snapshot.revision;
    context.authorityEpoch = snapshot.authorityEpoch;
    context.simulationTimeMs = snapshot.simulationTimeMs;
  };

  const emitEvent = (event: GameEvent): void => {
    for (const listener of [
      ...(eventListeners.get(event.type) ?? []),
      ...anyEventListeners,
    ]) {
      listener(event);
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed || !context) return;
    // Widget iframe 是 opaque origin，只能比较 source；父窗口可能为 null（部分测试宿主）。
    if (
      event.source !== null &&
      typeof window !== "undefined" &&
      event.source !== window.parent
    ) {
      return;
    }
    const data: unknown = event.data;
    if (!isRecord(data) || data.v !== GAME_PROTOCOL) return;

    switch (data.type) {
      case "game.snapshot": {
        if (!isGameSnapshot(data.snapshot)) return;
        currentSnapshot = data.snapshot;
        syncContext(data.snapshot);
        for (const listener of [...snapshotListeners]) {
          listener(data.snapshot);
        }
        return;
      }
      case "game.event": {
        if (!isGameEvent(data.event)) return;
        emitEvent(data.event);
        return;
      }
      case "game.lifecycle": {
        if (!isGameLifecycleEvent(data.event)) return;
        context.authorityEpoch = data.event.authorityEpoch;
        context.revision = data.event.revision;
        for (const listener of [...lifecycleListeners]) {
          listener(data.event);
        }
        return;
      }
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("message", onMessage);
  }

  let connectResult: unknown;
  try {
    connectResult = await withBridgeTimeout(
      host.request("game.connect", { gameId }),
      timeoutMs,
      "game.connect",
    );
  } catch (error) {
    removeMessageListener(onMessage);
    throw wrapWidgetError(error);
  }

  if (!isGameConnectResult(connectResult)) {
    removeMessageListener(onMessage);
    throw new LullGameError("bad-init", "game.connect 返回了非法结果。");
  }

  if (connectResult.context) {
    context = {
      ...connectResult.context,
      role: "controller",
      instanceId: connectResult.context.instanceId ?? null,
    };
  } else {
    context = {
      protocol: GAME_PROTOCOL,
      hostApi: GAME_HOST_API,
      role: "controller",
      gameId,
      instanceId: null,
      authorityEpoch: 0,
      revision: 0,
      simulationTimeMs: 0,
      render: null,
      limits: { ...GAME_DEFAULT_LIMITS },
      locale: host.locale ?? "zh-CN",
    };
  }

  const client: LullGameWidgetClient = {
    get context() {
      return requireContext();
    },
    get snapshot() {
      return currentSnapshot;
    },

    async getSnapshot<T = unknown>() {
      assertActive();
      if (currentSnapshot) return currentSnapshot as GameSnapshot<T>;
      const result = await withBridgeTimeout(
        host.request("game.snapshot", {}),
        timeoutMs,
        "game.snapshot",
      ).catch((error: unknown) => {
        throw wrapWidgetError(error);
      });
      if (result === null) return null;
      if (!isGameSnapshot<T>(result)) {
        throw new LullGameError("host-error", "game.snapshot 返回了非法快照。");
      }
      currentSnapshot = result;
      syncContext(result);
      return result;
    },

    onSnapshot(listener) {
      assertActive();
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },

    onEvent(type, listener) {
      assertActive();
      const wrapped = listener as (event: GameEvent) => void;
      if (type === "*") {
        anyEventListeners.add(wrapped);
        return () => {
          anyEventListeners.delete(wrapped);
        };
      }
      let listeners = eventListeners.get(type);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(type, listeners);
      }
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },

    onLifecycle(listener) {
      assertActive();
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },

    async command<T = unknown>(
      type: string,
      payload?: T,
      commandOptions: LullGameCommandOptions = {},
    ) {
      assertActive();
      if (!host.has("game.command.send")) {
        throw new LullGameError(
          "permission-denied",
          "未获得 game.command.send 权限。",
        );
      }
      const params: GameWidgetBridgeMethods["game.command"]["params"] = {
        requestId: commandOptions.requestId ?? createRequestId(),
        type,
        payload,
      };
      if (typeof commandOptions.expectedRevision === "number") {
        params.expectedRevision = commandOptions.expectedRevision;
      }
      const commandTimeoutMs = Number.isFinite(commandOptions.timeoutMs)
        ? Number(commandOptions.timeoutMs)
        : timeoutMs;
      const result = await withBridgeTimeout(
        host.request("game.command", params),
        commandTimeoutMs,
        "game.command",
      ).catch((error: unknown) => {
        throw wrapWidgetError(error);
      });
      if (!isGameCommandResult(result)) {
        throw new LullGameError("host-error", "game.command 返回了非法结果。");
      }
      return result;
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      removeMessageListener(onMessage);
      snapshotListeners.clear();
      eventListeners.clear();
      anyEventListeners.clear();
      lifecycleListeners.clear();
      void host.request("game.disconnect", {}).catch(() => {
        // 宿主/窗口可能已经销毁；断开失败不影响本地清理。
      });
    },
  };

  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeMessageListener(listener: (event: MessageEvent) => void): void {
  if (typeof window === "undefined") return;
  window.removeEventListener("message", listener);
}

function createRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function withBridgeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new LullGameError(
          "request-timeout",
          `宿主未在 ${timeoutMs}ms 内响应 ${label}。`,
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wrapWidgetError(error: unknown): LullGameError {
  if (error instanceof LullGameError) return error;
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "disposed":
      return new LullGameError("disposed", message);
    case "timeout":
      return new LullGameError("request-timeout", message);
    case "init-timeout":
      return new LullGameError("init-timeout", message);
    case "bad-init":
      return new LullGameError("bad-init", message);
    case "not-embedded":
      return new LullGameError("not-connected", message);
    default:
      return new LullGameError("host-error", message);
  }
}
