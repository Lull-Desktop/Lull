#!/usr/bin/env node
/**
 * 内容目录签名工具（ECDSA P-256 / SHA-256）。
 *
 *   pnpm content:keygen   # 生成本地签名密钥（只写一次，私钥在 .keys/，不进仓库）
 *   pnpm content:sign     # 用私钥给 catalog.json 的原始字节签名
 *   pnpm content:verify   # 用随包公钥验证 catalog.sig.json（CI 用）
 *
 * 设计：
 * - 签名对象是 catalog.json 的**原始字节**，不做 JSON 规范化，避免"两种序列化"歧义；
 * - 公钥随包分发（public/content/keys/<keyId>.jwk.json），运行时用 WebCrypto 验证；
 * - 私钥只留在本机 `.keys/` 或 CI secret（`LULL_CONTENT_SIGNING_KEY` 指向 PEM）。
 *
 * 轮换：换 keyId + 新密钥后重新签名；旧公钥可保留在 keys/ 下供旧目录使用。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(root, "public", "content");
const catalogPath = join(contentRoot, "catalog.json");
const signaturePath = join(contentRoot, "catalog.sig.json");
const keysDir = join(contentRoot, "keys");
const privateKeyPath = join(root, ".keys", "lull-content-signing.pem");

export const SIGNATURE_SCHEMA_VERSION = 1;
export const SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256";
export const DEFAULT_KEY_ID = "lull-official-1";

function signingKeyPath() {
  const fromEnv = process.env.LULL_CONTENT_SIGNING_KEY;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : privateKeyPath;
}

function publicKeyPath(keyId) {
  return join(keysDir, `${keyId}.jwk.json`);
}

function command() {
  if (process.argv.includes("--init")) return "init";
  if (process.argv.includes("--verify")) return "verify";
  return "sign";
}

function init() {
  if (existsSync(privateKeyPath) && !process.argv.includes("--force")) {
    console.error(
      `[content:sign] 私钥已存在：${privateKeyPath}\n` +
        "换密钥会让旧签名与公钥失效；确定要轮换请加 --force（并更新 keyId）。",
    );
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  mkdirSync(dirname(privateKeyPath), { recursive: true });
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  writeFileSync(
    publicKeyPath(DEFAULT_KEY_ID),
    `${JSON.stringify(publicKey.export({ format: "jwk" }), null, 2)}\n`,
  );
  console.log(`[content:sign] 私钥：${privateKeyPath}（已 gitignore）`);
  console.log(`[content:sign] 公钥：${publicKeyPath(DEFAULT_KEY_ID)}`);
  console.log("[content:sign] 下一步：pnpm content:hash && pnpm content:sign");
}

function signCatalog() {
  const keyPath = signingKeyPath();
  if (!existsSync(keyPath)) {
    console.error(
      `[content:sign] 找不到私钥：${keyPath}\n先执行 pnpm content:keygen。`,
    );
    process.exit(1);
  }
  const keyId = process.env.LULL_CONTENT_KEY_ID ?? DEFAULT_KEY_ID;
  const payload = readFileSync(catalogPath);
  const signature = sign("sha256", payload, {
    key: createPrivateKey(readFileSync(keyPath, "utf8")),
    dsaEncoding: "ieee-p1363", // WebCrypto 需要的原始 r||s，不是 DER
  });
  const document = {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    signature: signature.toString("base64"),
  };
  writeFileSync(signaturePath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `[content:sign] 已签名 ${payload.length} 字节 → ${signaturePath}（keyId=${keyId}）`,
  );
}

/** 供 validate-content 复用：校验 sig 文件与 catalog 字节是否匹配。 */
export function verifyCatalogSignature({ keyId, signature, payload }) {
  const path = publicKeyPath(keyId);
  if (!existsSync(path)) {
    return { ok: false, reason: `缺少公钥：${path}` };
  }
  try {
    const jwk = JSON.parse(readFileSync(path, "utf8"));
    const ok = verify(
      "sha256",
      payload,
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64"),
    );
    return ok ? { ok: true } : { ok: false, reason: "签名与目录内容不匹配" };
  } catch (error) {
    return { ok: false, reason: `验签异常：${error.message}` };
  }
}

function verifyCurrent() {
  if (!existsSync(signaturePath)) {
    console.error(`[content:sign] 没有签名文件：${signaturePath}`);
    process.exit(1);
  }
  const document = JSON.parse(readFileSync(signaturePath, "utf8"));
  const result = verifyCatalogSignature({
    keyId: document.keyId,
    signature: document.signature,
    payload: readFileSync(catalogPath),
  });
  if (!result.ok) {
    console.error(`[content:sign] 验签失败：${result.reason}`);
    process.exit(1);
  }
  console.log(`[content:sign] OK：keyId=${document.keyId}`);
}

const mode = command();
const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  if (mode === "init") init();
  else if (mode === "verify") verifyCurrent();
  else signCatalog();
}
