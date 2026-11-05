/**
 * 包内控制器窗口的宿主壳（`/game-controller`）。
 *
 * 页面本身不承载业务 UI：Rust 建窗时注入 `__LULL_GAME_CONTROLLER__`，这里把
 * 游戏包自带页面放进不透明源 iframe，并通过 postMessage 把请求翻译成宿主命令。
 * 窗口 token 只存在于本壳与 Rust 之间，不会下发给 iframe。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isGameEventForGame,
  listenGameEvent,
} from "@/games/bridge/game-events";
import {
  type GameConnectResult,
  type GameContext,
  type GameLimits,
  type GameSnapshot,
  toGameErrorBody,
} from "@/lib/games";

/** Rust 建窗时注入的控制器上下文；不在浏览器预览里伪造。 */
export type GameControllerContext = {
  protocol: 1;
  hostApi: 1;
  role: "controller";
  gameId: string;
  instanceId: string;
  controllerId: string;
  label?: string | null;
  entryUrl: string;
  token: string;
  limits: GameLimits;
  locale: string;
  allowedCommands?: string[] | null;
  window: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    resizable: boolean;
    alwaysOnTop: boolean;
  };
};

type BridgeMessage = {
  v?: number;
  type?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

type CodedError = Error & { code: string };

declare global {
  interface Window {
    __LULL_GAME_CONTROLLER__?: GameControllerContext;
  }
}

const PROTOCOL_VERSION = 1;
/** iframe ready 可能早于壳监听器；未连接时低频重试握手。 */
const RETRY_INTERVAL_MS = 1_500;

export function isGameControllerContext(
  value: unknown,
): value is GameControllerContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === 1 &&
    record.hostApi === 1 &&
    record.role === "controller" &&
    typeof record.gameId === "string" &&
    typeof record.instanceId === "string" &&
    typeof record.controllerId === "string" &&
    typeof record.entryUrl === "string" &&
    isHttpUrl(record.entryUrl) &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.limits === "object" &&
    record.limits !== null &&
    typeof record.locale === "string" &&
    typeof record.window === "object" &&
    record.window !== null
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 控制器窗口身份：游戏 + 实例短号，多游戏同时打开时可直接区分。 */
export function controllerIdentityLabel(
  context: Pick<
    GameControllerContext,
    "gameId" | "controllerId" | "instanceId"
  >,
): string {
  const instance =
    context.instanceId.length > 12
      ? `${context.instanceId.slice(0, 8)}…${context.instanceId.slice(-4)}`
      : context.instanceId;
  return `${context.gameId} · ${instance}`;
}

function gameBridgeError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

/** 白名单转发：防止未来 Rust 上下文误带 token 或内部字段。 */
function publicContext(context: GameContext): GameContext {
  return {
    protocol: context.protocol,
    hostApi: context.hostApi,
    role: context.role,
    gameId: context.gameId,
    instanceId: context.instanceId,
    authorityId: context.authorityId,
    authorityEpoch: context.authorityEpoch,
    revision: context.revision,
    simulationTimeMs: context.simulationTimeMs,
    render: context.render,
    controllerId: context.controllerId,
    limits: context.limits,
    locale: context.locale,
  };
}

export function GameControllerShell() {
  const [context, setContext] = useState<GameControllerContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initStateRef = useRef<"idle" | "pending" | "ready">("idle");
  const connectedRef = useRef(false);

  useEffect(() => {
    const injected = window.__LULL_GAME_CONTROLLER__;
    if (isGameControllerContext(injected)) {
      setContext(injected);
      // 宿主建窗时是 visible(false)：壳页加载后显示，避免白屏闪烁。
      const current = getCurrentWindow();
      void current.show().catch(() => {});
      void current.setFocus().catch(() => {});
      return;
    }
    const message = "缺少有效的控制器上下文（__LULL_GAME_CONTROLLER__）";
    console.error("[game-controller]", message);
    setError(message);
  }, []);

  const send = useCallback((message: Record<string, unknown>): void => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const initialize = useCallback(async (): Promise<void> => {
    if (!context || initStateRef.current !== "idle") return;
    initStateRef.current = "pending";
    try {
      const connection = await invoke<GameConnectResult>("game_connect", {
        token: context.token,
      });
      if (!connection?.context) {
        throw gameBridgeError(
          "game.controller_not_active",
          "游戏未运行：控制器只在游戏运行中可用。",
        );
      }
      connectedRef.current = true;
      setConnected(true);
      const snapshot = await invoke<GameSnapshot | null>("game_snapshot_get", {
        token: context.token,
      });
      initStateRef.current = "ready";
      send({
        v: PROTOCOL_VERSION,
        type: "init",
        context: publicContext(connection.context),
        snapshot: snapshot ?? null,
      });
    } catch (reason) {
      const body = toGameErrorBody(reason);
      initStateRef.current = "idle";
      console.error("[game-controller] 连接游戏失败", body.code, body.message);
      send({
        v: PROTOCOL_VERSION,
        type: "init-error",
        error: { code: body.code, message: body.message },
      });
    }
  }, [context, send]);

  const handleRequest = useCallback(
    async (message: BridgeMessage): Promise<unknown> => {
      if (!context) {
        throw gameBridgeError("game.not_connected", "控制器尚未连接游戏");
      }
      const params = message.params ?? {};
      switch (message.method) {
        case "snapshot.get":
          return invoke<GameSnapshot | null>("game_snapshot_get", {
            token: context.token,
          });
        case "command.send":
          return invoke("game_command_send", {
            request: params,
            token: context.token,
          });
        case "error.report":
          return invoke("game_report_error", {
            request: params,
            token: context.token,
          });
        case "disconnect":
          await invoke("game_detach", { token: context.token });
          return { disconnected: true };
        default:
          throw gameBridgeError(
            "bridge.unsupported_method",
            `不支持的桥方法：${message.method ?? "unknown"}`,
          );
      }
    },
    [context],
  );

  // Tauri 定向事件 → iframe；stopped/failed 后标记断开并解除参与者。
  useEffect(() => {
    if (!context) return;
    const subscriptions: Array<
      [string, (payload: unknown) => Record<string, unknown>]
    > = [
      [
        "game:snapshot",
        (payload) => ({
          v: PROTOCOL_VERSION,
          type: "snapshot",
          snapshot: payload,
        }),
      ],
      [
        "game:event",
        (payload) => ({
          v: PROTOCOL_VERSION,
          type: "event",
          event: payload,
        }),
      ],
      [
        "game:lifecycle",
        (payload) => ({
          v: PROTOCOL_VERSION,
          type: "lifecycle",
          event: payload,
        }),
      ],
    ];
    const stops: Array<() => void> = [];
    let disposed = false;
    for (const [event, forward] of subscriptions) {
      void listenGameEvent<unknown>(event, (payload) => {
        if (!isGameEventForGame(payload.payload, context.gameId)) return;
        send(forward(payload.payload));
        if (event === "game:lifecycle") {
          const state = (payload.payload as { state?: unknown } | null)?.state;
          if (state === "stopped" || state === "failed") {
            connectedRef.current = false;
            setConnected(false);
            void invoke("game_detach", { token: context.token }).catch(
              () => {},
            );
          }
        }
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stops.push(unlisten);
        })
        .catch(() => {
          // 浏览器预览 / 单测没有 Tauri 事件系统。
        });
    }
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [context, send]);

  useEffect(() => {
    if (!context) return;
    const onMessage = (event: MessageEvent): void => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as BridgeMessage;
      if (message.v !== PROTOCOL_VERSION) return;

      if (message.type === "ready") {
        void initialize();
        return;
      }
      if (message.type !== "request") return;
      if (typeof message.id !== "number" && typeof message.id !== "string") {
        return;
      }
      const requestId = message.id;
      void handleRequest(message)
        .then((result) => {
          const response: Record<string, unknown> = {
            v: PROTOCOL_VERSION,
            type: "response",
            id: requestId,
            ok: true,
          };
          if (result !== undefined) response.result = result;
          send(response);
        })
        .catch((reason: unknown) => {
          const body = toGameErrorBody(reason);
          send({
            v: PROTOCOL_VERSION,
            type: "response",
            id: requestId,
            ok: false,
            error: { code: body.code, message: body.message },
          });
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [context, handleRequest, initialize, send]);

  // 兜底握手：iframe ready 可能在监听器注册前丢失。
  useEffect(() => {
    if (!context) return;
    const timer = window.setInterval(() => {
      if (!connectedRef.current) void initialize();
    }, RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [context, initialize]);

  // 窗口销毁 / 热重载时注销参与者。
  useEffect(() => {
    if (!context) return;
    const token = context.token;
    return () => {
      if (!connectedRef.current) return;
      try {
        void invoke("game_detach", { token }).catch(() => {});
      } catch {
        // 窗口正在销毁时 IPC 可能已关闭；尽力而为。
      }
    };
  }, [context]);

  const closeWindow = useCallback((): void => {
    void getCurrentWindow()
      .destroy()
      .catch(() => {});
  }, []);

  if (!context) {
    return error ? (
      <div
        className="fixed inset-0 grid place-items-center bg-[#f6f3ec] p-6 text-center text-sm text-[#8a3b34]"
        role="alert"
      >
        {error}
      </div>
    ) : null;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#f6f3ec] text-[#2b2a26]">
      <header
        data-tauri-drag-region="deep"
        className="flex h-9 shrink-0 items-center justify-between border-b border-[#d8d2c4] px-3 text-[11px]"
      >
        <span
          className="flex min-w-0 flex-1 flex-col leading-tight"
          data-tauri-drag-region="deep"
        >
          <span className="truncate font-medium">
            {context.label ?? context.controllerId}
          </span>
          <span
            className="truncate text-[10px] text-[#8a8578]"
            data-testid="game-controller-identity"
            title={`${context.gameId} · ${context.controllerId} · ${context.instanceId}`}
          >
            {controllerIdentityLabel(context)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[#8a8578]">
            {connected ? "已连接" : "未连接"}
          </span>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded hover:bg-[#e7e1d3]"
            aria-label="关闭控制器窗口"
            title="关闭控制器窗口"
            onClick={closeWindow}
          >
            ×
          </button>
        </span>
      </header>
      <iframe
        ref={iframeRef}
        className="min-h-0 w-full flex-1 border-0"
        src={context.entryUrl}
        title={`Lull 控制器 · ${context.controllerId}`}
        sandbox="allow-scripts"
        allow="autoplay"
        referrerPolicy="no-referrer"
        onLoad={() => {
          // 页面重载（开发态）后允许重新握手；首帧 ready 通常早于 load。
          initStateRef.current = "idle";
        }}
      />
    </div>
  );
}
