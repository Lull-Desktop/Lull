#!/usr/bin/env node
/**
 * 构建官方扩展：`extensions/official/<dir>/` → `extensions/dist/<id>/`。
 *
 * 支持两种包：
 *   widget：widget.json + index.html → 标准 widget 包 + `.lull-integrity.json`
 *   scene ：catalog.json + index.html（Vite 入口）→ 内容包（catalog.json 内写 integrity）
 *
 * 产物：
 *   extensions/dist/<id>/ …（widget 在包根；scene 在 catalog.json 指定的入口目录）
 *   extensions/dist/index.json  # 供诊断与 CI 断言（含 kind）
 *
 * 用法：
 *   node scripts/build-official-extensions.mjs [dir|id ...] [--check]
 *
 * `--check` 不重建，只校验产物与源码/摘要一致，供 CI 使用。
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { computePackageDigest } from "./content-digest.mjs";
import { createExtensionConfig } from "./lib/extension-vite.config.mjs";
import { ensureSdkDist } from "./lib/sdk-dist.mjs";
import {
  computeWidgetDigest,
  WIDGET_INTEGRITY_FILE,
  writeWidgetIntegrity,
} from "./lib/widget-digest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialRoot = join(repoRoot, "extensions", "official");
const distRoot = join(repoRoot, "extensions", "dist");
const validator = join(
  repoRoot,
  "Skill",
  "lull-extension",
  "bin",
  "lull-ext.mjs",
);
const WIDGET_ID = /^[a-z][a-z0-9-]{1,31}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TEXT_FILE = /\.(html|js|mjs|css|json|map)$/i;
const SCENE_ORDER = 20;

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const requested = args.filter((arg) => !arg.startsWith("--"));

function fail(message) {
  console.error(`[extensions] ${message}`);
  process.exit(1);
}

function appVersion() {
  const conf = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  if (!conf.version) fail("src-tauri/tauri.conf.json 缺少 version");
  return conf.version;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} 不是合法 JSON：${error}`);
  }
}

function safeSceneEntry(entry) {
  if (typeof entry !== "string") return false;
  if (entry.startsWith("/") || entry.includes("\\")) return false;
  if (entry.includes("%") || entry.includes("\0")) return false;
  if (!entry.endsWith(".html")) return false;
  const segments = entry.split("/");
  if (segments.length < 2 || segments.length > 6) return false;
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function sceneDirFor(entry) {
  return entry.split("/").slice(0, -1).join("/");
}

/** 读取 widget 源清单。 */
function readWidgetManifest(dir) {
  const path = join(dir, "widget.json");
  if (!existsSync(path)) fail(`缺少 widget.json：${dir}`);
  const manifest = readJson(path);
  if (!WIDGET_ID.test(manifest.id ?? "")) fail(`${path} 的 id 非法`);
  if (!VERSION.test(manifest.version ?? "")) fail(`${path} 的 version 非法`);
  if (manifest.builtin !== false) fail(`${path} 必须是 builtin=false`);
  if (typeof manifest.license !== "string" || !manifest.license.trim()) {
    fail(`${path} 必须声明 license`);
  }
  if (typeof manifest.entry !== "string" || !manifest.entry.endsWith(".html")) {
    fail(`${path} 的 entry 必须是包内 .html`);
  }
  return manifest;
}

/** 读取 scene 源清单；integrity 不要求在源码里（构建时写入产物）。 */
function readSceneSource(dir) {
  const path = join(dir, "catalog.json");
  if (!existsSync(path)) fail(`缺少 catalog.json：${dir}`);
  const catalog = readJson(path);
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    fail(`${path} 必须是 JSON 对象`);
  }
  if (catalog.schemaVersion !== 1) fail(`${path} 的 schemaVersion 必须是 1`);
  if (!Array.isArray(catalog.scenes) || catalog.scenes.length !== 1) {
    fail(`${path} 的 scenes 必须恰好一条（v1 内容包限制）`);
  }
  const scene = catalog.scenes[0];
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    fail(`${path} 的 scenes[0] 必须是对象`);
  }
  if (!SCENE_ID.test(scene.id ?? "")) fail(`${path} 的 id 非法`);
  if (!VERSION.test(scene.version ?? "")) fail(`${path} 的 version 非法`);
  if (typeof scene.license !== "string" || !scene.license.trim()) {
    fail(`${path} 必须声明 license`);
  }
  if (!safeSceneEntry(scene.entry)) {
    fail(`${path} 的 entry 必须是安全相对路径下的 .html（例如 scenes/bamboo/index.html）`);
  }
  if (!existsSync(join(dir, "index.html"))) {
    fail(`${dir} 缺少 index.html（场景的 Vite 入口）`);
  }
  return { catalog, scene };
}

/** 扫描官方扩展源码目录，返回 dir / kind / 产物 id 等描述。 */
function officialExtensions() {
  if (!existsSync(officialRoot)) return [];
  const found = [];
  for (const entry of readdirSync(officialRoot, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith("_") ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const sourceDir = join(officialRoot, entry.name);
    if (existsSync(join(sourceDir, "widget.json"))) {
      const manifest = readWidgetManifest(sourceDir);
      found.push({
        dir: entry.name,
        kind: "widget",
        id: manifest.id,
        version: manifest.version,
        order: manifest.order ?? 100,
        sourceDir,
        manifest,
      });
      continue;
    }
    if (existsSync(join(sourceDir, "catalog.json"))) {
      const { catalog, scene } = readSceneSource(sourceDir);
      found.push({
        dir: entry.name,
        kind: "scene",
        id: scene.id,
        version: scene.version,
        order: SCENE_ORDER,
        sourceDir,
        catalog,
        scene,
      });
      continue;
    }
    fail(
      `${entry.name} 缺少 widget.json 或 catalog.json，无法判断扩展类型`,
    );
  }
  return found;
}

function selectExtensions() {
  const all = officialExtensions();
  if (requested.length === 0) {
    if (all.length === 0) {
      fail("extensions/official 下没有可构建的扩展");
    }
    return all;
  }
  const matched = all.filter((ext) =>
    requested.some((arg) => arg === ext.dir || arg === ext.id),
  );
  const matchedKeys = new Set(matched.flatMap((ext) => [ext.dir, ext.id]));
  const missing = requested.filter((id) => !matchedKeys.has(id));
  if (missing.length > 0) fail(`未知官方扩展：${missing.join(", ")}`);
  return matched;
}

function runValidator(dir, id) {
  if (!existsSync(validator)) {
    fail(`找不到扩展校验器：${validator}`);
  }
  const result = spawnSync(
    process.execPath,
    [validator, "validate", dir, "--strict"],
    { encoding: "utf8", cwd: repoRoot },
  );
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(`扩展 ${id} 未通过 strict 校验：\n${output}`);
  }
}

function scanBuiltPackage(dir, id) {
  const walk = (current, relative = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".lull-dev.json" || entry.name === "dev.json") {
        fail(`${id} 的构建产物包含开发配置：${path}`);
      }
      if (entry.isDirectory()) {
        walk(join(current, entry.name), path);
        continue;
      }
      if (!TEXT_FILE.test(entry.name)) continue;
      const text = readFileSync(join(current, entry.name), "utf8");
      // 任何文件里都不允许本机开发地址；但 lullwidget.localhost 是宿主源，放行。
      if (/(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)\b/.test(text)) {
        fail(`${id} 的产物 ${path} 含不应发布的开发地址`);
      }
      // HTML/CSS 里不允许远程资源；JS 里的文档链接 / SVG 命名空间不是资源请求，放过。
      if (!/\.(html|css)$/i.test(entry.name)) continue;
      const urls = text.match(/(?:https?|wss?):\/\/[^\s"'`<>)]+/g) ?? [];
      for (const url of urls) {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          fail(`${id} 的产物 ${path} 含非法 URL：${url}`);
        }
        const isWidgetOrigin =
          (parsed.protocol === "http:" &&
            parsed.hostname === "lullwidget.localhost") ||
          (parsed.protocol === "lullwidget:" &&
            parsed.hostname === "localhost");
        // data:image/svg+xml 里的 XML 命名空间不是资源请求。
        const isXmlNamespace =
          parsed.protocol === "http:" &&
          parsed.hostname === "www.w3.org" &&
          ["/2000/svg", "/1999/xlink", "/1999/xhtml"].includes(
            parsed.pathname,
          );
        if (!isWidgetOrigin && !isXmlNamespace) {
          fail(`${id} 的产物 ${path} 含不应发布的远程资源：${url}`);
        }
      }
    }
  };
  walk(dir);
}

function readIntegrity(dir) {
  const path = join(dir, WIDGET_INTEGRITY_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${dir} 的 ${WIDGET_INTEGRITY_FILE} 不是合法 JSON：${error}`);
  }
}

function buildWidget(ext) {
  const outDir = join(distRoot, ext.id);
  readManifestEntry(ext);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  return buildWidgetInto(ext, outDir);
}

function readManifestEntry(ext) {
  if (!existsSync(join(ext.sourceDir, ext.manifest.entry))) {
    fail(`${ext.id} 的 entry 不存在：${ext.manifest.entry}`);
  }
}

async function buildWidgetInto(ext, outDir) {
  await build(
    createExtensionConfig({
      repoRoot,
      extensionDir: ext.sourceDir,
      outDir,
    }),
  );
  // 清单不进 Vite 的入口图，手动复制；assets/ 额外复制（public/ 由 Vite 处理）。
  cpSync(join(ext.sourceDir, "widget.json"), join(outDir, "widget.json"));
  if (existsSync(join(ext.sourceDir, "assets"))) {
    cpSync(join(ext.sourceDir, "assets"), join(outDir, "assets"), {
      recursive: true,
    });
  }

  runValidator(outDir, ext.id);
  scanBuiltPackage(outDir, ext.id);
  const { digest } = writeWidgetIntegrity(
    outDir,
    ext.id,
    ext.version,
    "declared",
  );
  console.log(
    `[extensions] widget ${ext.id}@${ext.version} → extensions/dist/${ext.id} (${digest.slice(0, 12)}…)`,
  );
  return {
    kind: "widget",
    id: ext.id,
    version: ext.version,
    order: ext.order,
    provides: ext.manifest.provides ?? [],
    digest,
  };
}

function buildScene(ext) {
  const outRoot = join(distRoot, ext.id);
  const entryDir = sceneDirFor(ext.scene.entry);
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(join(outRoot, ...entryDir.split("/")), { recursive: true });
  return buildSceneInto(ext, outRoot, entryDir);
}

async function buildSceneInto(ext, outRoot, entryDir) {
  const sceneOutDir = join(outRoot, ...entryDir.split("/"));
  await build(
    createExtensionConfig({
      repoRoot,
      extensionDir: ext.sourceDir,
      outDir: sceneOutDir,
    }),
  );
  const entryPath = join(outRoot, ...ext.scene.entry.split("/"));
  if (!existsSync(entryPath)) {
    fail(`${ext.id} 构建后缺少 entry：${ext.scene.entry}`);
  }

  const catalogPath = join(ext.sourceDir, "catalog.json");
  const catalog = readJson(catalogPath);
  cpSync(catalogPath, join(outRoot, "catalog.json"));
  const digest = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: sceneOutDir,
  });
  const scene = catalog.scenes?.[0];
  if (!scene) fail(`${ext.id} 的 catalog.json 缺少 scenes[0]`);
  scene.integrity = { algorithm: "sha256", scope: "package", digest };
  writeFileSync(
    join(outRoot, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );

  runValidator(outRoot, ext.id);
  scanBuiltPackage(outRoot, ext.id);
  console.log(
    `[extensions] scene ${ext.id}@${ext.version} → extensions/dist/${ext.id} (${digest.slice(0, 12)}…)`,
  );
  return {
    kind: "scene",
    id: ext.id,
    version: ext.version,
    order: ext.order,
    digest,
  };
}

async function buildOne(ext) {
  return ext.kind === "widget" ? buildWidget(ext) : buildScene(ext);
}

function checkWidget(ext) {
  const outDir = join(distRoot, ext.id);
  if (!existsSync(join(outDir, ext.manifest.entry))) {
    fail(`${ext.id} 尚未构建：先执行 pnpm extensions:build`);
  }
  const builtManifest = readWidgetManifest(outDir);
  if (JSON.stringify(builtManifest) !== JSON.stringify(ext.manifest)) {
    fail(`${ext.id} 的产物清单与源码不一致：重新执行 pnpm extensions:build`);
  }
  const record = readIntegrity(outDir);
  if (!record) fail(`${ext.id} 缺少 ${WIDGET_INTEGRITY_FILE}`);
  if (
    record.schemaVersion !== 1 ||
    record.algorithm !== "sha256" ||
    record.scope !== "package" ||
    record.source !== "declared"
  ) {
    fail(`${ext.id} 的摘要锁字段不符合约定`);
  }
  const digest = computeWidgetDigest(outDir, ext.id, ext.version);
  if (record.digest !== digest) {
    fail(`${ext.id} 的摘要不匹配：产物被改动过，重新构建`);
  }
  runValidator(outDir, ext.id);
  scanBuiltPackage(outDir, ext.id);
  return {
    kind: "widget",
    id: ext.id,
    version: ext.version,
    order: ext.order,
    provides: ext.manifest.provides ?? [],
    digest,
  };
}

function stripIntegrity(scene) {
  const copy = { ...scene };
  delete copy.integrity;
  return copy;
}

function checkScene(ext) {
  const outRoot = join(distRoot, ext.id);
  const catalogPath = join(outRoot, "catalog.json");
  if (!existsSync(catalogPath)) {
    fail(`${ext.id} 尚未构建：先执行 pnpm extensions:build`);
  }
  const builtCatalog = readJson(catalogPath);
  const builtScene = builtCatalog.scenes?.[0];
  if (!builtScene || typeof builtScene !== "object") {
    fail(`${ext.id} 的产物 catalog.json 缺少 scenes[0]`);
  }
  if (
    JSON.stringify(stripIntegrity(builtScene)) !==
    JSON.stringify(stripIntegrity(ext.scene))
  ) {
    fail(`${ext.id} 的产物清单与源码不一致：重新执行 pnpm extensions:build`);
  }
  const entryPath = join(outRoot, ...ext.scene.entry.split("/"));
  if (!existsSync(entryPath)) {
    fail(`${ext.id} 尚未构建：缺少 entry ${ext.scene.entry}`);
  }
  const entryDir = join(outRoot, ...sceneDirFor(ext.scene.entry).split("/"));
  const digest = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: entryDir,
  });
  if (builtScene.integrity?.digest !== digest) {
    fail(`${ext.id} 的 integrity 不匹配：产物被改动过，重新构建`);
  }
  runValidator(outRoot, ext.id);
  scanBuiltPackage(outRoot, ext.id);
  return {
    kind: "scene",
    id: ext.id,
    version: ext.version,
    order: ext.order,
    digest,
  };
}

function checkOne(ext) {
  return ext.kind === "widget" ? checkWidget(ext) : checkScene(ext);
}

function writeIndex(entries) {
  const index = {
    schemaVersion: 1,
    builtFor: appVersion(),
    extensions: entries
      .slice()
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
  };
  writeFileSync(
    join(distRoot, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
}

/** 单包构建时保留其他已构建包的索引，避免索引被裁成一份。 */
function mergeExistingIndex(entries) {
  const indexPath = join(distRoot, "index.json");
  if (!existsSync(indexPath)) return entries;
  const existing = readJson(indexPath);
  const byId = new Map(
    (existing.extensions ?? [])
      .filter((entry) => existsSync(join(distRoot, entry.id)))
      .map((entry) => [entry.id, entry]),
  );
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

const extensions = selectExtensions();
mkdirSync(distRoot, { recursive: true });

if (checkOnly) {
  const entries = extensions.map(checkOne);
  const indexPath = join(distRoot, "index.json");
  if (!existsSync(indexPath)) fail("缺少 extensions/dist/index.json");
  const index = readJson(indexPath);
  for (const entry of entries) {
    const found = index.extensions?.find((item) => item.id === entry.id);
    if (
      !found ||
      found.digest !== entry.digest ||
      found.version !== entry.version ||
      found.kind !== entry.kind
    ) {
      fail(`extensions/dist/index.json 与 ${entry.id} 不一致`);
    }
  }
  if (requested.length === 0) {
    const expected = new Set(entries.map((entry) => entry.id));
    const extra = (index.extensions ?? []).filter(
      (entry) => !expected.has(entry.id),
    );
    if (extra.length > 0) {
      fail(
        `extensions/dist/index.json 含已移除扩展：${extra
          .map((entry) => entry.id)
          .join(", ")}`,
      );
    }
    const staleDirs = readdirSync(distRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !expected.has(entry.name),
      )
      .map((entry) => entry.name);
    if (staleDirs.length > 0) {
      fail(`extensions/dist 含未构建目录：${staleDirs.join(", ")}`);
    }
  }
  console.log(
    `[extensions] 校验通过：${entries.map((item) => item.id).join(", ")}`,
  );
} else {
  try {
    ensureSdkDist(repoRoot);
  } catch (error) {
    fail(String(error));
  }
  const entries = [];
  for (const ext of extensions) entries.push(await buildOne(ext));
  writeIndex(requested.length > 0 ? mergeExistingIndex(entries) : entries);
  console.log(`[extensions] 构建完成：${entries.length} 个官方扩展`);
}
