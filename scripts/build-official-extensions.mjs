#!/usr/bin/env node
/**
 * 构建随包扩展：源码目录与预构建目录统一产出到 `extensions/dist/<id>/`。
 *
 * 两个输入：
 *   extensions/official/<dir>/  源码 → Vite 构建
 *     widget：widget.json + index.html → 标准 widget 包 + `.lull-integrity.json`
 *     scene ：catalog.json + index.html（Vite 入口）→ 内容包（catalog.json 内写 integrity）
 *   extensions/bundled/<label>/ 预构建标准包 → 校验后原样复制，按字节重算摘要
 *     widget：widget.json + index.html（+ assets）
 *     scene ：catalog.json + scenes/<name>/index.html（+ assets）
 *
 * 产物：
 *   extensions/dist/<id>/ …（widget 在包根；scene 在 catalog.json 指定的入口目录）
 *   extensions/dist/index.json  # 供诊断与 CI 断言（含 kind / source）
 *
 * 用法：
 *   node scripts/build-official-extensions.mjs [dir|id ...] [--check]
 *
 * `--check` 不重建，只校验产物与源码/摘要一致，供 CI 使用。
 * 无参数为全量构建：会清理 dist 中不再声明的目录；带参数只重建指定官方扩展，
 * 但始终刷新全部 `extensions/bundled` 包并保留其它官方包的索引。
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
const bundledRoot = join(repoRoot, "extensions", "bundled");
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
/** 预构建包根不允许开发配置；运行时也会拒绝带这些文件的包。 */
const DEV_CONFIG_FILES = new Set(["dev.json", ".lull-dev.json"]);
/**
 * 预构建包根的摘要锁 / 发布者签名不复制：Widget 的锁由构建重写，Scene 的摘要
 * 写进 catalog.json；随包来源不参与社区发布者签名链。
 */
const BUNDLED_SKIP_ROOT = new Set([
  ".lull-integrity.json",
  ".lull-signature.json",
]);

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

/** 读取 scene 源清单；integrity 不要求在源码里（构建时写入产物）。
 *
 * `requireViteEntry=false` 用于 `extensions/bundled` 的预构建包：它没有 Vite 根入口，
 * 入口已经在 `catalog.json` 的 entry 指向的位置。
 */
function readSceneSource(dir, { requireViteEntry = true } = {}) {
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
  if (requireViteEntry && !existsSync(join(dir, "index.html"))) {
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

/**
 * 扫描 `extensions/bundled/<label>/` 的预构建标准包。
 *
 * 目录名只是标签；产物目录用清单 id（与官方源码一样允许 `bamboo` → `lull.bamboo`）。
 * 同时有 widget.json 与 catalog.json 视为错误；两者都没有时提示从社区条目复制
 * `package/` 的内容，而不是整个条目目录。
 */
function bundledExtensions() {
  if (!existsSync(bundledRoot)) return [];
  const found = [];
  const names = readdirSync(bundledRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();

  for (const dir of names) {
    const sourceDir = join(bundledRoot, dir);
    const hasWidget = existsSync(join(sourceDir, "widget.json"));
    const hasCatalog = existsSync(join(sourceDir, "catalog.json"));
    if (hasWidget && hasCatalog) {
      fail(
        `extensions/bundled/${dir} 同时包含 widget.json 与 catalog.json，无法判断包类型`,
      );
    }
    if (!hasWidget && !hasCatalog) {
      fail(
        `extensions/bundled/${dir} 不是标准扩展包根：需要 widget.json 或 catalog.json；` +
          "Lull-Community 条目请复制其 package/ 目录的内容，而不是整个条目目录",
      );
    }
    if (hasWidget) {
      const manifest = readWidgetManifest(sourceDir);
      if (!existsSync(join(sourceDir, manifest.entry))) {
        fail(`extensions/bundled/${dir} 的 entry 不存在：${manifest.entry}`);
      }
      found.push({
        source: "bundled",
        dir,
        kind: "widget",
        id: manifest.id,
        version: manifest.version,
        order: manifest.order ?? 100,
        sourceDir,
        manifest,
      });
      continue;
    }
    const { catalog, scene } = readSceneSource(sourceDir, {
      requireViteEntry: false,
    });
    if (!existsSync(join(sourceDir, ...scene.entry.split("/")))) {
      fail(`extensions/bundled/${dir} 的 entry 不存在：${scene.entry}`);
    }
    found.push({
      source: "bundled",
      dir,
      kind: "scene",
      id: scene.id,
      version: scene.version,
      order: SCENE_ORDER,
      sourceDir,
      catalog,
      scene,
    });
  }
  return found;
}

/** official 与 bundled 之间、各自内部都不允许 id 重复，避免静默互相覆盖。 */
function assertUniqueIds(extensions) {
  const byId = new Map();
  for (const ext of extensions) {
    const previous = byId.get(ext.id);
    if (previous) {
      fail(
        `扩展 id 重复：${ext.id}（${previous.sourceDir} 与 ${ext.sourceDir}）`,
      );
    }
    byId.set(ext.id, ext);
  }
}

function selectExtensions(all) {
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

function logBundled(ext, digest) {
  const mapped = ext.dir === ext.id ? "" : `（${ext.dir} → ${ext.id}）`;
  console.log(
    `[extensions] bundled ${ext.kind} ${ext.id}@${ext.version}${mapped} → extensions/dist/${ext.id} (${digest.slice(0, 12)}…)`,
  );
}

/** 预构建包的索引条目；official 条目在主流程里补 `source: "official"`。 */
function bundledIndexEntry(ext, digest) {
  const entry = {
    kind: ext.kind,
    id: ext.id,
    version: ext.version,
    order: ext.order,
    digest,
    source: "bundled",
  };
  if (ext.kind === "widget") entry.provides = ext.manifest.provides ?? [];
  return entry;
}

/** 逐字节复制预构建包；包根的摘要锁/签名不复制，dev 配置与符号链接直接失败。 */
function copyBundledTree(source, target, relative = "", root = true) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (root && DEV_CONFIG_FILES.has(entry.name)) {
      fail(`${source} 含开发配置 ${path}，不能作为随包扩展发布`);
    }
    if (root && BUNDLED_SKIP_ROOT.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      fail(`${source} 含符号链接 ${path}，打包与摘要不支持符号链接`);
    }
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyBundledTree(from, to, path, false);
      continue;
    }
    if (!entry.isFile()) {
      fail(`${source} 含不支持的文件类型：${path}`);
    }
    copyFileSync(from, to);
  }
}

function buildBundledWidget(ext) {
  const outDir = join(distRoot, ext.id);
  if (!existsSync(join(ext.sourceDir, ext.manifest.entry))) {
    fail(`${ext.id} 的 entry 不存在：${ext.manifest.entry}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyBundledTree(ext.sourceDir, outDir);

  runValidator(outDir, ext.id);
  scanBuiltPackage(outDir, ext.id);
  const expected = computeWidgetDigest(ext.sourceDir, ext.id, ext.version);
  const { digest } = writeWidgetIntegrity(
    outDir,
    ext.id,
    ext.version,
    "declared",
  );
  if (digest !== expected) {
    fail(`${ext.id} 的产物摘要与 extensions/bundled 源目录不一致`);
  }
  logBundled(ext, digest);
  return bundledIndexEntry(ext, digest);
}

function buildBundledScene(ext) {
  const outRoot = join(distRoot, ext.id);
  const entryDir = sceneDirFor(ext.scene.entry);
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(join(outRoot, ...entryDir.split("/")), { recursive: true });
  copyBundledTree(ext.sourceDir, outRoot);

  const entryPath = join(outRoot, ...ext.scene.entry.split("/"));
  if (!existsSync(entryPath)) {
    fail(`${ext.id} 构建后缺少 entry：${ext.scene.entry}`);
  }
  const sourcePackageDir = join(ext.sourceDir, ...entryDir.split("/"));
  const sourceDigest = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: sourcePackageDir,
  });
  const declared = ext.scene.integrity?.digest;
  if (declared && declared !== sourceDigest) {
    console.warn(
      `[extensions] ${ext.id} 的源 catalog integrity 与内容不一致，已按实际内容在产物中重算`,
    );
  }

  const catalogPath = join(outRoot, "catalog.json");
  const catalog = readJson(catalogPath);
  const scene = catalog.scenes?.[0];
  if (!scene) fail(`${ext.id} 的 catalog.json 缺少 scenes[0]`);
  scene.integrity = {
    algorithm: "sha256",
    scope: "package",
    digest: sourceDigest,
  };
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  const distDigest = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: join(outRoot, ...entryDir.split("/")),
  });
  if (distDigest !== sourceDigest) {
    fail(`${ext.id} 的产物摘要与 extensions/bundled 源目录不一致`);
  }

  runValidator(outRoot, ext.id);
  scanBuiltPackage(outRoot, ext.id);
  logBundled(ext, sourceDigest);
  return bundledIndexEntry(ext, sourceDigest);
}

function buildBundled(ext) {
  return ext.kind === "widget"
    ? buildBundledWidget(ext)
    : buildBundledScene(ext);
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

function checkBundledWidget(ext) {
  const outDir = join(distRoot, ext.id);
  if (!existsSync(join(outDir, ext.manifest.entry))) {
    fail(`${ext.id} 尚未构建：先执行 pnpm extensions:build`);
  }
  const builtManifest = readWidgetManifest(outDir);
  if (JSON.stringify(builtManifest) !== JSON.stringify(ext.manifest)) {
    fail(
      `${ext.id} 的产物清单与 extensions/bundled/${ext.dir} 不一致：重新执行 pnpm extensions:build`,
    );
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
  const expected = computeWidgetDigest(ext.sourceDir, ext.id, ext.version);
  const actual = computeWidgetDigest(outDir, ext.id, ext.version);
  if (record.digest !== expected) {
    fail(
      `${ext.id} 的摘要与 extensions/bundled/${ext.dir} 不一致：重新执行 pnpm extensions:build`,
    );
  }
  if (record.digest !== actual) {
    fail(`${ext.id} 的摘要不匹配：产物被改动过，重新构建`);
  }
  runValidator(outDir, ext.id);
  scanBuiltPackage(outDir, ext.id);
  return bundledIndexEntry(ext, expected);
}

function checkBundledScene(ext) {
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
    fail(
      `${ext.id} 的产物清单与 extensions/bundled/${ext.dir} 不一致：重新执行 pnpm extensions:build`,
    );
  }
  const entryDir = sceneDirFor(ext.scene.entry);
  const entryPath = join(outRoot, ...ext.scene.entry.split("/"));
  if (!existsSync(entryPath)) {
    fail(`${ext.id} 尚未构建：缺少 entry ${ext.scene.entry}`);
  }
  const expected = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: join(ext.sourceDir, ...entryDir.split("/")),
  });
  const actual = computePackageDigest({
    id: ext.id,
    version: ext.version,
    dir: join(outRoot, ...entryDir.split("/")),
  });
  if (builtScene.integrity?.digest !== expected) {
    fail(
      `${ext.id} 的 integrity 与 extensions/bundled/${ext.dir} 不一致：重新执行 pnpm extensions:build`,
    );
  }
  if (expected !== actual) {
    fail(`${ext.id} 的摘要不匹配：产物被改动过，重新构建`);
  }
  runValidator(outRoot, ext.id);
  scanBuiltPackage(outRoot, ext.id);
  return bundledIndexEntry(ext, expected);
}

function checkBundled(ext) {
  return ext.kind === "widget"
    ? checkBundledWidget(ext)
    : checkBundledScene(ext);
}

/** 全量构建后清理 dist 里不再声明的目录；只动非点号目录，保留 .gitkeep。 */
function pruneDistDirs(expectedIds) {
  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (expectedIds.has(entry.name)) continue;
    rmSync(join(distRoot, entry.name), { recursive: true, force: true });
    console.log(`[extensions] 清理未声明的旧扩展：${entry.name}`);
  }
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

/** 单包构建时保留其他已构建官方包的索引，避免索引被裁成一份。
 *
 * `extensions/bundled` 每次都全量刷新，因此旧索引里的 bundled 条目一律丢弃，
 * 由本次扫描结果重建，避免源包删除/hash 变更后索引残留。
 */
function mergeExistingIndex(entries) {
  const indexPath = join(distRoot, "index.json");
  if (!existsSync(indexPath)) return entries;
  const existing = readJson(indexPath);
  const byId = new Map(
    (existing.extensions ?? [])
      .filter((entry) => entry.source !== "bundled")
      .filter((entry) => existsSync(join(distRoot, entry.id)))
      .map((entry) => [entry.id, entry]),
  );
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

const allOfficial = officialExtensions();
const official = selectExtensions(allOfficial);
const bundled = bundledExtensions();
assertUniqueIds([...allOfficial, ...bundled]);
mkdirSync(distRoot, { recursive: true });

if (checkOnly) {
  const entries = official.map((ext) => ({
    ...checkOne(ext),
    source: "official",
  }));
  entries.push(...bundled.map(checkBundled));
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
    `[extensions] 校验通过：${entries
      .map((item) => item.id)
      .join(", ")}（official ${official.length}，bundled ${bundled.length}）`,
  );
} else {
  try {
    ensureSdkDist(repoRoot);
  } catch (error) {
    fail(String(error));
  }
  const entries = [];
  for (const ext of official) {
    entries.push({ ...(await buildOne(ext)), source: "official" });
  }
  for (const ext of bundled) entries.push(buildBundled(ext));
  writeIndex(requested.length > 0 ? mergeExistingIndex(entries) : entries);
  if (requested.length === 0) {
    pruneDistDirs(new Set(entries.map((entry) => entry.id)));
  }
  console.log(
    `[extensions] 构建完成：${official.length} 个官方扩展，${bundled.length} 个预构建随包扩展`,
  );
}
