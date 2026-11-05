"use client";

/**
 * 壁纸宿主：直接渲染游戏包自带的 `entry.replica`（不依赖 Scene 目录）。
 *
 * 场景绑定的 `SceneHost` 仍然保留；两者共用同一套 `game.*` 只读桥与几何换算。
 */
import { useCallback, useEffect, useState } from "react";
import {
  canvasTransform,
  resolveSync,
  type WallpaperParams,
} from "@/core/wallpaper/params";
import { GameReplicaHost } from "@/games/replica/game-replica-host";
import type { SceneFrame } from "@/sdk/scene";

type GameHostProps = {
  params: WallpaperParams;
  onReady?: () => void;
};

type Environment = {
  viewportW: number;
  viewportH: number;
  dpr: number;
  reducedMotion: boolean;
};

function readEnvironment(): Environment {
  if (typeof window === "undefined") {
    return { viewportW: 0, viewportH: 0, dpr: 1, reducedMotion: false };
  }
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    reducedMotion:
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  };
}

export function GameHost({ params, onReady }: GameHostProps) {
  const [environment, setEnvironment] = useState(readEnvironment);
  const [epochMs] = useState(() => Date.now());
  const gameId = params.game;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = (): void => setEnvironment(readEnvironment());
    window.addEventListener("resize", update);
    media?.addEventListener?.("change", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      media?.removeEventListener?.("change", update);
    };
  }, []);

  const handleReady = useCallback(() => onReady?.(), [onReady]);

  if (!gameId) return null;

  const useCanvas =
    params.mode === "span" && params.canvas !== null && params.view !== null;
  const frame: SceneFrame = {
    mode: params.mode,
    layout: useCanvas ? "canvas" : "viewport",
    sync: {
      enabled: resolveSync(params.mode, params.sync),
      epochMs,
    },
    viewport: {
      w: environment.viewportW,
      h: environment.viewportH,
      dpr: environment.dpr,
    },
    canvas: useCanvas ? params.canvas : null,
    view: params.view,
    dpr: environment.dpr,
    params: {},
    reducedMotion: environment.reducedMotion,
    performance: null,
  };

  const transform =
    frame.layout === "canvas" && frame.canvas && frame.view
      ? canvasTransform(frame.canvas, frame.view, frame.dpr)
      : null;

  return (
    <div
      className="wallpaper-scene-enter absolute inset-0 overflow-hidden"
      style={{ backgroundColor: "#07110f" }}
      data-testid="game-wallpaper"
    >
      <div
        data-testid={transform ? "canvas-container" : undefined}
        className="absolute origin-top-left"
        style={
          transform
            ? {
                width: transform.width,
                height: transform.height,
                left: transform.left,
                top: transform.top,
              }
            : { inset: 0 }
        }
      >
        <GameReplicaHost gameId={gameId} frame={frame} onReady={handleReady} />
      </div>
    </div>
  );
}
