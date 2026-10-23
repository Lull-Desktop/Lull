#!/usr/bin/env node
/**
 * Widget 清单校验 + 逐窗口 Tauri capability 生成。
 *
 * 校验范围：
 * - `src/widgets/manifests/*.json` 的 schemaVersion / type / role / id / 版本；
 * - capability 白名单（直接读取 `src/sdk/widget/types.ts` 的枚举，避免两份白名单漂移）；
 * - `lib.rs` 注册的自定义命令与 `build.rs` 的 app ACL manifest 必须完全一致；
 * - 前端 `invoke("...")` 的字面命令名必须在注册表里；
 * - 每个窗口一份 capability：设置窗拿宿主管理命令，工具窗只拿自己的窗口帧命令。
 *
 * 用法：
 *   node scripts/gen-widgets.mjs          # 写入 capability 文件
 *   node scripts/gen-widgets.mjs --check  # 只校验，capability 过期则退出 1（CI 用）
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestDir = join(root, "src", "widgets", "manifests");
const typesPath = join(root, "src", "sdk", "widget", "types.ts");
const capabilityDir = join(root, "src-tauri", "capabilities");
const libRsPath = join(root, "src-tauri", "src", "lib.rs");
const buildRsPath = join(root, "src-tauri", "build.rs");
const checkOnly = process.argv.includes("--check");
const srcDir = join(root, "src");

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const WINDOW_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 所有窗口共享的 Tauri core 权限；按窗口拆分的是下面的 app 命令权限。 */
const CORE_PERMISSIONS = [
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

/** 工具窗只需要调整自己的窗口帧；创建/管理其他窗口是宿主能力。 */
const TOOL_APP_PERMISSIONS = ["allow-window-set-frame"];

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

/** 读取 `lib.rs` 里 `generate_handler!` 注册的自定义命令（snake_case）。 */
function readRegisteredCommands() {
  const source = readFileSync(libRsPath, "utf8");
  const block = source.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  return block
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((path) => path.split("::").pop());
}

/** 读取 `build.rs` 里 app ACL manifest 声明的命令。 */
function readAppManifestCommands() {
  const source = readFileSync(buildRsPath, "utf8");
  const block =
    source.match(/const APP_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ??
    "";
  return [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

/** 校验两份命令表一致：漏一个命令会在运行期被 ACL 拒绝，提前在 CI 暴露。 */
function checkCommandParity() {
  const registered = readRegisteredCommands();
  const manifest = readAppManifestCommands();
  if (registered.length === 0) {
    fail("无法从 src-tauri/src/lib.rs 读取 generate_handler! 命令列表");
  }
  if (manifest.length === 0) {
    fail("无法从 src-tauri/build.rs 读取 APP_COMMANDS");
  }
  const registeredSet = new Set(registered);
  const manifestSet = new Set(manifest);
  for (const command of registeredSet) {
    if (!manifestSet.has(command)) {
      fail(`命令 ${command} 已注册但未加入 build.rs 的 APP_COMMANDS`);
    }
  }
  for (const command of manifestSet) {
    if (!registeredSet.has(command)) {
      fail(`build.rs 的 APP_COMMANDS 含未注册命令: ${command}`);
    }
  }
  return [...registeredSet].sort();
}

/** 递归遍历 src，检查前端字面 invoke 的命令名都在注册表里。 */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.includes(".test.") || entry.name.endsWith(".d.ts")) continue;
    yield full;
  }
}

function checkFrontendInvokes(commands) {
  const known = new Set(commands);
  for (const file of sourceFiles(srcDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([^"]+)"/g)) {
      if (!known.has(match[1])) {
        fail(
          `${relative(root, file).replaceAll("\\", "/")} 调用了未注册命令 ${match[1]}`,
        );
      }
    }
  }
}

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
  for (const key of ["width", "height", "minWidth", "minHeight"]) {
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
  manifests.push({ ...manifest, file });
}

if (manifests.length === 0) {
  fail("src/widgets/manifests 下没有可用的 widget 清单");
}

const appCommands = checkCommandParity();
if (errors.length === 0) checkFrontendInvokes(appCommands);

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

/** 设置窗是宿主控制面，拿全部自定义命令；工具窗只拿自己的窗口帧权限。 */
function permissionsFor(manifest) {
  const permissions = new Set(CORE_PERMISSIONS);
  if (manifest.role === "shell") {
    for (const command of appCommands) {
      permissions.add(`allow-${command.replaceAll("_", "-")}`);
    }
  } else if (manifest.capabilities.includes("widget.chrome")) {
    for (const permission of TOOL_APP_PERMISSIONS) permissions.add(permission);
  }
  return [...permissions];
}

const generated = manifests.map((manifest) => {
  const fileName = `window-${manifest.window.label}.json`;
  const capability = {
    $schema: "../gen/schemas/desktop-schema.json",
    identifier: `window-${manifest.window.label}`,
    description: `Lull ${manifest.window.label} window (generated from src/widgets/manifests/${manifest.file}).`,
    windows: [manifest.window.label],
    permissions: permissionsFor(manifest),
  };
  return {
    path: join(capabilityDir, fileName),
    fileName,
    text: `${JSON.stringify(capability, null, 2)}\n`,
  };
});

// 所有第三方插件窗口共用一份 capability：只给 core 窗口能力与状态命令，
// 不给包管理命令；iframe 本身没有 Tauri IPC。
const pluginShellCapability = {
  $schema: "../gen/schemas/desktop-schema.json",
  identifier: "window-widgets",
  description:
    "Third-party widget windows (label widget-*). Generated by scripts/gen-widgets.mjs — do not edit by hand.",
  windows: ["widget-*"],
  permissions: [
    "core:window:allow-start-dragging",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-minimize",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-widget-state-get",
    "allow-widget-state-set",
    "allow-widget-state-remove",
    "allow-widget-package-notify",
    "allow-widget-set-transparent",
  ],
};
generated.push({
  path: join(capabilityDir, "window-widgets.json"),
  fileName: "window-widgets.json",
  text: `${JSON.stringify(pluginShellCapability, null, 2)}\n`,
});

// 壁纸窗口（label wallpaper-*）：只允许「列出已安装内容包」与事件订阅。
// 场景切换走 location.hash（不重载页面），壁纸窗必须自己解析场景 id，
// 所以这里要能读到用户内容包目录；除此之外不给任何窗口/壁纸/插件命令。
// 外部场景跑在 sandbox="" 的 iframe 里（不执行 JS），因此这条权限不落到第三方内容上。
const wallpaperCapability = {
  $schema: "../gen/schemas/desktop-schema.json",
  identifier: "window-wallpaper",
  description:
    "Wallpaper windows (label wallpaper-*): read-only content catalog + event subscription. Generated by scripts/gen-widgets.mjs — do not edit by hand.",
  windows: ["wallpaper-*"],
  permissions: [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-content-packages",
  ],
};
generated.push({
  path: join(capabilityDir, "window-wallpaper.json"),
  fileName: "window-wallpaper.json",
  text: `${JSON.stringify(wallpaperCapability, null, 2)}\n`,
});

const expectedNames = new Set(generated.map((file) => file.fileName));

if (checkOnly) {
  let existing = [];
  try {
    existing = readdirSync(capabilityDir);
  } catch {
    fail(`缺少 ${capabilityDir}，请先运行 pnpm widgets:gen`);
  }
  for (const file of generated) {
    let current = "";
    try {
      current = readFileSync(file.path, "utf8");
    } catch {
      fail(`缺少 ${file.fileName}，请先运行 pnpm widgets:gen`);
      continue;
    }
    if (current !== file.text) {
      fail(`${file.fileName} 与清单不一致，请运行 pnpm widgets:gen`);
    }
  }
  for (const name of existing) {
    if (
      name.endsWith(".json") &&
      name.startsWith("window-") &&
      !expectedNames.has(name)
    ) {
      fail(`发现过期 capability: ${name}，请运行 pnpm widgets:gen`);
    }
    if (name === "desktop.json") {
      fail("desktop.json 是旧版单文件 capability，请运行 pnpm widgets:gen");
    }
  }
  if (errors.length > 0) {
    console.error("[widgets] 校验失败：");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `[widgets] OK：${manifests.length} 个窗口清单，逐窗口 capability 已同步`,
  );
  process.exit(0);
}

for (const file of generated) {
  writeFileSync(file.path, file.text);
  console.log(`[widgets] 写入 ${file.fileName}`);
}
for (const name of readdirSync(capabilityDir)) {
  if (name.endsWith(".json") && name.startsWith("window-")) {
    if (!expectedNames.has(name)) {
      rmSync(join(capabilityDir, name));
      console.log(`[widgets] 删除过期 ${name}`);
    }
  }
  if (name === "desktop.json") {
    rmSync(join(capabilityDir, name));
    console.log("[widgets] 删除旧版 desktop.json");
  }
}
console.log(
  `[widgets] 已生成 ${generated.length} 份 capability（${manifests
    .map((manifest) => manifest.window.label)
    .join(", ")}）`,
);
