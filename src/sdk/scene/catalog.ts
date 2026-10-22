/**
 * 场景目录（catalog）：把静态内容包清单收敛成宿主可消费的场景列表。
 *
 * 目录文件位于 `public/content/catalog.json`，随安装包一起分发；
 * 第一版只支持静态 Web 场景包，不加载任意宿主插件。
 *
 * 容错策略（v0.1.0 起）：
 * - 目录整体不可用（非对象 / schemaVersion 不支持 / scenes 不是数组）仍然抛错；
 * - 单个条目非法、id 重复、缺 integrity 只影响该条目：跳过并记录 issue，
 *   其余场景与内置场景照常可用。不能因为第三方包写错一个字段就让整个外部目录消失。
 */
import { parseSceneManifest, type SceneManifest } from "./manifest";

export const CONTENT_CATALOG_SCHEMA_VERSION = 1 as const;

export type SceneCatalogIssueCode =
  | "invalid-manifest"
  | "duplicate-id"
  | "missing-integrity";

/** 单条内容包的问题；供设置页展示与 CI 诊断。 */
export type SceneCatalogIssue = {
  /** 在 `catalog.scenes` 数组中的下标。 */
  index: number;
  /** 能解析出的场景 id；清单本身非法时为 null。 */
  id: string | null;
  code: SceneCatalogIssueCode;
  message: string;
};

export type SceneCatalogDocument = {
  schemaVersion: typeof CONTENT_CATALOG_SCHEMA_VERSION;
  scenes: SceneManifest[];
  /** 被跳过的条目；为空表示整个目录可用。 */
  issues: SceneCatalogIssue[];
};

export type ParseCatalogOptions = {
  /** 内容根路径（例如 `/content/`），用于生成可加载的入口 URL。 */
  contentRoot?: string;
  where?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 清单解析失败时尽力取出 id，便于在设置页指出是哪个包有问题。 */
function bestEffortId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

/**
 * 解析目录文件。
 *
 * 重复 id 保留**第一条**（发布者历史顺序即优先级），后续条目记为 issue 并跳过；
 * `pnpm content:check` 对重复 id 仍然直接失败，避免把有歧义的目录发出去。
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
  const issues: SceneCatalogIssue[] = [];
  const seen = new Set<string>();

  input.scenes.forEach((raw, index) => {
    let manifest: SceneManifest;
    try {
      manifest = parseSceneManifest(raw, {
        requireEntry: true,
        where: `${where}.scenes[${index}]`,
      });
    } catch (error) {
      issues.push({
        index,
        id: bestEffortId(raw),
        code: "invalid-manifest",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (seen.has(manifest.id)) {
      issues.push({
        index,
        id: manifest.id,
        code: "duplicate-id",
        message: `场景 id 重复，已跳过该条目: ${manifest.id}`,
      });
      return;
    }
    seen.add(manifest.id);
    scenes.push(manifest);

    if (!manifest.integrity) {
      issues.push({
        index,
        id: manifest.id,
        code: "missing-integrity",
        message: `场景 ${manifest.id} 缺少 integrity 摘要，无法校验包内容`,
      });
    }
  });

  return { schemaVersion: CONTENT_CATALOG_SCHEMA_VERSION, scenes, issues };
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
