/**
 * 内容目录加载：读取随包分发的 `public/content/catalog.json`，校验目录签名，
 * 再把清单收敛成可挂载的外部场景条目。
 *
 * 第一版不联网、不执行安装脚本；目录加载失败只会让设置页少几个外部场景，
 * 内置场景与壁纸运行完全不受影响。
 */
import {
  parseSceneCatalog,
  type SceneCatalogEntry,
  type SceneCatalogIssue,
  sceneEntryUrl,
} from "@/sdk/scene";
import {
  type CatalogSignature,
  parseCatalogSignature,
  verifyCatalogSignature,
} from "./verify";

export const CONTENT_CATALOG_PATH = "/content/catalog.json";
export const CONTENT_SIGNATURE_PATH = "/content/catalog.sig.json";
export const CONTENT_ROOT = "/content/";

/** 目录签名状态：`valid` = 校验通过；`missing` = 未签名（第三方目录，仅提示）。 */
export type ContentSignatureState = "valid" | "missing";

export type ContentCatalogResult = {
  entries: SceneCatalogEntry[];
  /** 被跳过的条目与质量提示；设置页展示，不影响其余场景。 */
  issues: SceneCatalogIssue[];
  signature: ContentSignatureState;
};

export class ContentCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentCatalogError";
  }
}

function keyPath(keyId: string): string {
  return `${CONTENT_ROOT}keys/${keyId}.jwk.json`;
}

async function loadSignature(
  fetcher: typeof fetch,
): Promise<CatalogSignature | null> {
  const response = await fetcher(CONTENT_SIGNATURE_PATH, { cache: "no-store" });
  // 没有签名文件 = 第三方目录；HTTP 错误不能当成"未签名"静默放行。
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ContentCatalogError(
      `内容目录签名文件加载失败：HTTP ${response.status} (${CONTENT_SIGNATURE_PATH})`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ContentCatalogError(
      `内容目录签名文件不是合法 JSON：${CONTENT_SIGNATURE_PATH}`,
    );
  }
  return parseCatalogSignature(payload);
}

async function loadPublicKey(
  fetcher: typeof fetch,
  keyId: string,
): Promise<JsonWebKey> {
  const path = keyPath(keyId);
  const response = await fetcher(path, { cache: "no-store" });
  if (!response.ok) {
    throw new ContentCatalogError(
      `内容目录公钥加载失败：HTTP ${response.status} (${path})`,
    );
  }
  try {
    return (await response.json()) as JsonWebKey;
  } catch {
    throw new ContentCatalogError(`内容目录公钥不是合法 JSON：${path}`);
  }
}

/**
 * 拉取、验签并校验内容目录，返回可挂载的外部场景条目与问题清单。
 * `fetcher` 参数用于测试与将来的离线包读取器。
 */
export async function loadContentSceneEntries(
  fetcher: typeof fetch = fetch,
  url: string = CONTENT_CATALOG_PATH,
): Promise<ContentCatalogResult> {
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) {
    throw new ContentCatalogError(
      `内容目录加载失败：HTTP ${response.status} (${url})`,
    );
  }
  // 必须按原始字节验签：JSON.parse 之后再序列化会丢失空白与键序。
  const payload = await response.text();

  const signature = await loadSignature(fetcher);
  let signatureState: ContentSignatureState = "missing";
  if (signature) {
    const jwk = await loadPublicKey(fetcher, signature.keyId);
    const verified = await verifyCatalogSignature(payload, signature, jwk);
    if (!verified) {
      throw new ContentCatalogError(
        `内容目录签名校验失败：${url} 与 ${CONTENT_SIGNATURE_PATH} 不匹配`,
      );
    }
    signatureState = "valid";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ContentCatalogError(`内容目录不是合法 JSON：${url}`);
  }

  let catalog: ReturnType<typeof parseSceneCatalog>;
  try {
    catalog = parseSceneCatalog(parsed, { where: "content/catalog.json" });
  } catch (error) {
    throw new ContentCatalogError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const issues = [...catalog.issues];
  const entries: SceneCatalogEntry[] = [];
  catalog.scenes.forEach((manifest, index) => {
    const entryUrl = sceneEntryUrl(manifest, CONTENT_ROOT);
    if (!entryUrl) {
      issues.push({
        index,
        id: manifest.id,
        code: "invalid-manifest",
        message: `场景 ${manifest.id} 缺少 entry`,
      });
      return;
    }
    entries.push({
      manifest,
      source: "content" as const,
      entryUrl,
      component: null,
    });
  });

  return { entries, issues, signature: signatureState };
}
