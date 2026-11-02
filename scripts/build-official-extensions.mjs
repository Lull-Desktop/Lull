#!/usr/bin/env node
/**
 * 构建官方扩展：`extensions/official/<id>/` → `extensions/dist/<id>/` 标准 widget 包。
 *
 * 产物：
 *   extensions/dist/<id>/widget.json|index.html|assets/...
 *   extensions/dist/<id>/.lull-integrity.json   # 构建期摘要锁，source=declared
 *   extensions/dist/index.json                  # 供诊断与 CI 断言
 *
 * 用法：
 *   node scripts/build-official-extensions.mjs [id ...] [--check]
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
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TEXT_FILE = /\.(html|js|mjs|css|json|map)$/i;

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

function extensionIds() {
  if (!existsSync(officialRoot)) return [];
  const ids = readdirSync(officialRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(officialRoot, id, "widget.json")));
  if (requested.length > 0) {
    for (const id of requested) {
      if (!ids.includes(id)) fail(`未知官方扩展：${id}`);
    }
    return ids.filter((id) => requested.includes(id));
  }
  return ids;
}

function readManifest(dir) {
  const path = join(dir, "widget.json");
  if (!existsSync(path)) fail(`缺少 widget.json：${dir}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} 不是合法 JSON：${error}`);
  }
  if (!ID.test(manifest.id ?? "")) fail(`${path} 的 id 非法`);
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
  return null;
}

async function buildOne(id) {
  const sourceDir = join(officialRoot, id);
  const outDir = join(distRoot, id);
  const manifest = readManifest(sourceDir);
  if (manifest.id !== id) {
    fail(`目录名与清单 id 不一致：${id} / ${manifest.id}`);
  }
  if (!existsSync(join(sourceDir, manifest.entry))) {
    fail(`${id} 的 entry 不存在：${manifest.entry}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build(
    createExtensionConfig({
      repoRoot,
      extensionDir: sourceDir,
      outDir,
    }),
  );
  if (!existsSync(join(outDir, manifest.entry))) {
    fail(`${id} 构建后缺少 entry：${manifest.entry}`);
  }

  // 清单不进 Vite 的入口图，手动复制；assets/ 额外复制（public/ 由 Vite 处理）。
  cpSync(join(sourceDir, "widget.json"), join(outDir, "widget.json"));
  if (existsSync(join(sourceDir, "assets"))) {
    cpSync(join(sourceDir, "assets"), join(outDir, "assets"), {
      recursive: true,
    });
  }

  runValidator(outDir, id);
  scanBuiltPackage(outDir, id);
  const { digest } = writeWidgetIntegrity(
    outDir,
    manifest.id,
    manifest.version,
    "declared",
  );
  console.log(
    `[extensions] ${id}@${manifest.version} → extensions/dist/${id} (${digest.slice(0, 12)}…)`,
  );
  return { id, version: manifest.version, order: manifest.order ?? 100, digest };
}

function checkOne(id) {
  const sourceDir = join(officialRoot, id);
  const outDir = join(distRoot, id);
  const manifest = readManifest(sourceDir);
  if (manifest.id !== id) fail(`目录名与清单 id 不一致：${id} / ${manifest.id}`);
  if (!existsSync(join(outDir, manifest.entry))) {
    fail(`${id} 尚未构建：先执行 pnpm extensions:build`);
  }
  const builtManifest = readManifest(outDir);
  if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
    fail(`${id} 的产物清单与源码不一致：重新执行 pnpm extensions:build`);
  }
  const record = readIntegrity(outDir);
  if (!record) fail(`${id} 缺少 ${WIDGET_INTEGRITY_FILE}`);
  if (
    record.schemaVersion !== 1 ||
    record.algorithm !== "sha256" ||
    record.scope !== "package" ||
    record.source !== "declared"
  ) {
    fail(`${id} 的摘要锁字段不符合约定`);
  }
  const digest = computeWidgetDigest(outDir, manifest.id, manifest.version);
  if (record.digest !== digest) {
    fail(`${id} 的摘要不匹配：产物被改动过，重新构建`);
  }
  runValidator(outDir, id);
  scanBuiltPackage(outDir, id);
  return { id, version: manifest.version, order: manifest.order ?? 100, digest };
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
  const existing = JSON.parse(readFileSync(indexPath, "utf8"));
  const byId = new Map(
    (existing.extensions ?? [])
      .filter((entry) => existsSync(join(distRoot, entry.id)))
      .map((entry) => [entry.id, entry]),
  );
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

const ids = extensionIds();
if (ids.length === 0) fail("extensions/official 下没有可构建的扩展");
mkdirSync(distRoot, { recursive: true });

if (checkOnly) {
  const entries = ids.map(checkOne);
  const indexPath = join(distRoot, "index.json");
  if (!existsSync(indexPath)) fail("缺少 extensions/dist/index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  for (const entry of entries) {
    const found = index.extensions?.find((item) => item.id === entry.id);
    if (
      !found ||
      found.digest !== entry.digest ||
      found.version !== entry.version
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
  for (const id of ids) entries.push(await buildOne(id));
  writeIndex(requested.length > 0 ? mergeExistingIndex(entries) : entries);
  console.log(`[extensions] 构建完成：${entries.length} 个官方扩展`);
}
