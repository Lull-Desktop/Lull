#!/usr/bin/env node
/**
 * Tier 2 开发模式：在 loopback 上起 Vite dev server，供宿主开发窗口直接加载。
 *
 * 用法：node scripts/dev-official-extensions.mjs <id> [--port 5273]
 *
 * 宿主侧：设置 → 扩展 → 开发模式 → 添加扩展源码目录；宿主读取包内
 * `.lull-dev.json` 的 `server` 地址，debug 构建下把 iframe 指向它。
 * 修改组件/样式走 React Fast Refresh；入口/Provider 改动会整页 reload。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  createExtensionConfig,
  EXTENSION_PORTS,
} from "./lib/extension-vite.config.mjs";
import { ensureSdkDist } from "./lib/sdk-dist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const id = args.find((arg) => !arg.startsWith("--"));
const portFlag = args.indexOf("--port");
const portArg = portFlag === -1 ? null : args[portFlag + 1];

function fail(message) {
  console.error(`[extensions:dev] ${message}`);
  process.exit(1);
}

if (!id) fail("用法：pnpm extensions:dev <id> [--port 5273]");
const sourceDir = join(repoRoot, "extensions", "official", id);
if (!existsSync(join(sourceDir, "widget.json"))) {
  if (existsSync(join(sourceDir, "catalog.json"))) {
    fail(
      `extensions/official/${id} 是壁纸场景：暂不支持 Vite dev server；` +
        `请用 pnpm extensions:build ${id} 或 pnpm extensions:watch ${id}`,
    );
  }
  fail(`找不到官方扩展：extensions/official/${id}`);
}

const port = Number(portArg ?? EXTENSION_PORTS[id] ?? 5275);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  fail("端口必须是 1024–65535 的整数");
}

const devFile = join(sourceDir, ".lull-dev.json");
if (existsSync(devFile)) {
  try {
    const entry = JSON.parse(readFileSync(devFile, "utf8"));
    const expected = `http://127.0.0.1:${port}/`;
    if (`${entry.server ?? ""}`.replace(/\/$/, "") !== expected.replace(/\/$/, "")) {
      console.warn(
        `[extensions:dev] 提示：${devFile} 写的是 ${entry.server}，` +
          `当前端口是 ${port}；请同步修改或在宿主里重新挂载。`,
      );
    }
  } catch (error) {
    fail(`${devFile} 不是合法 JSON：${error}`);
  }
} else {
  console.warn(
    `[extensions:dev] 提示：缺少 ${devFile}，宿主会加载包内静态入口而不是 dev server。`,
  );
}

try {
  ensureSdkDist(repoRoot);
} catch (error) {
  fail(String(error));
}

const server = await createServer(
  createExtensionConfig({
    repoRoot,
    extensionDir: sourceDir,
    outDir: join(repoRoot, "extensions", "dist", id),
    serve: true,
    port,
  }),
);
await server.listen();
server.printUrls();
console.log(
  `[extensions:dev] ${id} → http://127.0.0.1:${port}/\n` +
    `  宿主：设置 → 扩展 → 开发模式 → 添加 extensions/official/${id} → 打开；改完保存即热更新。`,
);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
