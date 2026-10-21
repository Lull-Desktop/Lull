/**
 * 内容目录校验：不依赖外部包，供 `pnpm content:check` 与 CI 使用。
 *
 * 校验范围：
 * - public/content/catalog.json 的 schemaVersion / scenes 结构；
 * - 场景清单必填字段、id / 版本 / capability / entry 安全性；
 * - entry 指向的静态文件确实存在；
 * - id 不重复。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "public", "content", "catalog.json");
const contentRoot = join(root, "public", "content");

const CAPABILITIES = new Set([
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
]);
const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/;

const errors = [];
const fail = (message) => errors.push(message);

let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
} catch (error) {
  console.error(`[content] 无法读取 ${catalogPath}: ${error.message}`);
  process.exit(1);
}

if (catalog.schemaVersion !== 1) {
  fail(`catalog.schemaVersion 必须是 1，实际 ${String(catalog.schemaVersion)}`);
}
if (!Array.isArray(catalog.scenes)) {
  fail("catalog.scenes 必须是数组");
}

const ids = new Set();
for (const [index, scene] of (catalog.scenes ?? []).entries()) {
  const where = `scenes[${index}]`;
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    fail(`${where} 必须是对象`);
    continue;
  }
  if (scene.schemaVersion !== 1) fail(`${where}.schemaVersion 必须是 1`);
  if (scene.type !== "scene") fail(`${where}.type 必须是 "scene"`);
  if (typeof scene.id !== "string" || !ID.test(scene.id)) {
    fail(`${where}.id 缺失或格式非法`);
  } else if (ids.has(scene.id)) {
    fail(`${where}.id 重复: ${scene.id}`);
  } else {
    ids.add(scene.id);
  }
  if (typeof scene.name !== "string" || scene.name.trim() === "") {
    fail(`${where}.name 必填`);
  }
  if (typeof scene.version !== "string" || !VERSION.test(scene.version)) {
    fail(`${where}.version 不是语义化版本`);
  }
  if (typeof scene.license !== "string" || scene.license.trim() === "") {
    fail(`${where}.license 必填`);
  }
  if (!Array.isArray(scene.capabilities) || scene.capabilities.length === 0) {
    fail(`${where}.capabilities 必须是非空数组`);
  } else {
    for (const capability of scene.capabilities) {
      if (!CAPABILITIES.has(capability)) {
        fail(`${where}.capabilities 含未知能力: ${String(capability)}`);
      }
    }
  }
  if (typeof scene.entry !== "string" || !ENTRY.test(scene.entry)) {
    fail(`${where}.entry 必须是内容根目录内的相对 .html 路径`);
    continue;
  }
  const file = join(contentRoot, scene.entry);
  if (!existsSync(file)) {
    fail(`${where}.entry 指向的文件不存在: ${scene.entry}`);
  }
}

if (errors.length > 0) {
  console.error("[content] 校验失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[content] OK：${catalog.scenes.length} 个外部场景（${[...ids].join(", ")}）`,
);
