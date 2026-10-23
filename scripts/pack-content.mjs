#!/usr/bin/env node
/**
 * 把内容包目录打成可安装的 `.zip`。
 *
 *   pnpm content:pack examples/content/param-demo --out artifacts
 *   node scripts/pack-content.mjs ./my-scene --out artifacts
 *
 * 只打包 `catalog.json` + entry 所在目录，条目名统一正斜杠、UTF-8。
 * Windows 自带的 `Compress-Archive` 会写反斜杠路径，安装器会按安全规则拒绝，
 * 所以不要用它来分发内容包。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computePackageDigest, packageDirFor } from "./content-digest.mjs";
import { writeZip } from "./zip-writer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`[content:pack] ${message}`);
  process.exit(1);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const args = process.argv.slice(2);
let bundleArg;
let outDir = join(root, "artifacts");
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--out") {
    index += 1;
    if (!args[index]) fail("--out 需要一个目录参数");
    outDir = resolve(args[index]);
    continue;
  }
  if (bundleArg) fail(`多余的参数：${arg}`);
  bundleArg = arg;
}
if (!bundleArg) {
  fail(
    "用法：node scripts/pack-content.mjs <bundle-dir> [--out <dir>]",
  );
}

const bundle = resolve(bundleArg);
const catalogPath = join(bundle, "catalog.json");
if (!existsSync(catalogPath)) {
  fail(`缺少 catalog.json：${catalogPath}`);
}
let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
} catch (error) {
  fail(`catalog.json 不是合法 JSON：${error.message}`);
}
if (!isObject(catalog) || catalog.schemaVersion !== 1) {
  fail("catalog.json.schemaVersion 必须是 1");
}
if (!Array.isArray(catalog.scenes) || catalog.scenes.length !== 1) {
  fail("内容包必须恰好包含一条 scene");
}
const scene = catalog.scenes[0];
if (!isObject(scene)) fail("scenes[0] 必须是对象");
if (typeof scene.id !== "string" || !ID.test(scene.id)) {
  fail(`scene.id 非法：${String(scene.id)}`);
}
if (typeof scene.version !== "string" || !VERSION.test(scene.version)) {
  fail(`scene.version 非法：${String(scene.version)}`);
}
if (typeof scene.license !== "string" || scene.license.trim() === "") {
  fail("scene.license 必填");
}
if (typeof scene.entry !== "string") {
  fail("scene.entry 必须是字符串");
}
if (scene.entry.includes("\\") || scene.entry.startsWith("/")) {
  fail("scene.entry 必须是正斜杠相对路径");
}

let packageDir;
try {
  packageDir = packageDirFor(scene.entry, bundle);
} catch (error) {
  fail(error.message);
}
if (!existsSync(packageDir)) {
  fail(`entry 所在目录不存在：${packageDir}`);
}
const entryFile = join(bundle, ...scene.entry.split("/"));
if (!existsSync(entryFile)) {
  fail(`entry 指向的文件不存在：${scene.entry}`);
}

const digest = computePackageDigest({
  id: scene.id,
  version: scene.version,
  dir: packageDir,
});
const declared = scene.integrity?.digest;
if (typeof declared !== "string") {
  fail(
    "catalog.json 缺少 integrity.digest；先执行 pnpm content:hash --bundle <bundle>",
  );
}
if (declared !== digest) {
  fail(
    `integrity 不匹配：声明 ${declared}，实际 ${digest}。` +
      " 先执行 pnpm content:hash --bundle <bundle>",
  );
}

const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      fail(`内容包不允许符号链接：${absolute}`);
    }
    if (stat.isDirectory()) {
      collect(absolute);
      continue;
    }
    if (!stat.isFile()) continue;
    const name = relative(bundle, absolute).split(sep).join("/");
    files.push({ name, data: readFileSync(absolute) });
  }
}
collect(packageDir);
files.sort((left, right) => left.name.localeCompare(right.name));
const entries = [
  { name: "catalog.json", data: readFileSync(catalogPath) },
  ...files,
];

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${scene.id}-${scene.version}.zip`);
const tempPath = `${outPath}.tmp`;
const size = writeZip(tempPath, entries);
let writtenPath = outPath;
try {
  // Windows 上旧 zip 可能被资源管理器/压缩工具占用；先删再 rename。
  if (existsSync(outPath)) unlinkSync(outPath);
  renameSync(tempPath, outPath);
} catch (error) {
  writtenPath = join(outDir, `${scene.id}-${scene.version}-fixed.zip`);
  if (existsSync(writtenPath)) unlinkSync(writtenPath);
  renameSync(tempPath, writtenPath);
  console.warn(
    `[content:pack] 目标 zip 被占用（${error.message}），已写到 ${writtenPath}`,
  );
}
console.log(
  `[content:pack] ${scene.id} ${scene.version} → ${writtenPath} ` +
    `(${entries.length} files, ${(size / 1024).toFixed(1)} KiB, ${digest.slice(0, 12)}…)`,
);
