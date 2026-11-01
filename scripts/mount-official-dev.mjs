#!/usr/bin/env node
/**
 * 把官方扩展源码目录挂到宿主的开发模式配置里，免去目录选择器。
 *
 * 用法：
 *   node scripts/mount-official-dev.mjs player
 *   node scripts/mount-official-dev.mjs noise --remove
 *
 * 这是本机开发配置（%APPDATA%\app.lull.desktop\extensions.json），
 * 不会改动仓库或安装包；开发模式关闭 / 删除扩展后失效。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const id = args.find((arg) => !arg.startsWith("--"));
const remove = args.includes("--remove");
if (!id) {
  console.error("用法：node scripts/mount-official-dev.mjs <id> [--remove]");
  process.exit(1);
}

function appDataDir() {
  if (process.env.LULL_DEV_CONFIG) {
    return dirname(resolve(process.env.LULL_DEV_CONFIG));
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "app.lull.desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "app.lull.desktop");
  }
  return join(homedir(), ".config", "app.lull.desktop");
}

function configPath() {
  return process.env.LULL_DEV_CONFIG
    ? resolve(process.env.LULL_DEV_CONFIG)
    : join(appDataDir(), "extensions.json");
}

const sourceDir = join(repoRoot, "extensions", "official", id);
const manifestPath = join(sourceDir, "widget.json");
if (!existsSync(manifestPath)) {
  console.error(`找不到官方扩展：${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.id !== id) {
  console.error(`清单 id=${manifest.id} 与目录 ${id} 不一致`);
  process.exit(1);
}

let entryUrl = null;
const devPath = join(sourceDir, ".lull-dev.json");
if (existsSync(devPath)) {
  const dev = JSON.parse(readFileSync(devPath, "utf8"));
  if (typeof dev.server !== "string" || !dev.server.startsWith("http://")) {
    console.error(".lull-dev.json 缺少合法的 server");
    process.exit(1);
  }
  entryUrl = dev.server;
} else if (!remove) {
  console.warn("提示：缺少 .lull-dev.json，将挂载为静态源码而不是 Vite dev server。");
}

const path = configPath();
let config = { schemaVersion: 1, devMode: true, devPackages: [] };
if (existsSync(path)) {
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`${path} 不是合法 JSON：${error}`);
    process.exit(1);
  }
}
config.devMode = true;
config.devPackages = Array.isArray(config.devPackages) ? config.devPackages : [];
config.devPackages = config.devPackages.filter((item) => item.id !== id);

if (!remove) {
  config.devPackages.push({
    id,
    path: resolve(sourceDir),
    ...(entryUrl ? { entryUrl } : {}),
  });
}

const temp = `${path}.tmp`;
writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
renameSync(temp, path);

console.log(`[dev] 配置：${path}`);
if (remove) {
  console.log(`[dev] 已移除 ${id}`);
} else {
  console.log(`[dev] 已挂载 ${id} → ${sourceDir}`);
  if (entryUrl) {
    console.log(`[dev] Vite：${entryUrl}`);
    console.log(`[dev] 下一步：pnpm extensions:dev ${id}`);
  }
  console.log("[dev] 然后在设置 → 扩展 → 开发模式里重新打开该扩展。");
}
