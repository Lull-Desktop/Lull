/**
 * 官方内置场景注册表。
 *
 * 宿主内嵌只保留媒体壁纸（`lull.video`）：它需要 MediaSurface、素材库与原生会话，
 * 不适合做成沙箱场景包。竹影已迁移为随包官方扩展
 * `extensions/official/bamboo`（产物 id `lull.bamboo`），极光与暮色已移除。
 */
import { DEFAULT_SCENE_ID } from "@/core/wallpaper/params";
import { VideoScene } from "@/scenes/video";
import {
  type BuiltinScene,
  parseSceneManifest,
  type SceneCatalogEntry,
} from "@/sdk/scene";

const VIDEO_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.video",
  name: "媒体",
  version: "1.0.0",
  description: "本地图片或视频壁纸；素材与播放参数在下方媒体面板中设置。",
  author: "Lull",
  license: "GPL-3.0-or-later",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
  theme: { background: "#050a10", accent: "#8fb7c9" },
  performance: { tier: "medium", targetFps: 30 },
  compatibility: { hostApi: 1, platforms: ["windows"] },
});

export { DEFAULT_SCENE_ID };

export const BUILTIN_SCENES: readonly BuiltinScene[] = [
  { source: "builtin", manifest: VIDEO_MANIFEST, component: VideoScene },
];

const BY_ID = new Map(
  BUILTIN_SCENES.map((scene) => [scene.manifest.id, scene] as const),
);

export function builtinScene(id: string): BuiltinScene | null {
  return BY_ID.get(id) ?? null;
}

/** 内置场景的目录条目（设置页在内容目录加载完成前也能立即显示）。 */
export function builtinCatalogEntries(): SceneCatalogEntry[] {
  return BUILTIN_SCENES.map((scene) => ({
    manifest: scene.manifest,
    source: "builtin" as const,
    entryUrl: null,
    component: scene.component,
  }));
}
