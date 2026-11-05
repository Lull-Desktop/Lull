#!/usr/bin/env node
/**
 * 把 `examples/games/<name>/dist` 安装到 Lull 用户游戏目录：
 *   %APPDATA%\app.lull.desktop\games\<id>\
 *
 * 用法：
 *   node scripts/install-game-examples.mjs
 *   node scripts/install-game-examples.mjs living-world
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGamePackage } from "./lib/game-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appData = process.env.APPDATA;
if (!appData) {
  console.error("[games:install] 找不到 APPDATA");
  process.exit(1);
}
const targetRoot = join(appData, "app.lull.desktop", "games");
mkdirSync(targetRoot, { recursive: true });

const only = new Set(process.argv.slice(2));
const examplesDir = join(root, "examples", "games");
let installed = 0;
for (const name of readdirSync(examplesDir)) {
  if (only.size > 0 && !only.has(name)) continue;
  const distDir = join(examplesDir, name, "dist");
  if (!existsSync(join(distDir, "game.json"))) continue;
  try {
    const { manifest } = validateGamePackage(distDir);
    const target = join(targetRoot, manifest.id);
    rmSync(target, { recursive: true, force: true });
    cpSync(distDir, target, { recursive: true });
    console.log(`[games:install] ${manifest.id} ${manifest.version} → ${target}`);
    installed += 1;
  } catch (error) {
    console.error(`[games:install] ${name} 安装失败：${error.message}`);
    process.exitCode = 1;
  }
}
console.log(
  `[games:install] 已安装 ${installed} 个游戏；回到设置页「游戏」刷新并在扩展中心启用`,
);
