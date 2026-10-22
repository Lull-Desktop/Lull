#!/usr/bin/env node
/**
 * 内容包摘要算法（唯一实现，供 hash-content / validate-content / 未来的安装器复用）。
 *
 * 摘要覆盖**整个包目录**，而不只是 entry：
 *   sha256(
 *     "lull-content-package\0" +
 *     id + "\0" + version + "\0" +
 *     Σ(relPath + "\0" + size + "\0" + bytes + "\0")   // relPath 按 UTF-8 字节序排序
 *   )
 *
 * 为什么把 id/version 也拌进去：防止把 A 包的摘要抄到 B 包上；
 * 为什么排序：文件系统枚举顺序不稳定，不排序就得不到可复现的摘要；
 * 为什么拒绝符号链接：包内链接会让"摘要覆盖的字节"与"运行时读到的字节"不一致。
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DIGEST_SCHEME = "lull-content-package\0";

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`内容包不允许符号链接：${absolute}`);
    }
    if (stat.isDirectory()) {
      walkFiles(absolute, base, out);
    } else if (stat.isFile()) {
      out.push(relative(base, absolute).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * @param {{id: string, version: string, dir: string}} pack
 * @returns {string} 64 位小写十六进制 sha256
 */
export function computePackageDigest({ id, version, dir }) {
  if (!id || !version) {
    throw new Error("计算摘要需要 id 与 version");
  }
  const files = walkFiles(dir);
  if (files.length === 0) {
    throw new Error(`内容包目录为空：${dir}`);
  }
  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );

  const hash = createHash("sha256");
  hash.update(DIGEST_SCHEME, "utf8");
  for (const part of [id, version]) {
    hash.update(part, "utf8");
    hash.update("\0");
  }
  for (const relPath of files) {
    const bytes = readFileSync(join(dir, relPath));
    hash.update(relPath, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 由 entry 推出包目录（entry 必须位于独立目录内）。 */
export function packageDirFor(entry, contentRoot) {
  const segments = typeof entry === "string" ? entry.split("/") : [];
  if (segments.length < 2) {
    throw new Error("entry 必须位于内容根下的独立目录（例如 scenes/mist/index.html）");
  }
  return join(contentRoot, ...segments.slice(0, -1));
}
