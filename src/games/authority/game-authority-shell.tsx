/**
 * 隐藏游戏权威窗口的宿主壳（`/game-authority`）。
 *
 * 页面本身不承载游戏 UI：Rust 在窗口创建时注入 `__LULL_GAME_AUTHORITY__`，
 * 这里只负责把不可信的游戏 authority 放进不透明源 iframe，并通过 postMessage
 * 把请求翻译成宿主命令。`authorityToken` 只存在于本壳与 Rust 之间，任何
 * 发给 iframe 的消息都不包含它。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GameCommitResult,
  type GameConnectResult,
  type GameContext,
  type GameLimits,
  type GameSnapshot,
  toGameErrorBody,
} from "@/lib/games";

/** Rust 建窗时注入的权威上下文；不在浏览器预览里伪造。 */
export type GameAuthorityContext = {
  protocol: 1;
  hostApi: 1;
  gameId: string;
  instanceId: string;
  authorityId: string;
  authorityEpoch: number;
  role: "authority";
  mode: "host-tick" | "self-loop";
  entryUrl: string;
  token: string;
  limits: GameLimits;
  locale: string;
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
    __LULL_GAME_AUTHORITY__?: GameAuthorityContext;
  }
}

const PROTOCOL_VERSION = 1;
/** 与 Rust 侧租约 TTL（10s）配合；缺省 2s 续租一次。 */
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_MAX_FAILURES = 3;

export function isGameAuthorityContext(
  value: unknown,
): value is GameAuthorityContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === 1 &&
    record.hostApi === 1 &&
    typeof record.gameId === "string" &&
    typeof record.instanceId === "string" &&
    typeof record.authorityId === "string" &&
    typeof record.authorityEpoch === "number" &&
    record.role === "authority" &&
    (record.mode === "host-tick" || record.mode === "self-loop") &&
    typeof record.entryUrl === "string" &&
    isHttpUrl(record.entryUrl) &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.limits === "object" &&
    record.limits !== null &&
    typeof record.locale === "string"
  );
}

/** iframe 只加载 http(s) 入口；注入异常时不把 javascript:/data: 交给浏览器。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function gameBridgeError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

/**
 * 明确白名单转发上下文字段。
 *
 * 即使未来 Rust 的 `GameContext` 误带 token 或其它内部字段，这里也不会把它
 * post 给不可信的 iframe。
 */
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
    limits: context.limits,
    locale: context.locale,
  };
}

export function GameAuthorityShell() {
  const [context, setContext] = useState<GameAuthorityContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initStateRef = useRef<"idle" | "pending" | "ready">("idle");
  const connectedRef = useRef(false);

  useEffect(() => {
    const injected = window.__LULL_GAME_AUTHORITY__;
    if (isGameAuthorityContext(injected)) {
      setContext(injected);
      return;
    }
    const message = "缺少有效的游戏权威上下文（__LULL_GAME_AUTHORITY__）";
    // 隐藏窗口没有用户可看的界面；日志里也绝不输出 token。
    console.error("[game-authority]", message);
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
        const body = {
          code: "game.connect_failed",
          message: "游戏权威连接未返回上下文",
        };
        console.error("[game-authority]", body.code, body.message);
        initStateRef.current = "idle";
        send({
          v: PROTOCOL_VERSION,
          type: "init-error",
          error: body,
        });
        return;
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
      console.error("[game-authority] 连接游戏失败", body.code, body.message);
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
        throw gameBridgeError("game.not_connected", "游戏权威尚未连接");
      }
      const params = message.params ?? {};
      switch (message.method) {
        case "snapshot.get":
          return invoke<GameSnapshot | null>("game_snapshot_get", {
            token: context.token,
          });
        case "state.commit":
          return invoke<GameCommitResult>("game_state_commit", {
            request: params,
            token: context.token,
          });
        case "event.publish":
          return invoke("game_event_publish", {
            events: params.events,
            token: context.token,
          });
        case "render.publish":
          return invoke("game_render_state_publish", {
            request: params,
            token: context.token,
          });
        case "command.result":
          return invoke("game_command_result", {
            request: params,
            token: context.token,
          });
        case "error.report":
          return invoke("game_report_error", {
            request: params,
            token: context.token,
          });
        case "ready":
          return invoke("game_ready", { token: context.token });
        default:
          throw gameBridgeError(
            "bridge.unsupported_method",
            `不支持的桥方法：${message.method ?? "unknown"}`,
          );
      }
    },
    [context],
  );

  // 租约续期：TTL 10s，每 2s 一次。连接成功后才开始发送。
  useEffect(() => {
    if (!context) return;
    let failures = 0;
    const tick = (): void => {
      if (!connectedRef.current) return;
      void invoke("game_heartbeat", { token: context.token })
        .then(() => {
          failures = 0;
        })
        .catch((reason: unknown) => {
          failures += 1;
          if (failures >= 3) {
            console.warn(
              "[game-authority] game_heartbeat 连续失败",
              toGameErrorBody(reason).code,
            );
          }
        });
    };
    const timer = window.setInterval(tick, 2000);
    tick();
    return () => window.clearInterval(timer);
  }, [context]);

  // Tauri 定向事件 → iframe。事件在 connect 之前到达也没有副作用：
  // iframe 尚未 ready，SDK 会以 init 里的首份快照为准。
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
        "game:command",
        (payload) => ({
          v: PROTOCOL_VERSION,
          type: "command",
          command: payload,
        }),
      ],
      [
        "game:tick",
        (payload) => ({
          v: PROTOCOL_VERSION,
          type: "tick",
          tick: payload,
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
      void listen<unknown>(event, (payload) => {
        send(forward(payload.payload));
        if (event === "game:lifecycle") {
          const state = (payload.payload as { state?: unknown } | null)?.state;
          if (state === "stopped") {
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

  // 兜底：iframe 的 ready 可能早于本壳的监听器（本地缓存页/开发态重载）。
  // 每 1.5s 检查一次，未连接就主动握手；已连接或已在握手时不会重复。
  useEffect(() => {
    if (!context) return;
    const timer = window.setInterval(() => {
      if (!connectedRef.current) void initialize();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [context, initialize]);

  // 连接成功后持续续租；心跳只走宿主 IPC，不转发给 iframe。
  // 连续失败达到上限后停止重试，避免窗口销毁/实例失败时刷日志。
  useEffect(() => {
    if (!context || !connected) return;
    const token = context.token;
    let failures = 0;
    let stopped = false;
    let timer: number | null = null;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) window.clearInterval(timer);
    };
    const fail = (reason: unknown): void => {
      if (stopped) return;
      failures += 1;
      const body = toGameErrorBody(reason);
      console.warn(
        "[game-authority] 心跳失败",
        `${failures}/${HEARTBEAT_MAX_FAILURES}`,
        body.code,
        body.message,
      );
      if (failures >= HEARTBEAT_MAX_FAILURES) stop();
    };
    timer = window.setInterval(() => {
      try {
        void invoke("game_heartbeat", { token })
          .then(() => {
            failures = 0;
          })
          .catch(fail);
      } catch (reason) {
        fail(reason);
      }
    }, HEARTBEAT_INTERVAL_MS);
    return () => stop();
  }, [connected, context]);

  // 窗口销毁 / 热重载时注销参与者；连接尚未建立时无需打扰 Rust。
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

  if (!context) {
    return error ? (
      <div
        className="fixed inset-0 grid place-items-center bg-black p-6 text-center text-sm text-red-300"
        role="alert"
      >
        {error}
      </div>
    ) : null;
  }

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-black">
      <iframe
        ref={iframeRef}
        className="h-full w-full border-0"
        src={context.entryUrl}
        title={`Lull 游戏权威 · ${context.gameId}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          // 页面重载（开发态 HMR）后重新等待 ready 握手；首帧的 ready 通常
          // 早于 load，此时重置只影响下一次重载。
          initStateRef.current = "idle";
        }}
      />
    </div>
  );
}
