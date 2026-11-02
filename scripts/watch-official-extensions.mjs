#!/usr/bin/env node
/**
 * Tier 1 开发模式：监听单个官方扩展源码，变化后重新构建到 extensions/dist/<id>。
 *
 * 宿主仍按「开发模式 → 添加目录 → 打开」加载构建产物；改完点一下卡片上的「重载」。
 * 需要 HMR 时用 P2 的 `extensions:dev`（Vite dev server）。
 *
 * 用法：node scripts/watch-official-extensions.mjs <id>
 */
import { spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = join(repoRoot, "scripts", "build-official-extensions.mjs");
const id = process.argv[2];
if (!id) {
  console.error("用法：node scripts/watch-official-extensions.mjs <id>");
  process.exit(1);
}
const sourceDir = join(repoRoot, "extensions", "official", id);

function fail(message) {
  console.error(`[extensions:watch] ${message}`);
  process.exit(1);
}

let running = false;
let pending = false;

function rebuild() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  const result = spawnSync(process.execPath, [buildScript, id], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  running = false;
  if (result.status !== 0) {
    console.error(`[extensions:watch] 构建失败；修改文件后会重试`);
  }
  if (pending) {
    pending = false;
    rebuild();
  }
}

rebuild();
const isScene = existsSync(join(sourceDir, "catalog.json"));
console.log(
  `[extensions:watch] 监听 ${sourceDir}\n` +
    (isScene
      ? "  壁纸场景：重建到 extensions/dist 后，在壁纸设置里重新选择该场景（或重开壁纸窗）。"
      : "  宿主内：设置 → 扩展 → 开发模式 → 添加 extensions/dist/" +
        id +
        " → 打开；改完点「重载」。"),
);

let timer = null;
watch(sourceDir, { recursive: true }, () => {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    console.log("[extensions:watch] 检测到变化，重新构建…");
    rebuild();
  }, 200);
});
