#!/usr/bin/env node
/**
 * Widget 清单校验 + Tauri capability 生成。
 *
 * 校验范围：
 * - `src/widgets/manifests/*.json` 的 schemaVersion / type / role / id / 版本；
 * - capability 白名单（直接读取 `src/sdk/widget/types.ts` 的枚举，避免两份白名单漂移）；
 * - 窗口尺寸、缩放/透明策略与 id / label / route 唯一性；
 * - 生成 `src-tauri/capabilities/desktop.json` 的窗口授权列表。
 *
 * 用法：
 *   node scripts/gen-widgets.mjs          # 写入 capability 文件
 *   node scripts/gen-widgets.mjs --check  # 只校验，capability 过期则退出 1（CI 用）
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestDir = join(root, "src", "widgets", "manifests");
const typesPath = join(root, "src", "sdk", "widget", "types.ts");
const capabilityPath = join(root, "src-tauri", "capabilities", "desktop.json");
const checkOnly = process.argv.includes("--check");

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const WINDOW_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 与手写时代保持一致的窗口权限集合；按能力细分留给第三方阶段。 */
const WINDOW_PERMISSIONS = [
  "core:default",
  "opener:default",
  "core:window:allow-start-dragging",
  "core:window:allow-hide",
  "core:window:allow-show",
  "core:window:allow-set-focus",
  "core:window:allow-minimize",
  "core:window:allow-set-resizable",
  "core:window:allow-set-size",
  "core:window:allow-outer-position",
  "core:window:allow-set-position",
];

const errors = [];
const fail = (message) => errors.push(message);

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 从 TypeScript 源码里读枚举，保证清单校验与 SDK 使用同一份能力表。 */
function readEnum(name) {
  const source = readFileSync(typesPath, "utf8");
  const pattern = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
  );
  const match = source.match(pattern);
  if (!match) {
    fail(`无法从 src/sdk/widget/types.ts 读取 ${name}`);
    return new Set();
  }
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

const capabilities = readEnum("WIDGET_CAPABILITIES");
const roles = readEnum("WIDGET_ROLES");

function checkWindow(window, where) {
  if (!isObject(window)) {
    fail(`${where}.window 必须是对象`);
    return;
  }
  for (const key of ["label", "route", "title"]) {
    if (typeof window[key] !== "string" || window[key].trim() === "") {
      fail(`${where}.window.${key} 必填`);
    }
  }
  for (const key of ["label", "route"]) {
    if (typeof window[key] === "string" && !WINDOW_KEY.test(window[key])) {
      fail(`${where}.window.${key} 格式非法: ${window[key]}`);
    }
  }
  const numbers = ["width", "height", "minWidth", "minHeight"];
  for (const key of numbers) {
    if (
      typeof window[key] !== "number" ||
      !Number.isFinite(window[key]) ||
      window[key] <= 0
    ) {
      fail(`${where}.window.${key} 必须是正数`);
    }
  }
  if (
    typeof window.minWidth === "number" &&
    typeof window.width === "number" &&
    window.minWidth > window.width
  ) {
    fail(`${where}.window.minWidth 不能大于 width`);
  }
  if (
    typeof window.minHeight === "number" &&
    typeof window.height === "number" &&
    window.minHeight > window.height
  ) {
    fail(`${where}.window.minHeight 不能大于 height`);
  }
  for (const key of ["resizable", "transparent"]) {
    if (typeof window[key] !== "boolean") {
      fail(`${where}.window.${key} 必须是布尔值`);
    }
  }
}

const manifests = [];
const seenIds = new Set();
const seenLabels = new Set();
const seenRoutes = new Set();

for (const file of readdirSync(manifestDir).filter((name) =>
  name.endsWith(".json"),
)) {
  const where = `src/widgets/manifests/${file}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(manifestDir, file), "utf8"));
  } catch (error) {
    fail(`${where} 不是合法 JSON: ${String(error)}`);
    continue;
  }
  if (!isObject(manifest)) {
    fail(`${where} 必须是 JSON 对象`);
    continue;
  }
  if (manifest.schemaVersion !== 1) {
    fail(`${where}.schemaVersion 必须是 1`);
  }
  if (manifest.type !== "widget") {
    fail(`${where}.type 必须是 "widget"`);
  }
  if (!roles.has(manifest.role)) {
    fail(`${where}.role 必须是 ${[...roles].join(" / ")}`);
  }
  if (typeof manifest.id !== "string" || !ID.test(manifest.id)) {
    fail(`${where}.id 缺失或格式非法`);
  } else if (seenIds.has(manifest.id)) {
    fail(`${where}.id 重复: ${manifest.id}`);
  } else {
    seenIds.add(manifest.id);
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    fail(`${where}.name 必填`);
  }
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
    fail(`${where}.version 不是语义化版本`);
  }
  if (typeof manifest.license !== "string" || manifest.license.trim() === "") {
    fail(`${where}.license 必填`);
  }
  if (manifest.builtin !== true) {
    fail(`${where}.builtin 首期必须是 true`);
  }
  if (
    manifest.order !== undefined &&
    (typeof manifest.order !== "number" || !Number.isFinite(manifest.order))
  ) {
    fail(`${where}.order 必须是数字或省略`);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    fail(`${where}.capabilities 必须是非空数组`);
  } else {
    const declared = new Set();
    for (const capability of manifest.capabilities) {
      if (!capabilities.has(capability)) {
        fail(`${where}.capabilities 含未知能力: ${String(capability)}`);
      }
      if (declared.has(capability)) {
        fail(`${where}.capabilities 重复: ${String(capability)}`);
      }
      declared.add(capability);
    }
  }
  if (isObject(manifest.window)) {
    if (typeof manifest.window.label === "string") {
      if (seenLabels.has(manifest.window.label)) {
        fail(`${where}.window.label 重复: ${manifest.window.label}`);
      }
      seenLabels.add(manifest.window.label);
    }
    if (typeof manifest.window.route === "string") {
      if (seenRoutes.has(manifest.window.route)) {
        fail(`${where}.window.route 重复: ${manifest.window.route}`);
      }
      seenRoutes.add(manifest.window.route);
    }
  }
  checkWindow(manifest.window, where);
  manifests.push(manifest);
}

if (manifests.length === 0) {
  fail("src/widgets/manifests 下没有可用的 widget 清单");
}

if (errors.length > 0) {
  console.error("[widgets] 校验失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

manifests.sort(
  (left, right) =>
    (left.order ?? 100) - (right.order ?? 100) ||
    left.id.localeCompare(right.id),
);

const capability = {
  $schema: "../gen/schemas/desktop-schema.json",
  identifier: "desktop",
  description:
    "Lull desktop windows: settings, player, pomodoro, noise. Generated from src/widgets/manifests by scripts/gen-widgets.mjs — do not edit by hand.",
  windows: manifests.map((manifest) => manifest.window.label),
  permissions: WINDOW_PERMISSIONS,
};

const expected = `${JSON.stringify(capability, null, 2)}\n`;

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(capabilityPath, "utf8");
  } catch {
    fail(`缺少 ${capabilityPath}，请先运行 pnpm widgets:gen`);
  }
  if (current !== expected) {
    fail("src-tauri/capabilities/desktop.json 与清单不一致，请运行 pnpm widgets:gen");
  }
  if (errors.length > 0) {
    console.error("[widgets] 校验失败：");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `[widgets] OK：${manifests.length} 个窗口清单，capability 已同步`,
  );
  process.exit(0);
}

writeFileSync(capabilityPath, expected);
console.log(
  `[widgets] 已生成 ${capabilityPath}（${manifests.length} 个窗口：${manifests
    .map((manifest) => manifest.window.label)
    .join(", ")}）`,
);
