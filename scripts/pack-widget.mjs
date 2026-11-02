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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFiles,
  computeDigest,
  WIDGET_SCHEME,
} from "./lib/widget-digest.mjs";
import { writeZip } from "./zip-writer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_SCHEME = "lull-content-package\0";
/** 与 Rust `content_package::digest` 的场景示例摘要一致，用作 Node 侧自检。 */
const CONTENT_EXAMPLE_DIGEST =
  "3a81b290fd8fdf35c7f74d80de838b5154d4c1b97a66b0c0fde6e4754a221d31";
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`[widget:pack] ${message}`);
  process.exit(1);
}

/** 用仓库内的脚本场景示例校验 Node 侧算法，防止与 Rust 实现漂移。 */
function verifyDigestAlgorithm() {
  const example = join(
    root,
    "examples",
    "scenes",
    "param-demo",
    "scenes",
    "param-demo",
  );
  if (!existsSync(join(example, "index.html"))) return;
  const digest = computeDigest(
    collectFiles(example),
    CONTENT_SCHEME,
    "demo.param-scene",
    "1.1.0",
  );
  if (digest !== CONTENT_EXAMPLE_DIGEST) {
    fail(
      `摘要算法自检失败：Node 算出 ${digest}，Rust 已知值 ${CONTENT_EXAMPLE_DIGEST}。` +
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
  if (!existsSync(join(dir, "widget.json"))) {
    console.log(`[samples] 跳过未构建目录：${dir}`);
    continue;
  }
  pack(dir, outDir, tampered);
}
