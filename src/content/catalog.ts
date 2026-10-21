/**
 * 内容目录加载：只读取随包分发的 `public/content/catalog.json`。
 *
 * 第一版不联网、不执行安装脚本；目录加载失败只会让设置页少几个外部场景，
 * 内置场景与壁纸运行完全不受影响。
 */
import {
  parseSceneCatalog,
  type SceneCatalogEntry,
  sceneEntryUrl,
} from "@/sdk/scene";

export const CONTENT_CATALOG_PATH = "/content/catalog.json";
export const CONTENT_ROOT = "/content/";

export class ContentCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentCatalogError";
  }
}

/**
 * 拉取并校验内容目录，返回可直接挂载的外部场景条目。
 * `fetcher` 参数用于测试与将来的离线包读取器。
 */
export async function loadContentSceneEntries(
  fetcher: typeof fetch = fetch,
  url: string = CONTENT_CATALOG_PATH,
): Promise<SceneCatalogEntry[]> {
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) {
    throw new ContentCatalogError(
      `内容目录加载失败：HTTP ${response.status} (${url})`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ContentCatalogError(`内容目录不是合法 JSON：${url}`);
  }
  const catalog = parseSceneCatalog(payload, { where: "content/catalog.json" });
  return catalog.scenes.map((manifest) => {
    const entryUrl = sceneEntryUrl(manifest, CONTENT_ROOT);
    if (!entryUrl) {
      throw new ContentCatalogError(`场景 ${manifest.id} 缺少 entry`);
    }
    return {
      manifest,
      source: "content" as const,
      entryUrl,
      component: null,
    };
  });
}
