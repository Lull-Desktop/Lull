import {
  SCENE_HOST_API,
  type SceneManifest,
  type ScenePlatform,
} from "./manifest";

/**
 * 判断场景声明的兼容范围是否覆盖当前宿主。
 * 未声明 compatibility 视为兼容当前版本。
 */
export function isSceneCompatible(
  manifest: SceneManifest,
  hostApi: number = SCENE_HOST_API,
  platform: ScenePlatform,
): boolean {
  const compatibility = manifest.compatibility;
  if (!compatibility) return true;
  if (compatibility.hostApi > hostApi) return false;
  if (
    compatibility.maxHostApi !== undefined &&
    hostApi > compatibility.maxHostApi
  ) {
    return false;
  }
  if (compatibility.platforms && !compatibility.platforms.includes(platform)) {
    return false;
  }
  return true;
}
