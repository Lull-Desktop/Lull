"use client";

/**
 * 游戏自带渲染入口（`game.json.entry.replica`）的通用宿主。
 *
 * 与场景绑定的区别：这里不经过 Scene 目录、不要求场景 manifest，只把游戏包
 * 里的 replica 页面装进沙箱 iframe，并复用同一套只读 `game.*` 桥。
 *
 * 安全边界与外部场景一致：
 * - `sandbox="allow-scripts"`：没有 same-origin 与持久存储；
 * - WebView2 可能向子帧注入 Tauri 初始化脚本，真正的边界是窗口 ACL、顶层
 *   帧 token 与宿主二次校验，不能宣称 iframe 绝对调不到 IPC；
 * - 只接受 `event.source === iframe.contentWindow` 的消息；
 * - 资源协议按包下发 nonce CSP，HTML 之外的路径由 `lullgame://` 只读服务。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGameReplica } from "@/games/bridge/use-game-replica";
import type { GameReplicaEntry } from "@/lib/games";
import { m } from "@/paraglide/messages";
import {
  isSceneGamePluginMessage,
  SCENE_READY_TIMEOUT_MS,
} from "@/scenes/scene-bridge";
import type { SceneFrame } from "@/sdk/scene";

type GameReplicaHostProps = {
  gameId: string;
  frame: SceneFrame;
  /** replica 完成 `game.ready` 后回调；壁纸页据此收起启动幕。 */
  onReady?: () => void;
};

function Notice({
  children,
  onReady,
}: {
  children: ReactNode;
  onReady?: () => void;
}) {
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    // 没有可挂载的 replica 时，提示本身就算“场景已就绪”，不能一直盖着启动幕。
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => readyRef.current?.());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  return (
    <div
      data-testid="game-replica-notice"
      className="flex h-full w-full items-center justify-center bg-[#07110f] px-6 text-center text-sm text-white/70"
    >
      {children}
    </div>
  );
}

function GameReplicaFrame({
  entry,
  gameId,
  frame,
  onReady,
}: GameReplicaHostProps & { entry: GameReplicaEntry & { entryUrl: string } }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const { handleSceneGameMessage, resetForReload } = useGameReplica({
    gameId,
    sceneId: null,
    frame,
    iframeRef,
  });

  const handleLoad = useCallback((): void => {
    // iframe 重新加载后旧页面的 ready 失效；新页面会重新发 game.ready。
    readyRef.current = false;
    resetForReload();
  }, [resetForReload]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onMessage = (event: MessageEvent): void => {
      // opaque origin 下 event.origin 是 "null"，只能靠 source 校验。
      if (event.source !== iframe.contentWindow) return;
      if (!isSceneGamePluginMessage(event.data)) return;
      if (event.data.type === "game.ready") {
        readyRef.current = true;
        onReadyRef.current?.();
      }
      handleSceneGameMessage(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleSceneGameMessage]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (readyRef.current) return;
      console.warn(
        `[game:${entry.gameId}] replica 未在 ${SCENE_READY_TIMEOUT_MS / 1000}s 内响应 game.ready；` +
          "请确认渲染入口使用了 @lull/game-sdk。",
      );
    }, SCENE_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [entry.gameId]);

  return (
    <iframe
      ref={iframeRef}
      data-testid="game-replica"
      data-runtime="game-replica"
      title={entry.name}
      src={entry.entryUrl}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0"
      onLoad={handleLoad}
    />
  );
}

export function GameReplicaHost({
  gameId,
  frame,
  onReady,
}: GameReplicaHostProps) {
  const [entry, setEntry] = useState<GameReplicaEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEntry(null);
    setError(null);
    invoke<GameReplicaEntry>("game_replica_entry", { gameId })
      .then((value) => {
        if (live) setEntry(value);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [gameId]);

  if (error) {
    return (
      <Notice onReady={onReady}>
        <span data-testid="game-replica-error">
          {m.game_wallpaper_error({ reason: error })}
        </span>
      </Notice>
    );
  }

  if (!entry) {
    return <Notice>{m.game_wallpaper_loading()}</Notice>;
  }

  if (!entry.enabled) {
    return (
      <Notice onReady={onReady}>
        <span data-testid="game-replica-disabled">
          {m.game_wallpaper_disabled({ name: entry.name })}
        </span>
      </Notice>
    );
  }

  if (!entry.entryUrl) {
    return (
      <Notice onReady={onReady}>
        <span data-testid="game-replica-missing">
          {m.game_wallpaper_missing({ name: entry.name })}
        </span>
      </Notice>
    );
  }

  return (
    <GameReplicaFrame
      key={entry.entryUrl}
      entry={{ ...entry, entryUrl: entry.entryUrl }}
      gameId={gameId}
      frame={frame}
      onReady={onReady}
    />
  );
}
