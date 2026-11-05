/**
 * 游戏包（`examples/games/<name>`）的构建/打包共用校验。
 *
 * 与 Rust `game_package::manifest` / `extension::install` 的实际约束保持一致：
 * - 单文件 16 MiB、整包 128 MiB、最多 1024 个文件（游戏包预算；引擎与贴图）；
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

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_FILES = 1024;

export const GAME_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** Widget id 的规则比游戏更窄：小写字母开头、只允许小写数字与连字符、2–32 字符。 */
export const WIDGET_ID = /^[a-z][a-z0-9-]{1,31}$/;
/** 控制器槽位 id：小写字母开头、1–32 字符、只允许小写数字与连字符。 */
export const CONTROLLER_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/;
const COMMAND_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROLLER_KEYS = new Set([
  "id",
  "label",
  "entry",
  "widgetId",
  "commands",
  "events",
  "window",
  "autoOpen",
]);
const CONTROLLER_WINDOW_KEYS = new Set([
  "width",
  "height",
  "minWidth",
  "minHeight",
  "resizable",
  "alwaysOnTop",
]);
export const MAX_CONTROLLERS = 8;
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
  "controller",
  "controllers",
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

function validateController(controller, options) {
  const { label, dir, commandKeys, eventKeys } = options;
  if (typeof controller !== "object" || controller === null || Array.isArray(controller)) {
    fail(`${label} 必须是对象`);
  }
  rejectUnknown(controller, CONTROLLER_KEYS, label);
  if (!CONTROLLER_ID.test(controller.id ?? "")) {
    fail(`${label}.id 非法：${controller.id}`);
  }
  const hasEntry = controller.entry !== undefined;
  const hasWidget = controller.widgetId !== undefined;
  if (hasEntry === hasWidget) {
    fail(`${label} 必须且只能声明 entry 或 widgetId 之一`);
  }
  if (hasEntry) {
    if (
      typeof controller.entry !== "string" ||
      !ENTRY.test(controller.entry) ||
      !controller.entry.startsWith("controllers/")
    ) {
      fail(`${label}.entry 必须是 controllers/ 下的包内相对 .html`);
    }
    if (!existsSync(join(dir, controller.entry))) {
      fail(`${label}.entry 不存在：${controller.entry}`);
    }
  }
  if (hasWidget && !WIDGET_ID.test(controller.widgetId ?? "")) {
    fail(`${label}.widgetId 非法：${controller.widgetId}`);
  }
  if (
    controller.label !== undefined &&
    (typeof controller.label !== "string" ||
      controller.label.trim() === "" ||
      controller.label.length > 64)
  ) {
    fail(`${label}.label 必须是 1-64 字符`);
  }
  for (const section of ["commands", "events"]) {
    const value = controller[section];
    if (value === undefined) continue;
    if (!Array.isArray(value)) fail(`${label}.${section} 必须是数组`);
    const declared = section === "commands" ? commandKeys : eventKeys;
    const seen = new Set();
    for (const entry of value) {
      if (typeof entry !== "string" || !COMMAND_KEY.test(entry)) {
        fail(`${label}.${section} 含非法键：${entry}`);
      }
      if (!declared.has(entry)) {
        fail(`${label}.${section} 含未声明项：${entry}`);
      }
      if (seen.has(entry)) fail(`${label}.${section} 重复：${entry}`);
      seen.add(entry);
    }
  }
  if (controller.autoOpen !== undefined && typeof controller.autoOpen !== "boolean") {
    fail(`${label}.autoOpen 必须是布尔值`);
  }
  if (controller.window !== undefined) {
    const window = controller.window;
    if (typeof window !== "object" || window === null || Array.isArray(window)) {
      fail(`${label}.window 必须是对象`);
    }
    rejectUnknown(window, CONTROLLER_WINDOW_KEYS, `${label}.window`);
    const width = window.width ?? 360;
    const height = window.height ?? 420;
    if (!Number.isFinite(width) || width < 240 || width > 1600) {
      fail(`${label}.window.width 必须在 240–1600 之间`);
    }
    if (!Number.isFinite(height) || height < 200 || height > 1200) {
      fail(`${label}.window.height 必须在 200–1200 之间`);
    }
    if (
      window.minWidth !== undefined &&
      (!Number.isFinite(window.minWidth) ||
        window.minWidth < 240 ||
        window.minWidth > width)
    ) {
      fail(`${label}.window.minWidth 必须在 240 到 width 之间`);
    }
    if (
      window.minHeight !== undefined &&
      (!Number.isFinite(window.minHeight) ||
        window.minHeight < 200 ||
        window.minHeight > height)
    ) {
      fail(`${label}.window.minHeight 必须在 200 到 height 之间`);
    }
    for (const key of ["resizable", "alwaysOnTop"]) {
      if (window[key] !== undefined && typeof window[key] !== "boolean") {
        fail(`${label}.window.${key} 必须是布尔值`);
      }
    }
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

  // Rust 侧 `commands` 没有 serde 默认值：缺字段会在安装/启动时被判为 invalid，
  // 无命令的游戏必须显式写 `"commands": {}`。
  if (!Object.hasOwn(manifest, "commands")) {
    fail('缺少 commands：无命令时也必须写 "commands": {}');
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

  const commandKeys = new Set(Object.keys(manifest.commands ?? {}));
  const eventKeys = new Set(Object.keys(manifest.events ?? {}));

  // 控制器窗口：包内页面（entry）或外部 Widget（widgetId）二选一；与 Rust
  // `GameManifest::validate` 的规则保持一致。
  if (manifest.controllers !== undefined) {
    if (!Array.isArray(manifest.controllers) || manifest.controllers.length === 0) {
      fail("controllers 必须是非空数组");
    }
    if (manifest.controllers.length > MAX_CONTROLLERS) {
      fail(`controllers 最多声明 ${MAX_CONTROLLERS} 个`);
    }
    if (manifest.controller !== undefined) {
      fail("controller 与 controllers 不能同时声明");
    }
    const ids = new Set();
    const widgets = new Set();
    manifest.controllers.forEach((controller, index) => {
      validateController(controller, {
        label: `controllers[${index}]`,
        dir,
        commandKeys,
        eventKeys,
      });
      if (ids.has(controller.id)) fail(`controllers.id 重复：${controller.id}`);
      ids.add(controller.id);
      if (controller.widgetId !== undefined) {
        if (widgets.has(controller.widgetId)) {
          fail(`同一个游戏不能重复声明控制器 Widget：${controller.widgetId}`);
        }
        widgets.add(controller.widgetId);
      }
    });
  }

  // 旧的单数 controller：仅 widgetId / label，归一化由 Rust 完成。
  if (manifest.controller !== undefined) {
    const controller = manifest.controller;
    if (typeof controller !== "object" || Array.isArray(controller)) {
      fail("controller 必须是对象");
    }
    rejectUnknown(controller, new Set(["widgetId", "label"]), "controller");
    if (!WIDGET_ID.test(controller.widgetId ?? "")) {
      fail(`controller.widgetId 非法：${controller.widgetId}`);
    }
    if (
      controller.label !== undefined &&
      (typeof controller.label !== "string" ||
        controller.label.trim() === "" ||
        controller.label.length > 64)
    ) {
      fail("controller.label 必须是 1-64 字符");
    }
  }

  const state = manifest.state ?? {};
  if (typeof state !== "object" || Array.isArray(state)) fail("state 必须是对象");
  rejectUnknown(state, new Set(["schemaVersion", "maxSizeBytes"]), "state");  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
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
    fail(
      `整包 ${(bytes / 1024 / 1024).toFixed(1)} MiB 超过上限 ${MAX_TOTAL_BYTES / 1024 / 1024} MiB`,
    );
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
