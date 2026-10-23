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
  sceneRunsScript,
  sceneSupportsSync,
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
  // 内置场景由组件直接读帧；外部场景必须启用脚本桥才能收到相位。
  // 没有脚本桥的静态包即使声明 wallpaper.sync 也不会同步。
  const syncEnabled =
    resolveSync(params.mode, params.sync) &&
    sceneSupportsSync(manifest) &&
    (entry.source === "builtin" || sceneRunsScript(manifest));

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
