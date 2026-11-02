#!/usr/bin/env node
/**
 * 官方扩展源码边界检查：扩展只能通过 `@lull/*` SDK 与宿主通信。
 *
 * 检查项：
 * - 禁止 `@/`、`../src`、`@tauri-apps/api`、`__TAURI_INTERNALS__`；
 * - 禁止 localStorage / sessionStorage / eval / new Function；
 * - 禁止源码里写死 localhost / 127.0.0.1（开发地址只允许出现在 `.lull-dev.json`）；
 * - widget 必须有 widget.json、index.html，且 id 与目录名一致、builtin=false；
 * - scene 必须有 catalog.json（单条 scene）与 index.html（Vite 入口）。
 *
 * 用法：node scripts/check-extension-imports.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialRoot = join(repoRoot, "extensions", "official");
const SOURCE = /\.(ts|tsx|js|jsx|mjs|css|html)$/i;

const RULES = [
  { pattern: /from\s+["']@\//, message: "不能从宿主 @/ 相对导入" },
  { pattern: /from\s+["'][^"']*\/src\//, message: "不能直接导入仓库 src/" },
  { pattern: /@tauri-apps\/api/, message: "不能使用 @tauri-apps/api" },
  { pattern: /__TAURI_INTERNALS__/, message: "不能访问 __TAURI_INTERNALS__" },
  { pattern: /\blocalStorage\b/, message: "opaque-origin iframe 没有 localStorage" },
  { pattern: /\bsessionStorage\b/, message: "opaque-origin iframe 没有 sessionStorage" },
  { pattern: /\beval\s*\(/, message: "不能使用 eval" },
  { pattern: /\bnew\s+Function\s*\(/, message: "不能使用 new Function" },
  { pattern: /https?:\/\/(?:localhost|127\.0\.0\.1)/, message: "源码里不能写死开发地址（用 .lull-dev.json）" },
];

const errors = [];
const warn = (message) => errors.push(message);

/** 从源码里读出字符串数组；三处 capability 清单必须一致。 */
function readCapabilities(file, marker) {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(marker);
  if (start === -1) return null;
  // 从 `=` 之后找数组，跳过 `&[&str]` 这类类型标注。
  const equals = text.indexOf("=", start);
  const open = text.indexOf("[", equals === -1 ? start : equals);
  const close = text.indexOf("]", open);
  if (equals === -1 || open === -1 || close === -1) return null;
  return [...text.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function checkCapabilityParity() {
  const sources = [
    [
      "packages/widget-sdk/src/protocol.ts",
      "export const WIDGET_CAPABILITIES",
    ],
    [
      "src-tauri/src/widget_package/manifest.rs",
      "pub const PLUGIN_CAPABILITIES",
    ],
    [
      "Skill/lull-extension/lib/validate.mjs",
      "export const WIDGET_CAPABILITIES",
    ],
  ];
  const parsed = sources.map(([file, marker]) => ({
    file,
    capabilities: readCapabilities(join(repoRoot, file), marker),
  }));
  const missing = parsed.filter((item) => item.capabilities === null);
  for (const item of missing) {
    warn(`${item.file}：找不到 capability 清单（marker 变更？）`);
  }
  if (missing.length > 0) return;
  const reference = parsed[0].capabilities;
  for (const item of parsed.slice(1)) {
    const extra = item.capabilities.filter(
      (capability) => !reference.includes(capability),
    );
    const absent = reference.filter(
      (capability) => !item.capabilities.includes(capability),
    );
    if (extra.length > 0 || absent.length > 0) {
      warn(
        `${item.file} 与 ${parsed[0].file} 的能力清单不一致` +
          `${extra.length > 0 ? `；多出 ${extra.join(", ")}` : ""}` +
          `${absent.length > 0 ? `；缺少 ${absent.join(", ")}` : ""}`,
      );
    }
  }
}

function walk(dir, relative = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || entry.name === "dist") {
      warn(`${path}：扩展源码里不要放构建产物或依赖`);
      continue;
    }
    if (entry.name === ".lull-dev.json") continue;
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), path);
      continue;
    }
    if (!SOURCE.test(entry.name)) continue;
    const text = readFileSync(join(dir, entry.name), "utf8");
    for (const rule of RULES) {
      if (rule.pattern.test(text)) {
        warn(`${path}：${rule.message}`);
      }
    }
  }
}

if (!existsSync(officialRoot)) {
  console.log("[extension:check] 没有 extensions/official，跳过");
  process.exit(0);
}

const ids = readdirSync(officialRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith("_") &&
      !entry.name.startsWith("."),
  )
  .map((entry) => entry.name);

if (ids.length === 0) warn("extensions/official 下没有扩展");

checkCapabilityParity();

const SCENE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

for (const id of ids) {
  const dir = join(officialRoot, id);
  const widgetPath = join(dir, "widget.json");
  const catalogPath = join(dir, "catalog.json");
  if (!existsSync(join(dir, "index.html"))) {
    warn(`${id}：缺少 index.html（Vite 入口）`);
  }
  if (existsSync(widgetPath)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(widgetPath, "utf8"));
    } catch (error) {
      warn(`${id}：widget.json 不是合法 JSON（${error}）`);
      continue;
    }
    if (manifest.id !== id) warn(`${id}：widget.json 的 id=${manifest.id} 与目录名不一致`);
    if (manifest.builtin !== false) warn(`${id}：官方扩展示例也必须 builtin=false`);
    if (typeof manifest.license !== "string" || !manifest.license.trim()) {
      warn(`${id}：必须声明 license`);
    }
  } else if (existsSync(catalogPath)) {
    let catalog;
    try {
      catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    } catch (error) {
      warn(`${id}：catalog.json 不是合法 JSON（${error}）`);
      continue;
    }
    const scene = Array.isArray(catalog.scenes) ? catalog.scenes[0] : null;
    if (!scene || typeof scene !== "object") {
      warn(`${id}：catalog.json 缺少 scenes[0]`);
    } else {
      if (catalog.schemaVersion !== 1) warn(`${id}：catalog.json 的 schemaVersion 必须是 1`);
      if (!SCENE_ID.test(scene.id ?? "")) warn(`${id}：scene.id 非法（${scene.id}）`);
      if (typeof scene.license !== "string" || !scene.license.trim()) {
        warn(`${id}：scene 必须声明 license`);
      }
      if (typeof scene.entry !== "string" || !scene.entry.endsWith(".html")) {
        warn(`${id}：scene.entry 必须是 .html 相对路径`);
      }
    }
  } else {
    warn(`${id}：缺少 widget.json 或 catalog.json`);
    continue;
  }
  if (statSync(dir).isDirectory()) walk(dir);
}

if (errors.length > 0) {
  console.error("[extension:check] 失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`[extension:check] 通过：${ids.join(", ")}`);
