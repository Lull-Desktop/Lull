/**
 * 包内控制器客户端（`@lull/game-sdk/controller`）。
 *
 * 运行在游戏包自带的控制器页面里：页面由宿主壳 `/game-controller` 以 sandbox
 * iframe 承载，宿主完成 `game_connect` 后通过 postMessage 下发 `init`。SDK 只
 * 负责握手、请求/响应与快照/事件/生命周期订阅，不直接接触 Tauri IPC。
 */
import { LullGameError } from "./errors.js";
import {
  GAME_PROTOCOL,
  type GameCommandResult,
  type GameContext,
  type GameControllerBridgeMethod,
  type GameControllerBridgeMethods,
  type GameControllerBridgeParams,
  type GameControllerBridgeResult,
  type GameControllerRequestMessage,
  type GameEvent,
  type GameHostMessage,
  type GameLifecycleEvent,
  type GameReportErrorRequest,
  type GameSnapshot,
  isGameCommandResult,
  isGameContext,
  isGameEvent,
  isGameLifecycleEvent,
  isGameSnapshot,
} from "./protocol.js";
import {
  createWindowGameControllerTransport,
  type GameControllerTransport,
} from "./transport.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export type ConnectLullGameControllerOptions = {
  /** 替换传输层；测试用内存实现。 */
  transport?: GameControllerTransport;
  /** 等待宿主 init 的超时；默认 10s。 */
  timeoutMs?: number;
};

export type LullGameControllerOptions = {
  /** 不传时由 SDK 生成。 */
  requestId?: string;
  expectedRevision?: number;
  /** 单次请求超时；默认沿用连接超时。 */
  timeoutMs?: number;
};

export type LullGameControllerClient = {
  /** 宿主下发的控制器上下文（`role = controller`，含 `controllerId`）。 */
  readonly context: GameContext;
  /** 最近一份快照；尚未取过且宿主没推过时为 null。 */
  readonly snapshot: GameSnapshot | null;
  /** 先返回缓存；没有缓存时向宿主取一次。 */
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
    options?: LullGameControllerOptions,
  ): Promise<GameCommandResult>;
  /** 上报错误；`scope` 缺省为 controller。 */
  reportError(input: {
    code: string;
    message: string;
    scope?: string;
  }): Promise<void>;
  /** 退订、移除监听并通知宿主断开；之后所有调用返回 `disposed`。 */
  destroy(): void;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type InitResult = {
  context: GameContext;
  snapshot: GameSnapshot | null;
};

/** 连接宿主壳并等待 `init`；不在控制器 iframe 内调用会抛 `not-connected`。 */
export function connectLullGameController(
  options: ConnectLullGameControllerOptions = {},
): Promise<LullGameControllerClient> {
  const transport =
    options.transport ??
    (typeof window !== "undefined"
      ? createWindowGameControllerTransport(window.parent)
      : null);
  if (!transport) {
    return Promise.reject(
      new LullGameError("not-connected", "只能在控制器 iframe 内连接游戏。"),
    );
  }
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  return createClient(transport, timeoutMs);
}

async function createClient(
  transport: GameControllerTransport,
  timeoutMs: number,
): Promise<LullGameControllerClient> {
  const snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
  const eventListeners = new Map<string, Set<(event: GameEvent) => void>>();
  const anyEventListeners = new Set<(event: GameEvent) => void>();
  const lifecycleListeners = new Set<(event: GameLifecycleEvent) => void>();
  const pending = new Map<number, PendingEntry>();
  let sequence = 0;
  let disposed = false;
  let currentSnapshot: GameSnapshot | null = null;
  let context: GameContext | null = null;
  let initSettled = false;

  let resolveInit: (result: InitResult) => void = () => {};
  let rejectInit: (reason: unknown) => void = () => {};
  const ready = new Promise<InitResult>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const syncContext = (snapshot: GameSnapshot): void => {
    if (!context) return;
    context.instanceId = snapshot.instanceId;
    context.revision = snapshot.revision;
    context.authorityEpoch = snapshot.authorityEpoch;
    context.simulationTimeMs = snapshot.simulationTimeMs;
  };

  const onHostMessage = (message: GameHostMessage): void => {
    if (disposed) return;
    switch (message.type) {
      case "init": {
        if (initSettled) return;
        initSettled = true;
        if (!isGameContext(message.context)) {
          rejectInit(
            new LullGameError("bad-init", "宿主 init 的 context 不合法。"),
          );
          return;
        }
        const snapshot =
          message.snapshot && isGameSnapshot(message.snapshot)
            ? message.snapshot
            : null;
        resolveInit({ context: message.context, snapshot });
        return;
      }
      case "init-error": {
        if (initSettled) return;
        initSettled = true;
        rejectInit(
          new LullGameError(
            "host-error",
            message.error?.message ?? "宿主初始化控制器失败。",
            message.error,
          ),
        );
        return;
      }
      case "snapshot": {
        if (!isGameSnapshot(message.snapshot)) return;
        currentSnapshot = message.snapshot;
        syncContext(message.snapshot);
        for (const listener of [...snapshotListeners]) {
          listener(message.snapshot);
        }
        return;
      }
      case "event": {
        if (!isGameEvent(message.event)) return;
        for (const listener of [
          ...(eventListeners.get(message.event.type) ?? []),
          ...anyEventListeners,
        ]) {
          listener(message.event);
        }
        return;
      }
      case "lifecycle": {
        if (!isGameLifecycleEvent(message.event)) return;
        if (context) {
          context.authorityEpoch = message.event.authorityEpoch;
          context.revision = message.event.revision;
        }
        for (const listener of [...lifecycleListeners]) {
          listener(message.event);
        }
        return;
      }
      case "response": {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message.result);
          return;
        }
        entry.reject(
          new LullGameError(
            "host-error",
            message.error?.message ?? "宿主没有完成请求。",
            message.error,
          ),
        );
        return;
      }
      default:
        return;
    }
  };

  const stopListening = transport.listen(onHostMessage);
  transport.post({ v: GAME_PROTOCOL, type: "ready" });

  try {
    const init = await withTimeout(
      ready,
      timeoutMs,
      () =>
        new LullGameError(
          "init-timeout",
          `宿主未在 ${timeoutMs}ms 内下发控制器上下文。`,
        ),
    );
    context = {
      ...init.context,
      role: "controller",
      instanceId: init.context.instanceId ?? null,
    };
    currentSnapshot = init.snapshot;
    if (currentSnapshot) syncContext(currentSnapshot);
  } catch (error) {
    stopListening();
    throw error;
  }

  const requireContext = (): GameContext => {
    if (!context) {
      throw new LullGameError("not-connected", "控制器尚未连接游戏。");
    }
    return context;
  };

  const assertActive = (): void => {
    if (disposed) {
      throw new LullGameError("disposed", "控制器客户端已销毁。");
    }
  };

  const request = <M extends GameControllerBridgeMethod>(
    method: M,
    params: GameControllerBridgeParams<M>,
    requestTimeoutMs: number,
  ): Promise<GameControllerBridgeResult<M>> => {
    assertActive();
    const id = ++sequence;
    return new Promise<GameControllerBridgeResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new LullGameError(
            "request-timeout",
            `宿主未在 ${requestTimeoutMs}ms 内响应 ${method}。`,
          ),
        );
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => resolve(value as GameControllerBridgeResult<M>),
        reject,
        timer,
      });
      const message: GameControllerRequestMessage<M> = {
        v: GAME_PROTOCOL,
        type: "request",
        id,
        method,
        params,
      };
      transport.post(message);
    });
  };

  const client: LullGameControllerClient = {
    get context() {
      return requireContext();
    },
    get snapshot() {
      return currentSnapshot;
    },

    async getSnapshot<T = unknown>() {
      assertActive();
      if (currentSnapshot) return currentSnapshot as GameSnapshot<T>;
      const result = await request("snapshot.get", {}, timeoutMs);
      if (result === null) return null;
      if (!isGameSnapshot<T>(result)) {
        throw new LullGameError("host-error", "宿主返回了非法快照。");
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
      commandOptions: LullGameControllerOptions = {},
    ) {
      assertActive();
      const params: GameControllerBridgeMethods["command.send"]["params"] = {
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
      const result = await request("command.send", params, commandTimeoutMs);
      if (!isGameCommandResult(result)) {
        throw new LullGameError("host-error", "宿主返回了非法命令结果。");
      }
      return result;
    },

    async reportError(input) {
      assertActive();
      const params: GameReportErrorRequest = {
        scope: input.scope ?? "controller",
        code: input.code,
        message: input.message,
      };
      await request("error.report", params, timeoutMs);
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      stopListening();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new LullGameError("disposed", "控制器客户端已销毁。"));
      }
      pending.clear();
      snapshotListeners.clear();
      eventListeners.clear();
      anyEventListeners.clear();
      lifecycleListeners.clear();
      try {
        transport.post({
          v: GAME_PROTOCOL,
          type: "request",
          id: ++sequence,
          method: "disconnect",
          params: {},
        });
      } catch {
        // 窗口正在销毁时 postMessage 可能失败；宿主侧窗口销毁会清理 binding。
      }
    },
  };

  return client;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createError()), timeoutMs);
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
