/**
 * 场景目录（catalog）：把静态内容包清单收敛成宿主可消费的场景列表。
 *
 * 目录文件位于 `public/content/catalog.json`，随安装包一起分发；
 * 第一版只支持静态 Web 场景包，不加载任意宿主插件。
 */
import { parseSceneManifest, type SceneManifest } from "./manifest";

export const CONTENT_CATALOG_SCHEMA_VERSION = 1 as const;

export type SceneCatalogDocument = {
  schemaVersion: typeof CONTENT_CATALOG_SCHEMA_VERSION;
  scenes: SceneManifest[];
};

export type ParseCatalogOptions = {
  /** 内容根路径（例如 `/content/`），用于生成可加载的入口 URL。 */
  contentRoot?: string;
  where?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析目录文件并补齐每个条目的绝对入口 URL。
 * 同一个目录里出现重复 id 视为整体错误——避免设置页出现两个同名场景。
 */
export function parseSceneCatalog(
  input: unknown,
  options: ParseCatalogOptions = {},
): SceneCatalogDocument {
  const where = options.where ?? "content catalog";
  if (!isRecord(input)) {
    throw new Error(`${where}: 必须是 JSON 对象`);
  }
  if (input.schemaVersion !== CONTENT_CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `${where}: 不支持的 schemaVersion=${String(input.schemaVersion)}`,
    );
  }
  if (!Array.isArray(input.scenes)) {
    throw new Error(`${where}: scenes 必须是数组`);
  }

  const scenes: SceneManifest[] = [];
  const seen = new Set<string>();
  input.scenes.forEach((raw, index) => {
    const manifest = parseSceneManifest(raw, {
      requireEntry: true,
      where: `${where}.scenes[${index}]`,
    });
    if (seen.has(manifest.id)) {
      throw new Error(`${where}: 场景 id 重复: ${manifest.id}`);
    }
    seen.add(manifest.id);
    scenes.push(manifest);
  });

  return { schemaVersion: CONTENT_CATALOG_SCHEMA_VERSION, scenes };
}

/** 把清单中的相对 entry 解析为 WebView 可加载的绝对路径。 */
export function sceneEntryUrl(
  manifest: SceneManifest,
  contentRoot = "/content/",
): string | null {
  if (!manifest.entry) return null;
  const root = contentRoot.endsWith("/") ? contentRoot : `${contentRoot}/`;
  return `${root}${manifest.entry.replace(/^\/+/, "")}`;
}
