/**
 * Widget 包摘要：与 Rust `src-tauri/src/widget_package/digest.rs` 保持同一算法。
 *
 * 算法：`sha256("lull-widget-package\0" + id + "\0" + version + "\0" +
 * Σ(relPath + "\0" + size + "\0" + bytes + "\0"))`，路径按 UTF-8 字节序排序，
 * 排除 `.lull-integrity.json` 与任何点号开头的路径。
 *
 * `pack-widget.mjs` 与官方扩展构建共用这一份实现，避免 Node 侧两套算法漂移。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WIDGET_SCHEME = "lull-widget-package\0";
export const WIDGET_INTEGRITY_FILE = ".lull-integrity.json";

/**
 * 递归收集普通文件；`includeDot=false` 时跳过所有点号路径（与 Rust 摘要范围一致）。
 * 符号链接直接报错，避免打包与摘要出现两套解析。
 */
export function collectFiles(dir, relative = "", includeDot = true) {
  const files = [];
  for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
    if (!includeDot && entry.name.startsWith(".")) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`包内不允许符号链接：${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...collectFiles(dir, path, includeDot));
      continue;
    }
    if (entry.isFile()) {
      files.push({ name: path, data: readFileSync(join(dir, path)) });
    }
  }
  return files;
}

/** 按 Rust 的拼装顺序计算摘要；`files` 为 `{ name, data }`。 */
export function computeDigest(files, scheme, id, version) {
  const sorted = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  const hash = createHash("sha256");
  hash.update(Buffer.from(scheme, "utf8"));
  for (const part of [id, version]) {
    hash.update(Buffer.from(part, "utf8"));
    hash.update(Buffer.from([0]));
  }
  for (const file of sorted) {
    hash.update(Buffer.from(file.name, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(file.data.length), "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(file.data);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

/** 计算某个 widget 目录的整包摘要（自动排除点号路径与锁文件）。 */
export function computeWidgetDigest(dir, id, version) {
  return computeDigest(collectFiles(dir, "", false), WIDGET_SCHEME, id, version);
}

/**
 * 构建期封包：写 `.lull-integrity.json`。
 * 字段与 Rust `Integrity` 完全一致，不包含 id/version（校验方传入）。
 */
export function writeWidgetIntegrity(dir, id, version, source = "declared") {
  const digest = computeWidgetDigest(dir, id, version);
  const record = {
    schemaVersion: 1,
    algorithm: "sha256",
    scope: "package",
    digest,
    source,
  };
  const path = join(dir, WIDGET_INTEGRITY_FILE);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { digest, source };
}
