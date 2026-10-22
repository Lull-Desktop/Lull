#!/usr/bin/env node
/**
 * 维护 `catalog.json` 里每个场景的 `integrity` 摘要。
 *
 *   pnpm content:hash       # 重算并写回（改了内容包之后必须执行，然后重新签名）
 *   pnpm content:hash:check # 只比对，不写盘（CI / 构建前）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePackageDigest, packageDirFor } from "./content-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(root, "public", "content");
const catalogPath = join(contentRoot, "catalog.json");
const checkOnly = process.argv.includes("--check");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const scenes = Array.isArray(catalog.scenes) ? catalog.scenes : [];
const errors = [];
let updated = 0;

for (const scene of scenes) {
  if (typeof scene?.id !== "string" || typeof scene?.version !== "string") {
    errors.push("存在缺少 id/version 的条目，先修清单再加摘要");
    continue;
  }
  let digest;
  try {
    digest = computePackageDigest({
      id: scene.id,
      version: scene.version,
      dir: packageDirFor(scene.entry, contentRoot),
    });
  } catch (error) {
    errors.push(`${scene.id}: ${error.message}`);
    continue;
  }
  const current = scene.integrity?.digest;
  if (current === digest) continue;
  if (checkOnly) {
    errors.push(
      `${scene.id}: integrity 不匹配（应为 ${digest}，实际 ${current ?? "缺失"}）`,
    );
    continue;
  }
  scene.integrity = { algorithm: "sha256", scope: "package", digest };
  updated += 1;
  console.log(`[content:hash] ${scene.id} → ${digest.slice(0, 16)}…`);
}

if (errors.length > 0) {
  console.error("[content:hash] 失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`[content:hash] OK：${scenes.length} 个内容包摘要一致`);
} else if (updated > 0) {
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(
    `[content:hash] 已更新 ${updated} 个条目；记得执行 pnpm content:sign 重新签名`,
  );
} else {
  console.log("[content:hash] 摘要均为最新");
}
