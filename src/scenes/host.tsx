"use client";

/**
 * 场景宿主：根据 URL 参数选择内置场景组件或外部静态内容包。
 *
 * 外部内容包以 `sandbox=""` 的 iframe 加载：**不执行 JavaScript**、没有同源
 * 存储、没有 Tauri IPC。这是首版明确的安全边界；动态能力只在内置 React 场景中提供。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { canvasTransform, type WallpaperParams } from "@/core/wallpaper/params";
import { useSceneCatalog } from "@/hooks/use-scene-catalog";
import { ExternalScene } from "@/scenes/external-scene";
import { resolveSceneFrame, type SceneEnvironment } from "@/scenes/frame";
import { DEFAULT_SCENE_ID } from "@/scenes/registry";
import type { SceneCatalogEntry } from "@/sdk/scene";

type SceneHostProps = {
  params: WallpaperParams;
  /** 场景完成一次真实绘制后回调；壁纸页据此收起启动幕。 */
  onReady?: () => void;
};

type HostEnvironment = Omit<SceneEnvironment, "epochMs">;

function readEnvironment(): HostEnvironment {
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

export function SceneHost({ params, onReady }: SceneHostProps) {
  const { entries, loading } = useSceneCatalog();
  const [environment, setEnvironment] = useState(readEnvironment);
  // 外部场景通过 iframe 的 ready 消息回报；用"场景 id"作为键，切换场景后旧信号自动失效。
  const [externalReadyKey, setExternalReadyKey] = useState<string | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

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

  const requested = entries.find(
    (candidate) => candidate.manifest.id === params.scene,
  );
  const fallback =
    entries.find((candidate) => candidate.manifest.id === DEFAULT_SCENE_ID) ??
    entries[0];
  // 场景切换时重新捕获绝对时间锚点；同一场景的渲染/参数变化保持相位稳定。
  const clock = useRef({
    sceneId: requested?.manifest.id,
    epochMs: Date.now(),
  });
  if (clock.current.sceneId !== requested?.manifest.id) {
    clock.current = { sceneId: requested?.manifest.id, epochMs: Date.now() };
  }
  const epochMs = clock.current.epochMs;

  const candidates = [requested, fallback, ...entries].filter(
    (entry): entry is SceneCatalogEntry => entry !== undefined,
  );
  const uniqueCandidates = Array.from(new Set(candidates));
  const resolved = uniqueCandidates
    .map((entry) => ({
      entry,
      frame: resolveSceneFrame(entry, params, { ...environment, epochMs }),
    }))
    .find((candidate) => candidate.frame !== null);

  const sceneKey = resolved?.entry.manifest.id ?? null;
  // 目标场景已解析，或目录已加载完（确认只能回退）时，才算"可以揭幕"。
  // 目录还在加载且当前只是默认回退场景时先不揭幕，避免用户先看到竹影再切到目标场景。
  const sceneSettled =
    sceneKey !== null && (sceneKey === params.scene || !loading);

  const markExternalReady = useCallback(() => {
    if (sceneKey) setExternalReadyKey(sceneKey);
  }, [sceneKey]);

  useEffect(() => {
    if (!sceneSettled || !sceneKey) return;
    if (resolved?.entry.component) {
      // 内置 React 场景：两次 rAF 覆盖 commit → 浏览器首次绘制。
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => readyRef.current?.());
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    // iframe 场景：等 ExternalScene 的 ready 消息（静态包则是 iframe onLoad）。
    if (externalReadyKey === sceneKey) {
      readyRef.current?.();
    }
  }, [sceneSettled, sceneKey, externalReadyKey, resolved?.entry.component]);

  if (!resolved?.frame) return null;

  const { entry, frame } = resolved;
  const transform =
    frame.layout === "canvas" && frame.canvas && frame.view
      ? canvasTransform(frame.canvas, frame.view, frame.dpr)
      : null;
  const background = entry.manifest.theme?.background ?? "#07110f";
  const Scene = entry.component;

  return (
    <div
      className="wallpaper-scene-enter absolute inset-0 overflow-hidden"
      style={{ backgroundColor: background }}
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
        {Scene ? (
          <Scene {...frame} />
        ) : (
          // 没有内置组件就走 iframe：随包内容（content）与用户安装（user）都在这条路上。
          // key 绑定场景 id：切换场景时重建 iframe，旧页面的 ready/监听一并作废。
          <ExternalScene
            key={`${entry.manifest.id}@${entry.manifest.version}`}
            entry={entry}
            frame={frame}
            onReady={markExternalReady}
          />
        )}
      </div>
    </div>
  );
}
