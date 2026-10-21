"use client";

/**
 * 场景宿主：根据 URL 参数选择内置场景组件或外部静态内容包。
 *
 * 外部内容包以 `sandbox=""` 的 iframe 加载：**不执行 JavaScript**、没有同源
 * 存储、没有 Tauri IPC。这是首版明确的安全边界；动态能力只在内置 React 场景中提供。
 */
import {
  canvasTransform,
  resolveSync,
  type WallpaperParams,
} from "@/core/wallpaper/params";
import { useSceneCatalog } from "@/hooks/use-scene-catalog";
import { DEFAULT_SCENE_ID } from "@/scenes/registry";
import type { SceneCatalogEntry } from "@/sdk/scene";

type SceneHostProps = {
  params: WallpaperParams;
};

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
  const entry =
    entries.find((candidate) => candidate.manifest.id === params.scene) ??
    entries.find((candidate) => candidate.manifest.id === DEFAULT_SCENE_ID) ??
    entries[0];

  if (!entry) return null;

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const sync = resolveSync(params.mode, params.sync);
  const useCanvas =
    params.mode === "span" && params.canvas !== null && params.view !== null;
  const transform =
    useCanvas && params.canvas && params.view
      ? canvasTransform(params.canvas, params.view, dpr)
      : null;
  const layout = transform ? "canvas" : "viewport";
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
          <Scene
            layout={layout}
            sync={sync}
            canvas={params.canvas}
            view={params.view}
            dpr={dpr}
          />
        ) : null}
      </div>
    </div>
  );
}
