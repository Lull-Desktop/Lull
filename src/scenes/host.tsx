"use client";

/**
 * 场景宿主：根据 URL 参数选择内置场景组件或外部静态内容包。
 *
 * 外部内容包以 `sandbox=""` 的 iframe 加载：**不执行 JavaScript**、没有同源
 * 存储、没有 Tauri IPC。这是首版明确的安全边界；动态能力只在内置 React 场景中提供。
 */
import { useEffect, useRef, useState } from "react";
import { canvasTransform, type WallpaperParams } from "@/core/wallpaper/params";
import { useSceneCatalog } from "@/hooks/use-scene-catalog";
import { resolveSceneFrame, type SceneEnvironment } from "@/scenes/frame";
import { DEFAULT_SCENE_ID } from "@/scenes/registry";
import type { SceneCatalogEntry } from "@/sdk/scene";

type SceneHostProps = {
  params: WallpaperParams;
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

function ExternalScene({ entry }: { entry: SceneCatalogEntry }) {
  if (!entry.entryUrl) return null;
  return (
    <iframe
      data-testid="external-scene"
      title={entry.manifest.name}
      src={entry.entryUrl}
      sandbox=""
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0"
    />
  );
}

export function SceneHost({ params }: SceneHostProps) {
  const { entries } = useSceneCatalog();
  const [environment, setEnvironment] = useState(readEnvironment);

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
      className="absolute inset-0 overflow-hidden"
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
        {entry.source === "content" ? (
          <ExternalScene entry={entry} />
        ) : Scene ? (
          <Scene {...frame} />
        ) : null}
      </div>
    </div>
  );
}
