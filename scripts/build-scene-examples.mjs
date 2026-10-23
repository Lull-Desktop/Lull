#!/usr/bin/env node
/**
 * 构建脚本场景示例：把 `examples/content/<name>/src/main.ts` 用 esbuild 打成
 * 包内单文件 ESM（`scenes/<name>/main.js`）。
 *
 * 示例按包名导入 `@lull/scene-sdk`，优先取 dist，未构建时回落到 TS 源码，
 * 保证示例写法与第三方真实消费方式一致。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = join(root, "packages", "scene-sdk");

const resolveSceneSdk = {
  name: "resolve-scene-sdk",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@lull\/scene-sdk(\/.*)?$/ }, (args) => {
      const sub = args.path
        .slice("@lull/scene-sdk".length)
        .replace(/^\//, "");
      const name = sub === "" ? "index" : sub;
      const dist = join(sdkRoot, "dist", `${name}.js`);
      if (existsSync(dist)) return { path: dist };
      const src = join(sdkRoot, "src", `${name}.ts`);
      if (existsSync(src)) return { path: src };
      return {
        errors: [
          { text: `找不到 @lull/scene-sdk/${name}：先执行 pnpm scenes:sdk` },
        ],
      };
    });
  },
};

const SAMPLES = [
  { dir: "param-demo", entry: "src/main.ts" },
  { dir: "three-scene", entry: "src/main.ts" },
];

let built = 0;
for (const sample of SAMPLES) {
  const sampleDir = join(root, "examples", "content", sample.dir);
  const entry = join(sampleDir, sample.entry);
  const outfile = join(sampleDir, "scenes", sample.dir, "main.js");
  if (!existsSync(entry)) {
    console.log(`[scenes] 跳过 ${sample.dir}：缺少 ${sample.entry}`);
    continue;
  }
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    plugins: [resolveSceneSdk],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: {
      js: "// Built from src/main.ts by pnpm scenes:samples:build; do not edit.",
    },
  });
  built += 1;
  console.log(`[scenes] 构建 ${sample.dir} → ${outfile}`);
}
console.log(`[scenes] 完成：${built} 个示例`);
