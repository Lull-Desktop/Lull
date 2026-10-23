#!/usr/bin/env node
/**
 * 把构建后的 Widget 包目录打成可安装的 `.lull-widget.zip`。
 *
 * 用法：
 *   node scripts/pack-widget.mjs <dist-dir> [more-dir ...] [--out <dir>] [--tampered]
 *   pnpm widgets:samples:pack
 *
 * 产物：
 *   <out>/<id>-<version>.lull-widget.zip
 *   <out>/<id>-<version>-tampered.lull-widget.zip   # 仅 --tampered
 *
 * zip 根目录直接放 `widget.json` / `entry` / 资源，安装器会按扩展中心的设计
 * 校验清单、摘要（`.lull-integrity.json`）与路径安全。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./zip-writer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET_SCHEME = "lull-widget-package\0";
const CONTENT_SCHEME = "lull-content-package\0";
/** 与 Rust `content_package::digest` 的官方 mist 摘要一致，用作 Node 侧自检。 */
const MIST_DIGEST =
  "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb";
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`[widget:pack] ${message}`);
  process.exit(1);
}

/** 递归收集普通文件；`includeDot=false` 时跳过所有点号路径（与 Rust 摘要一致）。 */
function collectFiles(dir, relative = "", includeDot = true) {
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

function computeDigest(files, scheme, id, version) {
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

/** 用官方 scene 包的已知摘要校验 Node 侧算法，防止与 Rust 实现漂移。 */
function verifyDigestAlgorithm() {
  const mist = join(root, "public", "content", "scenes", "mist");
  if (!existsSync(join(mist, "index.html"))) return;
  const digest = computeDigest(
    collectFiles(mist),
    CONTENT_SCHEME,
    "community.mist",
    "1.0.0",
  );
  if (digest !== MIST_DIGEST) {
    fail(
      `摘要算法自检失败：Node 算出 ${digest}，Rust 已知值 ${MIST_DIGEST}。` +
        " 请先修复算法，否则生成的 zip 会被安装器拒绝。",
    );
  }
}

function pack(dir, outDir, tampered) {
  const manifestPath = join(dir, "widget.json");
  if (!existsSync(manifestPath)) {
    fail(`缺少 widget.json：${dir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!ID.test(manifest.id ?? "")) fail(`id 非法：${manifest.id}`);
  if (!VERSION.test(manifest.version ?? "")) {
    fail(`version 非法：${manifest.version}`);
  }
  if (manifest.builtin !== false) fail("示例包必须 builtin=false");
  if (typeof manifest.license !== "string" || manifest.license.trim() === "") {
    fail(`${manifest.id} 缺少 license：安装器会拒绝`);
  }
  const entry = manifest.entry ?? "index.html";
  const files = collectFiles(dir, "", false);
  if (!files.some((file) => file.name === entry)) {
    fail(`${manifest.id} 的 entry 不存在：${entry}`);
  }

  const digest = computeDigest(
    files,
    WIDGET_SCHEME,
    manifest.id,
    manifest.version,
  );
  const lock = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        algorithm: "sha256",
        scope: "package",
        digest,
        source: "declared",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const entries = [...files, { name: ".lull-integrity.json", data: lock }];
  const base = `${manifest.id}-${manifest.version}`;

  mkdirSync(outDir, { recursive: true });
  const normalPath = join(outDir, `${base}.lull-widget.zip`);
  const normalSize = writeZip(normalPath, entries);
  console.log(
    `[widget:pack] ${manifest.id} ${manifest.version} → ${normalPath} ` +
      `(${entries.length} files, ${(normalSize / 1024).toFixed(1)} KiB, ${digest.slice(0, 12)}…)`,
  );

  if (tampered) {
    const altered = entries.map((file) =>
      file.name === entry
        ? {
            name: file.name,
            data: Buffer.concat([
              file.data,
              Buffer.from("\n<!-- tampered for installer test -->\n"),
            ]),
          }
        : file,
    );
    const tamperedPath = join(outDir, `${base}-tampered.lull-widget.zip`);
    const tamperedSize = writeZip(tamperedPath, altered);
    console.log(
      `[widget:pack] ${manifest.id} ${manifest.version} → ${tamperedPath} ` +
        `(${(tamperedSize / 1024).toFixed(1)} KiB, 摘要应不匹配)`,
    );
  }
}

const args = process.argv.slice(2);
const dirs = [];
let outDir = join(root, "artifacts");
let tampered = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--out") {
    index += 1;
    if (!args[index]) fail("--out 需要一个目录参数");
    outDir = resolve(args[index]);
    continue;
  }
  if (arg === "--tampered") {
    tampered = true;
    continue;
  }
  dirs.push(resolve(arg));
}
if (dirs.length === 0) {
  fail("用法：node scripts/pack-widget.mjs <dist-dir> [more-dir ...] [--out <dir>] [--tampered]");
}

verifyDigestAlgorithm();
for (const dir of dirs) {
  pack(dir, outDir, tampered);
}
