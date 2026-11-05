/**
 * 游戏包（`examples/games/<name>`）的构建/打包共用校验。
 *
 * 与 Rust `game_package::manifest` / `extension::install` 的实际约束保持一致：
 * - 单文件 8 MiB、整包 64 MiB、最多 512 个文件（安装器当前实际预算）；
 * - id 小写、目录名必须等于 id（安装后按 id 定位）；
 * - entry.authority / entry.replica 必须是包内相对 `.html`；
 * - 隐藏点文件不入包（摘要与安装扫描都忽略点路径）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 512;

export const GAME_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/;
const COMMAND_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const PACKAGE_CAPABILITIES = new Set([
  "game.state.read",
  "game.state.write",
  "game.command.receive",
  "game.event.publish",
  "game.event.read",
  "game.render.publish",
  "game.network",
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "type",
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "hostApi",
  "entry",
  "engine",
  "runtime",
  "display",
  "capabilities",
  "commands",
  "events",
  "state",
  "network",
]);
const RENDER_MODES = new Set(["canvas2d", "webgl", "webgpu", "dom", "custom"]);

function rejectUnknown(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${label} 含未知字段：${key}`);
  }
}

export class GamePackageError extends Error {
  constructor(message) {
    super(message);
    this.name = "GamePackageError";
  }
}

function fail(message) {
  throw new GamePackageError(message);
}

/** 递归收集文件，跳过 dist/node_modules/.git 与所有点路径。 */
export function collectGameFiles(dir, relativeDir = "") {
  const files = [];
  for (const entry of readdirSync(join(dir, relativeDir), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    if (relativeDir === "" && entry.name === "dist") continue;
    if (relativeDir === "" && entry.name === "node_modules") continue;
    if (relativeDir === "" && entry.name === "build.mjs") continue;
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`包内不允许符号链接：${path}`);
    if (entry.isDirectory()) {
      files.push(...collectGameFiles(dir, path));
      continue;
    }
    if (entry.isFile()) {
      const size = statSync(join(dir, path)).size;
      if (size > MAX_FILE_BYTES) {
        fail(
          `${path} 超过单文件上限 ${MAX_FILE_BYTES / 1024 / 1024} MiB（实际 ${(size / 1024 / 1024).toFixed(1)} MiB）`,
        );
      }
      files.push({ name: path, size });
    }
  }
  return files;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function validateEntry(entry, label) {
  if (entry === undefined || entry === null) return;
  if (typeof entry !== "string" || !ENTRY.test(entry)) {
    fail(`${label} 必须是包内相对 .html：${String(entry)}`);
  }
}

/**
 * 校验游戏包目录并返回 manifest/预算摘要。
 * @param {string} dir
 * @param {{ expectDirName?: boolean }} [options]
 */
export function validateGamePackage(dir, options = {}) {
  const manifestPath = join(dir, "game.json");
  if (!existsSync(manifestPath)) fail(`缺少 game.json：${dir}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`解析 game.json 失败：${error.message}`);
  }
  if (manifest.schemaVersion !== 1) fail("schemaVersion 必须为 1");
  rejectUnknown(manifest, TOP_LEVEL_KEYS, "game.json");
  if (manifest.type !== "game") fail('type 必须为 "game"');
  if (!GAME_ID.test(manifest.id ?? "")) fail(`id 非法：${manifest.id}`);
  if (
    options.expectDirName === true &&
    manifest.id !== dir.split(/[\\/]/).pop()
  ) {
    fail(`目录名必须等于 id（目录 ${dir}，id ${manifest.id}）`);
  }
  if (!VERSION.test(manifest.version ?? "")) {
    fail(`version 非法：${manifest.version}`);
  }
  requireString(manifest.name, "name");
  requireString(manifest.license, "license");
  if (!Number.isInteger(manifest.hostApi) || manifest.hostApi < 1) {
    fail("hostApi 必须是正整数");
  }
  if (manifest.hostApi > 1) fail(`hostApi ${manifest.hostApi} 超出宿主 GAME_HOST_API=1`);

  const entry = manifest.entry ?? {};
  if (typeof entry !== "object" || Array.isArray(entry)) fail("entry 必须是对象");
  rejectUnknown(entry, new Set(["authority", "replica"]), "entry");
  validateEntry(entry.authority, "entry.authority");
  validateEntry(entry.replica, "entry.replica");
  if (!entry.authority) fail("entry.authority 必填");
  const authorityPath = join(dir, entry.authority);
  if (!existsSync(authorityPath)) fail(`entry.authority 不存在：${entry.authority}`);
  if (entry.replica && !existsSync(join(dir, entry.replica))) {
    fail(`entry.replica 不存在：${entry.replica}`);
  }

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    fail("capabilities 必须是非空数组");
  }
  const seenCapabilities = new Set();
  for (const capability of manifest.capabilities) {
    if (typeof capability !== "string") fail("capability 必须是字符串");
    if (!PACKAGE_CAPABILITIES.has(capability)) {
      fail(`未知或宿主保留的 capability：${capability}`);
    }
    if (seenCapabilities.has(capability)) fail(`capability 重复：${capability}`);
    seenCapabilities.add(capability);
  }

  const engine = manifest.engine ?? {};
  if (typeof engine !== "object" || Array.isArray(engine)) fail("engine 必须是对象");
  rejectUnknown(
    engine,
    new Set(["id", "version", "adapter", "renderMode"]),
    "engine",
  );
  if (engine.renderMode !== undefined && !RENDER_MODES.has(engine.renderMode)) {
    fail(`未知 engine.renderMode：${engine.renderMode}`);
  }

  const runtime = manifest.runtime ?? {};
  if (typeof runtime !== "object" || Array.isArray(runtime)) fail("runtime 必须是对象");
  rejectUnknown(
    runtime,
    new Set(["authority", "tickMs", "replicas", "maxReplicas", "commit"]),
    "runtime",
  );
  if (!["host-tick", "self-loop"].includes(runtime.authority)) {
    fail(`runtime.authority 非法：${runtime.authority}`);
  }
  if (
    runtime.tickMs !== undefined &&
    (!Number.isInteger(runtime.tickMs) || runtime.tickMs < 200 || runtime.tickMs > 60000)
  ) {
    fail("runtime.tickMs 必须是 200–60000 的整数");
  }
  if (
    runtime.maxReplicas !== undefined &&
    (!Number.isInteger(runtime.maxReplicas) ||
      runtime.maxReplicas < 1 ||
      runtime.maxReplicas > 16)
  ) {
    fail("runtime.maxReplicas 必须是 1–16 的整数");
  }
  if (runtime.commit !== undefined) {
    if (typeof runtime.commit !== "object" || Array.isArray(runtime.commit)) {
      fail("runtime.commit 必须是对象");
    }
    rejectUnknown(runtime.commit, new Set(["flushMs"]), "runtime.commit");
    if (
      runtime.commit.flushMs !== undefined &&
      (!Number.isInteger(runtime.commit.flushMs) ||
        runtime.commit.flushMs < 250 ||
        runtime.commit.flushMs > 10000)
    ) {
      fail("runtime.commit.flushMs 必须是 250–10000 的整数");
    }
  }

  const display = manifest.display ?? {};
  if (typeof display !== "object" || Array.isArray(display)) fail("display 必须是对象");
  rejectUnknown(display, new Set(["policy", "modes"]), "display");
  if (display.policy !== undefined && display.policy !== "shared") {
    fail("display.policy 只支持 shared");
  }
  if (display.modes !== undefined) {
    if (!Array.isArray(display.modes)) fail("display.modes 必须是数组");
    for (const mode of display.modes) {
      if (mode !== "mirror" && mode !== "span") {
        fail(`display.modes 含未知值：${mode}`);
      }
    }
  }

  for (const section of ["commands", "events"]) {
    const value = manifest[section] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) {
      fail(`${section} 必须是对象`);
    }
    for (const [key, declaration] of Object.entries(value)) {
      if (!COMMAND_KEY.test(key)) fail(`${section} 含非法键：${key}`);
      if (typeof declaration !== "object" || Array.isArray(declaration)) {
        fail(`${section}.${key} 必须是对象`);
      }
    }
  }

  const state = manifest.state ?? {};
  if (typeof state !== "object" || Array.isArray(state)) fail("state 必须是对象");
  rejectUnknown(state, new Set(["schemaVersion", "maxSizeBytes"]), "state");
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
    fail("state.schemaVersion 必须是正整数");
  }
  if (
    state.maxSizeBytes !== undefined &&
    (!Number.isInteger(state.maxSizeBytes) || state.maxSizeBytes > 8 * 1024 * 1024)
  ) {
    fail("state.maxSizeBytes 必须是 ≤8 MiB 的整数");
  }

  if (manifest.network !== undefined) {
    if (!Array.isArray(manifest.network)) fail("network 必须是数组");
    for (const origin of manifest.network) {
      if (typeof origin !== "string" || !/^(https|wss):\/\//.test(origin)) {
        fail(`network 只允许 https:// / wss:// 源：${origin}`);
      }
    }
  }

  const files = collectGameFiles(dir);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_FILES) {
    fail(`文件数 ${files.length} 超过上限 ${MAX_FILES}`);
  }
  if (bytes > MAX_TOTAL_BYTES) {
    fail(`整包 ${(bytes / 1024 / 1024).toFixed(1)} MiB 超过上限 64 MiB`);
  }
  if (!files.some((file) => file.name === entry.authority)) {
    fail(`entry.authority 必须位于包内：${entry.authority}`);
  }
  return { manifest, files, bytes };
}

/** 复制示例包到 dist（跳过 dist/node_modules/点路径），并做一次预算校验。 */
export function stageGamePackage(sourceDir, distDir) {
  validateGamePackage(sourceDir, { expectDirName: false });
  mkdirSync(distDir, { recursive: true });
  copyTree(sourceDir, distDir);
  const files = collectGameFiles(distDir);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, bytes };
}

function copyTree(sourceDir, targetDir, relativeDir = "") {
  for (const entry of readdirSync(join(sourceDir, relativeDir), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    if (relativeDir === "" && (entry.name === "dist" || entry.name === "node_modules")) {
      continue;
    }
    if (relativeDir === "" && entry.name === "build.mjs") continue;
    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const source = join(sourceDir, rel);
    const target = join(targetDir, rel);
    if (entry.isSymbolicLink()) {
      fail(`包内不允许符号链接：${rel}`);
    }
    if (entry.isDirectory()) {
      copyTree(sourceDir, targetDir, rel);
      continue;
    }
    if (entry.isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

/** 相对包根路径的安全校验（供脚本间复用）。 */
export function isSafeEntry(entry) {
  return typeof entry === "string" && ENTRY.test(entry);
}

export function packageName(dir) {
  return resolve(dir).split(/[\\/]/).pop();
}
