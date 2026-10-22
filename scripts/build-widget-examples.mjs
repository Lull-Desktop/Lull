#!/usr/bin/env node
/**
 * 构建示例插件：把 `examples/widgets/<name>/src/*` 用 esbuild 打成单文件 ESM，
 * 并复制 HTML/CSS/widget.json 到 `examples/widgets/<name>/dist/`。
 *
 * esbuild 不在根依赖里（离线环境），这里从 pnpm 虚拟 store 里解析它。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = join(root, "packages", "widget-sdk");

/**
 * 把 `@lull/widget-sdk` 及其子路径解析到包产物（dist），未构建时回落到 TS 源码。
 * 示例统一按包名导入，保证示例写法与第三方真实消费方式一致。
 */
const resolveWidgetSdk = {
  name: "resolve-widget-sdk",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@lull\/widget-sdk(\/.*)?$/ }, (args) => {
      const sub = args.path
        .slice("@lull/widget-sdk".length)
        .replace(/^\//, "");
      const name = sub === "" ? "index" : sub;
      const dist = join(sdkRoot, "dist", `${name}.js`);
      if (existsSync(dist)) return { path: dist };
      const src = join(sdkRoot, "src", `${name}.ts`);
      if (existsSync(src)) return { path: src };
      return {
        errors: [
          { text: `找不到 @lull/widget-sdk/${name}：先执行 pnpm widgets:sdk` },
        ],
      };
    });
  },
};

const SAMPLES = [
  { dir: "pomodoro-js", entry: "src/main.ts", jsx: false },
  { dir: "pomodoro-react", entry: "src/main.tsx", jsx: true },
  { dir: "pomodoro-vue", entry: "src/main.ts", jsx: false },
];

async function buildSample(sample) {
  const sampleDir = join(root, "examples", "widgets", sample.dir);
  const distDir = join(sampleDir, "dist");
  const entry = join(sampleDir, sample.entry);
  if (!existsSync(entry)) {
    console.log(`[samples] 跳过 ${sample.dir}：缺少 ${sample.entry}`);
    return false;
  }
  if (!existsSync(join(sampleDir, "widget.json"))) {
    throw new Error(`${sample.dir} 缺少 widget.json`);
  }
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  await build({
    entryPoints: [entry],
    outfile: join(distDir, "main.js"),
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: sample.jsx ? "automatic" : undefined,
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    plugins: [resolveWidgetSdk],
    define: { "process.env.NODE_ENV": '"production"' },
  });

  for (const file of ["index.html", "style.css", "widget.json"]) {
    const source = join(sampleDir, file);
    if (!existsSync(source)) {
      throw new Error(`${sample.dir} 缺少 ${file}`);
    }
    cpSync(source, join(distDir, file));
  }
  const assets = join(sampleDir, "assets");
  if (existsSync(assets)) {
    cpSync(assets, join(distDir, "assets"), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(distDir, "widget.json"), "utf8"));
  console.log(`[samples] 构建 ${sample.dir} → ${manifest.id}`);
  return true;
}

let built = 0;
for (const sample of SAMPLES) {
  try {
    if (await buildSample(sample)) built += 1;
  } catch (error) {
    const message = String(error);
    if (message.includes("Could not resolve \"vue\"")) {
      console.log(`[samples] 跳过 ${sample.dir}：未安装 vue`);
      continue;
    }
    throw error;
  }
}
console.log(`[samples] 完成：${built} 个示例`);
