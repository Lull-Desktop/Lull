/**
 * 场景帧解析：把 URL 参数、Manifest 元数据与窗口环境合成为场景只读 Frame。
 * 能力与兼容性在这里参与运行：不满足时返回 null，由宿主回退到可用场景。
 */
import { resolveSync, type WallpaperParams } from "@/core/wallpaper/params";
import {
  isSceneCompatible,
  resolveSceneParams,
  SCENE_HOST_API,
  type SceneCatalogEntry,
  type SceneFrame,
  type ScenePlatform,
} from "@/sdk/scene";

/** 当前发布物只支持 Windows；将来扩展平台时从这里改。 */
export const SCENE_HOST_PLATFORM: ScenePlatform = "windows";

export type SceneEnvironment = {
  viewportW: number;
  viewportH: number;
  dpr: number;
  /** 宿主捕获的绝对时间锚点。 */
  epochMs: number;
  reducedMotion: boolean;
};

export function resolveSceneFrame(
  entry: SceneCatalogEntry,
  params: WallpaperParams,
  env: SceneEnvironment,
): SceneFrame | null {
  const manifest = entry.manifest;
  if (!isSceneCompatible(manifest, SCENE_HOST_API, SCENE_HOST_PLATFORM)) {
    return null;
  }

  const supportsViewport = manifest.capabilities.includes("wallpaper.viewport");
  const supportsCanvas = manifest.capabilities.includes("wallpaper.canvas");
  const useCanvas =
    params.mode === "span" &&
    supportsCanvas &&
    params.canvas !== null &&
    params.view !== null;

  if (!useCanvas && !supportsViewport) return null;

  const layout = useCanvas ? "canvas" : "viewport";
  // 外部静态包不接收 SceneProps，无法读取相位；即使声明 capability 也不启用同步。
  const syncEnabled =
    entry.source === "builtin" &&
    resolveSync(params.mode, params.sync) &&
    manifest.capabilities.includes("wallpaper.sync");

  return {
    mode: params.mode,
    layout,
    sync: { enabled: syncEnabled, epochMs: env.epochMs },
    viewport: { w: env.viewportW, h: env.viewportH, dpr: env.dpr },
    canvas: useCanvas ? params.canvas : null,
    view: params.view,
    dpr: env.dpr,
    params: resolveSceneParams(manifest.params, params.params),
    reducedMotion: env.reducedMotion,
    performance: manifest.performance ?? null,
  };
}
