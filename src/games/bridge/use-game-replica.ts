"use client";

/**
 * 壁纸窗内的游戏 Replica 桥：把 Rust 的 game:snapshot/event/render/lifecycle
 * 转发给场景 iframe，并把场景的 game.ready / requestSnapshot / reportError
 * 转成宿主命令。只读：这里没有任何提交状态或发命令的入口。
 *
 * 只允许在壁纸窗顶层帧使用（token 由 Rust 注入到顶层帧，沙箱 iframe 读不到）。
 */
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  isGameEventForGame,
  listenGameEvent,
} from "@/games/bridge/game-events";
import type {
  GameConnectResult,
  GameContext,
  GameEvent,
  GameInstanceView,
  GameLifecycleEvent,
  GameRenderContext,
  GameRenderState,
  GameSnapshot,
} from "@/lib/games";
import {
  isSceneGamePluginMessage,
  sceneGameEventMessage,
  sceneGameInitMessage,
  sceneGameLifecycleMessage,
  sceneGameRenderMessage,
  sceneGameSnapshotMessage,
  sceneGameUnavailableMessage,
} from "@/scenes/scene-bridge";
import type { SceneFrame } from "@/sdk/scene";

type UseGameReplicaOptions = {
  gameId: string | null;
  /** 场景绑定时是场景 id；壁纸直接挂载游戏 replica 时为 null。 */
  sceneId: string | null;
  frame: SceneFrame;
  iframeRef: RefObject<HTMLIFrameElement | null>;
};

function renderContextFor(
  frame: SceneFrame,
  iframe: HTMLIFrameElement | null,
): GameRenderContext {
  const view = frame.view ?? {
    x: 0,
    y: 0,
    w: frame.viewport.w,
    h: frame.viewport.h,
  };
  const canvas = frame.canvas ?? view;
  // span 下 iframe 是整块共享画布，不是壁纸窗口：必须按 iframe 的实际 CSS 尺寸
  // 建立 viewport，否则 Canvas 适配器会按单屏宽度分配 backing store。
  const measuredW = iframe ? Math.round(iframe.clientWidth) : 0;
  const measuredH = iframe ? Math.round(iframe.clientHeight) : 0;
  const width = measuredW > 0 ? measuredW : frame.viewport.w;
  const height = measuredH > 0 ? measuredH : frame.viewport.h;
  return {
    // displayId 由 Rust 按壁纸窗口 label 解析，这里只占位。
    protocol: 1,
    displayId: "",
    mode: frame.mode === "span" ? "span" : "mirror",
    canvas,
    view,
    viewport: {
      width,
      height,
      dpr: frame.dpr,
    },
  };
}

export function useGameReplica({
  gameId,
  sceneId,
  frame,
  iframeRef,
}: UseGameReplicaOptions): {
  handleSceneGameMessage: (value: unknown) => boolean;
  resetForReload: () => void;
} {
  const contextRef = useRef<GameContext | null>(null);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const readyRef = useRef(false);
  const connectingRef = useRef(false);
  const autoStartTriedRef = useRef(false);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const token =
    typeof window === "undefined" ? undefined : window.__LULL_GAME_TOKEN__;

  const post = useCallback(
    (message: unknown): void => {
      iframeRef.current?.contentWindow?.postMessage(message, "*");
    },
    [iframeRef],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接时读取 iframe 当前尺寸，ref 变化不应重建 connect
  const connect = useCallback(async (): Promise<void> => {
    if (!gameId || !token || !isDesktopWindow() || connectingRef.current) {
      return;
    }
    connectingRef.current = true;
    try {
      // 只尝试一次：用户手动停止后，场景不应每 3s 把它重新拉起来。
      if (!autoStartTriedRef.current) {
        autoStartTriedRef.current = true;
        try {
          await invoke<GameInstanceView | null>("game_auto_start", { gameId });
        } catch (reason) {
          // 自动启动失败（上限/包损坏）继续走 connect，由宿主回 unavailable；
          // 控制台保留原因，避免设置页只看到“未运行”而无从排查。
          console.warn(`[game:${gameId}] 自动启动失败`, reason);
        }
      }
      const result = await invoke<GameConnectResult>("game_connect", {
        request: {
          gameId,
          sceneId,
          render: renderContextFor(frameRef.current, iframeRef.current),
        },
        token,
      });
      contextRef.current = result.context ?? null;
      if (!result.context) {
        if (readyRef.current) {
          post(sceneGameUnavailableMessage("game.instance_not_running"));
        }
        return;
      }
      // 首份快照可能在监听器注册前就被投递；缺失时主动取一次。
      if (!snapshotRef.current && token) {
        try {
          const snapshot = await invoke<GameSnapshot | null>(
            "game_snapshot_get",
            { token },
          );
          if (snapshot) snapshotRef.current = snapshot;
        } catch {
          // 取不到就退回 game.init(snapshot: null)，场景等待后续快照。
        }
      }
      // 不按 readyRef 门控：iframe 的 load 事件会在 script 的 game.ready 之后触发，
      // 重连期间 readyRef 可能被重置；消息丢了由下一次 game.ready 再补。
      post(sceneGameInitMessage(result.context, snapshotRef.current));
    } catch (reason) {
      console.warn(`[game:${gameId}] connect failed`, reason);
      contextRef.current = null;
      if (readyRef.current) {
        post(
          sceneGameUnavailableMessage(
            reason instanceof Error ? reason.message : String(reason),
          ),
        );
      }
    } finally {
      connectingRef.current = false;
    }
  }, [gameId, post, sceneId, token]);

  // Tauri 定向事件 → 场景 iframe。连接前到达的快照先缓存，由 game.init 带上。
  useEffect(() => {
    if (!gameId) return;
    const stops: Array<() => void> = [];
    let disposed = false;
    const register = <T>(
      event: string,
      handler: (payload: T) => void,
    ): void => {
      void listenGameEvent<T>(event, (payload) => {
        if (!disposed) handler(payload.payload);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stops.push(unlisten);
        })
        .catch(() => {
          // 浏览器预览 / 测试环境没有 Tauri 事件系统。
        });
    };

    register<GameSnapshot>("game:snapshot", (snapshot) => {
      if (!isGameEventForGame(snapshot, gameId)) return;
      snapshotRef.current = snapshot;
      if (readyRef.current) post(sceneGameSnapshotMessage(snapshot));
    });
    register<GameEvent>("game:event", (event) => {
      if (!isGameEventForGame(event, gameId)) return;
      if (readyRef.current) post(sceneGameEventMessage(event));
    });
    register<GameRenderState>("game:render", (renderState) => {
      if (!isGameEventForGame(renderState, gameId)) return;
      if (readyRef.current) post(sceneGameRenderMessage(renderState));
    });
    register<GameLifecycleEvent>("game:lifecycle", (event) => {
      if (!isGameEventForGame(event, gameId)) return;
      if (event.state === "stopped" || event.state === "failed") {
        contextRef.current = null;
        snapshotRef.current = null;
      }
      if (readyRef.current) post(sceneGameLifecycleMessage(event));
    });

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [gameId, post]);

  // 卸载/切换场景时注销 replica；Rust 只删副本，不停止游戏实例。
  useEffect(() => {
    return () => {
      if (!token || !contextRef.current) return;
      contextRef.current = null;
      readyRef.current = false;
      snapshotRef.current = null;
      void invoke("game_detach", { token }).catch(() => {});
    };
  }, [token]);

  // 场景已 ready 但没有实例时低频重试：游戏在设置页启动后无需重载壁纸即可 attach。
  useEffect(() => {
    if (!gameId) return;
    const timer = window.setInterval(() => {
      if (readyRef.current && !contextRef.current) void connect();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [connect, gameId]);

  const resetForReload = useCallback((): void => {
    // 只失效 ready 握手；不要清 context/snapshot：iframe 的 load 在 script 的
    // game.ready 之后触发，清空会让刚完成的 connect 结果不可用。
    readyRef.current = false;
  }, []);

  // 显示模式/窗口尺寸/DPI 变化时重新 attach，把新的渲染几何推给场景。
  // 用字符串键避免 SceneFrame 每次渲染都是新对象导致 effect 抖动。
  const geometryKey = [
    frame.mode,
    frame.canvas?.x ?? "",
    frame.canvas?.y ?? "",
    frame.canvas?.w ?? "",
    frame.canvas?.h ?? "",
    frame.view?.x ?? "",
    frame.view?.y ?? "",
    frame.view?.w ?? "",
    frame.view?.h ?? "",
    frame.viewport.w,
    frame.viewport.h,
    frame.dpr,
  ].join(":");
  useEffect(() => {
    if (!readyRef.current || geometryKey.length === 0) return;
    const timer = window.setTimeout(() => {
      void connect();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [connect, geometryKey]);

  const handleSceneGameMessage = useCallback(
    (value: unknown): boolean => {
      if (!isSceneGamePluginMessage(value)) return false;
      switch (value.type) {
        case "game.ready":
          readyRef.current = true;
          if (contextRef.current) {
            post(sceneGameInitMessage(contextRef.current, snapshotRef.current));
          }
          void connect();
          return true;
        case "game.requestSnapshot":
          if (token) {
            void invoke<GameSnapshot | null>("game_snapshot_get", { token })
              .then((snapshot) => {
                if (!snapshot) return;
                snapshotRef.current = snapshot;
                post(sceneGameSnapshotMessage(snapshot));
              })
              .catch(() => {});
          }
          return true;
        case "game.reportError":
          if (token) {
            void invoke("game_report_error", {
              request: {
                scope: "scene",
                code: value.code,
                message: value.message,
              },
              token,
            }).catch(() => {});
          }
          return true;
        case "game.detach":
          return true;
      }
    },
    [connect, post, token],
  );

  return { handleSceneGameMessage, resetForReload };
}
