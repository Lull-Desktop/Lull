#!/usr/bin/env node
/**
 * 把 `examples/widgets/<name>/dist` 安装到 Lull 的用户插件目录：
 *   %APPDATA%\app.lull.desktop\widgets\<id>\
 *
 * 安装后回到设置页点「刷新」即可看到插件；本脚本不处理签名/更新。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appData = process.env.APPDATA;
if (!appData) {
  console.error("[samples] 找不到 APPDATA");
  process.exit(1);
}
const targetRoot = join(appData, "app.lull.desktop", "widgets");
mkdirSync(targetRoot, { recursive: true });

const examplesDir = join(root, "examples", "widgets");
let installed = 0;
for (const name of readdirSync(examplesDir)) {
  const distDir = join(examplesDir, name, "dist");
  const manifestPath = join(distDir, "widget.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const target = join(targetRoot, manifest.id);
  rmSync(target, { recursive: true, force: true });
  cpSync(distDir, target, { recursive: true });
  console.log(`[samples] 安装 ${manifest.id} → ${target}`);
  installed += 1;
}
console.log(`[samples] 已安装 ${installed} 个插件；在设置页点「刷新」`);
