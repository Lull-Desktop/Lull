/**
 * 内容目录签名校验：目录文件（`catalog.json`）的原始字节由 ECDSA P-256 签名，
 * 公钥随包分发在 `public/content/keys/<keyId>.jwk.json`。
 *
 * 为什么签"原始字节"而不是规范化 JSON：签名与序列化方式解耦，
 * 任何人改动目录（哪怕是空白）都会让签名失效，不会出现"两种规范化结果"的歧义。
 */

export const CONTENT_SIGNATURE_SCHEMA_VERSION = 1 as const;
export const CONTENT_SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256" as const;

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,63}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type CatalogSignature = {
  schemaVersion: typeof CONTENT_SIGNATURE_SCHEMA_VERSION;
  algorithm: typeof CONTENT_SIGNATURE_ALGORITHM;
  keyId: string;
  /** 对 `catalog.json` 原始字节的 DER-free 签名（r||s，base64）。 */
  signature: string;
};

export class ContentSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentSignatureError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析并校验签名文件结构；结构非法直接抛错（不能降级为"未签名"）。 */
export function parseCatalogSignature(input: unknown): CatalogSignature {
  const where = "content/catalog.sig.json";
  if (!isRecord(input)) {
    throw new ContentSignatureError(`${where}: 必须是 JSON 对象`);
  }
  if (input.schemaVersion !== CONTENT_SIGNATURE_SCHEMA_VERSION) {
    throw new ContentSignatureError(
      `${where}: 不支持的 schemaVersion=${String(input.schemaVersion)}`,
    );
  }
  if (input.algorithm !== CONTENT_SIGNATURE_ALGORITHM) {
    throw new ContentSignatureError(
      `${where}: 不支持的算法 ${String(input.algorithm)}（只支持 ${CONTENT_SIGNATURE_ALGORITHM}）`,
    );
  }
  if (typeof input.keyId !== "string" || !KEY_ID_PATTERN.test(input.keyId)) {
    throw new ContentSignatureError(`${where}: keyId 非法`);
  }
  if (
    typeof input.signature !== "string" ||
    !BASE64_PATTERN.test(input.signature)
  ) {
    throw new ContentSignatureError(`${where}: signature 必须是 base64 字符串`);
  }
  return {
    schemaVersion: CONTENT_SIGNATURE_SCHEMA_VERSION,
    algorithm: CONTENT_SIGNATURE_ALGORITHM,
    keyId: input.keyId,
    signature: input.signature,
  };
}

/** base64 → 字节；非法输入抛 ContentSignatureError。 */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    // 显式建在 ArrayBuffer 上：SubtleCrypto 的 BufferSource 不接受 SharedArrayBuffer 视图。
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new ContentSignatureError("签名不是合法的 base64");
  }
}

/**
 * 校验目录签名。返回 false 表示"签名不匹配"，抛错表示"环境/密钥不可用"。
 * WebView2 与 Node 20+ 都提供 ECDSA P-256 的 SubtleCrypto 实现。
 */
export async function verifyCatalogSignature(
  payload: string,
  signature: CatalogSignature,
  jwk: JsonWebKey,
): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ContentSignatureError(
      "当前环境没有 SubtleCrypto，无法校验内容目录签名",
    );
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new ContentSignatureError("公钥必须是 EC P-256 JWK");
  }
  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new ContentSignatureError("公钥导入失败：JWK 无效");
  }
  return subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64(signature.signature),
    new TextEncoder().encode(payload),
  );
}
