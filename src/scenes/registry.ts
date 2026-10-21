/**
 * 官方内置场景注册表。
 *
 * 新增内置场景只需在本文件追加一个 `BuiltinScene`；设置页、壁纸宿主和
 * 跨屏布局都从同一份清单读取，不再分别维护元数据与实现。
 */
import { DEFAULT_SCENE_ID } from "@/core/wallpaper/params";
import { AuroraScene } from "@/scenes/aurora";
import { BambooScene } from "@/scenes/bamboo";
import { DuskScene } from "@/scenes/dusk";
import {
  type BuiltinScene,
  parseSceneManifest,
  type SceneCatalogEntry,
} from "@/sdk/scene";

const BAMBOO_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.bamboo",
  name: "竹影",
  version: "1.0.0",
  description: "深夜竹林、薄雾与远山，Lull 的默认场景。",
  author: "Lull",
  license: "GPL-3.0-or-later",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
  theme: { background: "#07110f", accent: "#a9bf9b" },
});

const AURORA_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.aurora",
  name: "极光",
  version: "1.0.0",
  description: "深蓝夜空与缓慢漂移的极光光带。",
  author: "Lull",
  license: "GPL-3.0-or-later",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
  theme: { background: "#07131f", accent: "#8fe4ff" },
});

const DUSK_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.dusk",
  name: "暮色",
  version: "1.0.0",
  description: "落日、云带与层叠远山，适合傍晚的暖调天光。",
  author: "Lull",
  license: "GPL-3.0-or-later",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
  theme: { background: "#1b1520", accent: "#e0ad83" },
});

export { DEFAULT_SCENE_ID };

export const BUILTIN_SCENES: readonly BuiltinScene[] = [
  { source: "builtin", manifest: BAMBOO_MANIFEST, component: BambooScene },
  { source: "builtin", manifest: AURORA_MANIFEST, component: AuroraScene },
  { source: "builtin", manifest: DUSK_MANIFEST, component: DuskScene },
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
