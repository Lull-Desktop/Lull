#!/usr/bin/env node
/**
 * 构建 `examples/games/<name>`：
 * - 校验 game.json / entry / 包预算；
 * - 把示例包复制到 `examples/games/<name>/dist/`（跳过 dist/node_modules/点路径）；
 * - 若示例带 `build.mjs`，在复制后调用 `default({ sourceDir, distDir })`（用于 TS/引擎打包）。
 *
 * 用法：
 *   node scripts/build-game-examples.mjs
 *   node scripts/build-game-examples.mjs living-world
 *   node scripts/build-game-examples.mjs --check
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GamePackageError,
  stageGamePackage,
  validateGamePackage,
} from "./lib/game-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(root, "examples", "games");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));

function discover() {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(examplesDir, name, "game.json")))
    .filter((name) => only.size === 0 || only.has(name))
    .sort();
}

async function runHook(sourceDir, distDir) {
  const hook = join(sourceDir, "build.mjs");
  if (!existsSync(hook)) return;
  const module = await import(pathToFileURL(hook).href);
  if (typeof module.default !== "function") {
    throw new GamePackageError(`build.mjs 必须默认导出函数：${hook}`);
  }
  await module.default({ sourceDir, distDir });
  console.log(`[games:build] 已执行 ${sourceDir} 的 build.mjs`);
}

let built = 0;
for (const name of discover()) {
  const sourceDir = join(examplesDir, name);
  try {
    const { manifest, files, bytes } = validateGamePackage(sourceDir);
    if (checkOnly) {
      console.log(
        `[games:check] ${manifest.id} ${manifest.version} ` +
          `${files.length} files / ${(bytes / 1024).toFixed(1)} KiB`,
      );
      continue;
    }
    const distDir = join(sourceDir, "dist");
    rmSync(distDir, { recursive: true, force: true });
    const staged = stageGamePackage(sourceDir, distDir);
    await runHook(sourceDir, distDir);
    const final = validateGamePackage(distDir);
    console.log(
      `[games:build] ${manifest.id} ${manifest.version} → ${distDir} ` +
        `(${final.files.length} files, ${(final.bytes / 1024).toFixed(1)} KiB，源 ${staged.files.length} files)`,
    );
    built += 1;
  } catch (error) {
    if (error instanceof GamePackageError) {
      console.error(`[games:build] ${name} 校验失败：${error.message}`);
    } else {
      console.error(`[games:build] ${name} 构建失败：${error?.stack ?? error}`);
    }
    process.exitCode = 1;
  }
}

if (checkOnly) {
  console.log(`[games:check] 完成：${discover().length} 个游戏示例`);
} else {
  console.log(`[games:build] 完成：${built} 个游戏示例`);
}
