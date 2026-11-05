/**
 * Authority 侧客户端：握手、请求/响应、快照/事件/命令/tick/lifecycle 订阅，
 * 以及自动填充身份字段的状态提交。
 *
 * 只依赖可注入的 `GameTransport`，不假设自己一定跑在 iframe 里；默认传输是
 * `window.parent.postMessage`。
 */
import { LullGameError } from "./errors.js";
import {
  GAME_HOST_API,
  GAME_PROTOCOL,
  type GameBridgeMethod,
  type GameBridgeParams,
  type GameBridgeResult,
  type GameCommand,
  type GameCommandResultInput,
  type GameCommitResult,
  type GameContext,
  type GameEvent,
  type GameHostMessage,
  type GameInitMessage,
  type GameLifecycleEvent,
  type GameSnapshot,
  type GameStateCommitRequest,
  type GameStateUpdate,
  type GameTick,
  isGameCommitResult,
  isGameHostMessage,
  isGameSnapshot,
} from "./protocol.js";
import { createWindowGameTransport, type GameTransport } from "./transport.js";

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type ConnectLullGameOptions = {
  /** 替换传输层；测试用 `@lull/game-sdk/testing` 的内存实现。 */
  transport?: GameTransport;
  /** 等待宿主 init 的超时；默认 10s。 */
  timeoutMs?: number;
  /** 单次 request 的超时；默认 10s。 */
  requestTimeoutMs?: number;
};

export type LullGameClient = {
  /** 宿主下发的上下文；`destroy()` 后仍可读。 */
  readonly context: GameContext;
  /** 最近一份快照；init 没有快照时为 null。 */
  readonly snapshot: GameSnapshot | null;

  /**
   * 主动向宿主取一份完整快照（`snapshot.get`），并更新本地缓存。
   * 实例已停止时返回 null。
   */
  getSnapshot<T = unknown>(): Promise<GameSnapshot<T> | null>;

  /**
   * 订阅后续快照推送；注册时不自动回放当前缓存。
   * 需要首帧请先调用 `getSnapshot()`。
   */
  onSnapshot(listener: (snapshot: GameSnapshot) => void): () => void;
  /** 订阅事件；`type` 传 `"*"` 表示全部类型。 */
  onEvent<T = unknown>(
    type: string,
    listener: (event: GameEvent<T>) => void,
  ): () => void;
  /** 订阅宿主路由过来的命令；`type` 传 `"*"` 表示全部类型。 */
  onCommand<T = unknown>(
    type: string,
    listener: (command: GameCommand<T>) => void,
  ): () => void;
  onTick(listener: (tick: GameTick) => void): () => void;
  onLifecycle(listener: (event: GameLifecycleEvent) => void): () => void;

  /**
   * 提交整份新状态。SDK 自动填 `authorityId` / `authorityEpoch` /
   * `baseRevision`（默认取 `context.revision`），成功后更新 `context.revision`。
   */
  commitState<T = unknown>(
    update: GameStateUpdate<T>,
  ): Promise<GameCommitResult>;
  /** 发布一条非状态事件（类型必须在 manifest.events 声明）。 */
  publishEvent<T = unknown>(
    type: string,
    payload?: T,
  ): Promise<{ accepted: number }>;
  /** 发布只影响画面的渲染态；不落盘、不产生 revision。 */
  publishRenderState<T = unknown>(state: T): Promise<{ revision: number }>;
  /** 回传命令结果；`error` 允许直接传错误体，SDK 只取 code。 */
  commandResult(input: GameCommandResultInput): Promise<void>;
  /** 首帧就绪后告知宿主，宿主据此进入 running 并开始 tick。 */
  reportReady(): Promise<void>;
  /** 上报错误；`scope` 缺省用当前角色。 */
  reportError(input: {
    code: string;
    message: string;
    scope?: string;
  }): Promise<void>;
  /** 退订全部监听、拒绝未完成请求；之后所有调用返回 `disposed`。 */
  destroy(): void;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 连接 Authority 宿主壳。必须在游戏 authority iframe 内调用；
 * 浏览器顶层页面会抛 `not-connected`，便于本地调试时快速发现。
 */
export function connectLullGame(
  options: ConnectLullGameOptions = {},
): Promise<LullGameClient> {
  return createLullGameClient(options);
}

/** 创建一个独立连接（不走单例）。测试与多实例页面可以直接使用。 */
export function createLullGameClient(
  options: ConnectLullGameOptions = {},
): Promise<LullGameClient> {
  return new Promise<LullGameClient>((resolve, reject) => {
    let transport: GameTransport;
    try {
      transport = options.transport ?? defaultTransport();
    } catch (error) {
      reject(error);
      return;
    }

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : DEFAULT_INIT_TIMEOUT_MS;
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Number(options.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;

    const snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
    const eventListeners = new Map<string, Set<(event: GameEvent) => void>>();
    const anyEventListeners = new Set<(event: GameEvent) => void>();
    const commandListeners = new Map<
      string,
      Set<(command: GameCommand) => void>
    >();
    const anyCommandListeners = new Set<(command: GameCommand) => void>();
    const tickListeners = new Set<(tick: GameTick) => void>();
    const lifecycleListeners = new Set<(event: GameLifecycleEvent) => void>();

    let init: GameInitMessage | null = null;
    let currentSnapshot: GameSnapshot | null = null;
    let disposed = false;
    let settled = false;
    let sequence = 0;
    let stopListening: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Map<number, PendingEntry>();

    const clearTimer = (): void => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    };

    const cleanup = (): void => {
      clearTimer();
      stopListening?.();
      stopListening = null;
    };

    const rejectPending = (reason: LullGameError): void => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(reason);
      }
      pending.clear();
    };

    const requireContext = (): GameContext => {
      if (!init) {
        throw new LullGameError("not-connected", "尚未收到宿主 init。");
      }
      return init.context;
    };

    const assertActive = (): void => {
      if (disposed) {
        throw new LullGameError("disposed", "客户端已销毁。");
      }
      if (!init) {
        throw new LullGameError("not-connected", "尚未收到宿主 init。");
      }
    };

    const syncContext = (next: {
      revision: number;
      authorityEpoch: number;
      simulationTimeMs: number;
    }): void => {
      if (!init) return;
      init.context.revision = next.revision;
      init.context.authorityEpoch = next.authorityEpoch;
      init.context.simulationTimeMs = next.simulationTimeMs;
    };

    const emitEvent = (event: GameEvent): void => {
      for (const listener of [
        ...(eventListeners.get(event.type) ?? []),
        ...anyEventListeners,
      ]) {
        listener(event);
      }
    };

    const emitCommand = (command: GameCommand): void => {
      for (const listener of [
        ...(commandListeners.get(command.type) ?? []),
        ...anyCommandListeners,
      ]) {
        listener(command);
      }
    };

    function request<M extends GameBridgeMethod>(
      method: M,
      params: GameBridgeParams<M>,
    ): Promise<GameBridgeResult<M>> {
      if (disposed) {
        return Promise.reject(new LullGameError("disposed", "客户端已销毁。"));
      }
      if (!init) {
        return Promise.reject(
          new LullGameError("not-connected", "尚未收到宿主 init。"),
        );
      }
      const id = ++sequence;
      return new Promise<GameBridgeResult<M>>((resolve, reject) => {
        const entryTimer = setTimeout(() => {
          pending.delete(id);
          reject(
            new LullGameError(
              "request-timeout",
              `宿主未在 ${requestTimeoutMs}ms 内响应 ${method}。`,
            ),
          );
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as GameBridgeResult<M>),
          reject,
          timer: entryTimer,
        });
        transport.post({
          v: GAME_PROTOCOL,
          type: "request",
          id,
          method,
          params,
        });
      });
    }

    const client: LullGameClient = {
      get context() {
        return requireContext();
      },
      get snapshot() {
        return currentSnapshot;
      },

      async getSnapshot<T = unknown>() {
        assertActive();
        const result = await request("snapshot.get", {});
        if (result === null) {
          currentSnapshot = null;
          return null;
        }
        if (!isGameSnapshot<T>(result)) {
          throw new LullGameError(
            "host-error",
            "snapshot.get 返回了非法快照。",
          );
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
        if (type === "*") {
          const wrapped = listener as (event: GameEvent) => void;
          anyEventListeners.add(wrapped);
          return () => {
            anyEventListeners.delete(wrapped);
          };
        }
        const wrapped = listener as (event: GameEvent) => void;
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

      onCommand(type, listener) {
        assertActive();
        if (type === "*") {
          const wrapped = listener as (command: GameCommand) => void;
          anyCommandListeners.add(wrapped);
          return () => {
            anyCommandListeners.delete(wrapped);
          };
        }
        const wrapped = listener as (command: GameCommand) => void;
        let listeners = commandListeners.get(type);
        if (!listeners) {
          listeners = new Set();
          commandListeners.set(type, listeners);
        }
        listeners.add(wrapped);
        return () => {
          listeners.delete(wrapped);
        };
      },

      onTick(listener) {
        assertActive();
        tickListeners.add(listener);
        return () => {
          tickListeners.delete(listener);
        };
      },

      onLifecycle(listener) {
        assertActive();
        lifecycleListeners.add(listener);
        return () => {
          lifecycleListeners.delete(listener);
        };
      },

      async commitState<T = unknown>(update: GameStateUpdate<T>) {
        assertActive();
        const context = requireContext();
        const simulationTimeMs =
          update.simulationTimeMs ?? context.simulationTimeMs;
        const params: GameStateCommitRequest = {
          authorityId: context.authorityId ?? "",
          authorityEpoch: context.authorityEpoch,
          baseRevision: update.baseRevision ?? context.revision,
          simulationTimeMs,
          state: update.state,
          ...(update.events ? { events: update.events } : {}),
          ...(update.renderState !== undefined
            ? { renderState: update.renderState }
            : {}),
        };
        const result = await request("state.commit", params);
        if (!isGameCommitResult(result)) {
          throw new LullGameError(
            "host-error",
            "state.commit 返回了非法结果。",
          );
        }
        if (result.ok) {
          context.revision = result.revision;
          context.simulationTimeMs = simulationTimeMs;
        }
        return result;
      },

      async publishEvent<T = unknown>(type: string, payload?: T) {
        assertActive();
        return request("event.publish", {
          events: [{ type, payload }],
        });
      },

      async publishRenderState<T = unknown>(state: T) {
        assertActive();
        return request("render.publish", {
          revision: requireContext().revision,
          state,
        });
      },

      async commandResult(input: GameCommandResultInput) {
        assertActive();
        await request("command.result", {
          requestId: input.requestId,
          ok: input.ok,
          result: input.result,
          error:
            typeof input.error === "string" ? input.error : input.error?.code,
          revision: input.revision,
        });
      },

      async reportReady() {
        assertActive();
        await request("ready", {});
      },

      async reportError(input) {
        assertActive();
        await request("error.report", {
          scope: input.scope ?? requireContext().role,
          code: input.code,
          message: input.message,
        });
      },

      destroy() {
        if (disposed) return;
        disposed = true;
        cleanup();
        rejectPending(new LullGameError("disposed", "客户端已销毁。"));
        snapshotListeners.clear();
        eventListeners.clear();
        anyEventListeners.clear();
        commandListeners.clear();
        anyCommandListeners.clear();
        tickListeners.clear();
        lifecycleListeners.clear();
      },
    };

    const handleMessage = (message: GameHostMessage): void => {
      if (disposed) return;

      switch (message.type) {
        case "init-error": {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new LullGameError(
              "host-error",
              message.error.message,
              message.error,
            ),
          );
          return;
        }
        case "init": {
          if (settled) return;
          if (message.context.hostApi > GAME_HOST_API) {
            settled = true;
            cleanup();
            reject(
              new LullGameError(
                "bad-init",
                `宿主 API 版本 ${message.context.hostApi} 高于 SDK 支持的 ${GAME_HOST_API}。`,
              ),
            );
            return;
          }
          init = message;
          currentSnapshot = message.snapshot;
          settled = true;
          clearTimer();
          resolve(client);
          return;
        }
        case "snapshot": {
          currentSnapshot = message.snapshot;
          syncContext(message.snapshot);
          for (const listener of [...snapshotListeners]) {
            listener(message.snapshot);
          }
          return;
        }
        case "command": {
          emitCommand(message.command);
          return;
        }
        case "tick": {
          for (const listener of [...tickListeners]) listener(message.tick);
          return;
        }
        case "lifecycle": {
          if (!init) return;
          init.context.authorityEpoch = message.event.authorityEpoch;
          init.context.revision = message.event.revision;
          for (const listener of [...lifecycleListeners]) {
            listener(message.event);
          }
          return;
        }
        case "event": {
          emitEvent(message.event);
          return;
        }
        case "response": {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.ok) {
            entry.resolve(message.result);
          } else {
            const body = message.error;
            entry.reject(
              new LullGameError(
                "host-error",
                body?.message ?? body?.code ?? "宿主请求失败。",
                body,
              ),
            );
          }
          return;
        }
      }
    };

    stopListening = transport.listen((message) => {
      if (!isGameHostMessage(message)) return;
      handleMessage(message);
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new LullGameError(
          "init-timeout",
          `宿主未在 ${timeoutMs}ms 内发送 game init。`,
        ),
      );
    }, timeoutMs);

    transport.post({ v: GAME_PROTOCOL, type: "ready" });
  });
}

function defaultTransport(): GameTransport {
  if (typeof window === "undefined" || window.parent === window) {
    throw new LullGameError(
      "not-connected",
      "当前页面不在 Lull 游戏 iframe 中；请从宿主运行，或注入自定义 transport。",
    );
  }
  return createWindowGameTransport(window.parent);
}
