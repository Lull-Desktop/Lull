/**
 * 引擎示例的打包辅助：把 `src/*.ts` + 引擎依赖打成包内单个 ESM 文件。
 *
 * 与 `examples/scenes` 的做法一致：示例按包名 import `@lull/game-sdk` /
 * `@lull/game-adapter-*`，这里优先取 `packages/<pkg>/src`，未构建也能打包；
 * 引擎（phaser / pixi.js / three）走普通 node_modules 解析，直接 bundle 进产物。
 *
 * 产物写到 `dist/<outfile>`；`dist/src` 等只在源码目录存在的文件会被清理，
 * 不进入可安装的游戏包。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LULL_PACKAGES = new Set([
  "game-sdk",
  "game-adapter-canvas",
  "game-adapter-phaser",
  "game-adapter-pixi",
  "game-adapter-three",
]);

const lullResolver = {
  name: "lull-packages",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@lull\// }, (args) => {
      const rest = args.path.slice("@lull/".length);
      const slash = rest.indexOf("/");
      const pkg = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      if (!LULL_PACKAGES.has(pkg)) {
        return { errors: [{ text: `未知的 @lull 包：${args.path}` }] };
      }
      const base = sub === "" ? "index" : sub;
      for (const extension of [".ts", ".tsx"]) {
        const source = join(root, "packages", pkg, "src", `${base}${extension}`);
        if (existsSync(source)) return { path: source };
      }
      const dist = join(root, "packages", pkg, "dist", `${base}.js`);
      if (existsSync(dist)) return { path: dist };
      return {
        errors: [
          {
            text: `找不到 ${args.path}：先执行 pnpm game:sdk / pnpm game:adapters`,
          },
        ],
      };
    });
  },
};

/**
 * @param {object} options
 * @param {string} options.sourceDir 示例源码目录（examples/games/<name>）
 * @param {string} options.distDir   构建输出目录（<sourceDir>/dist）
 * @param {string} options.entry     相对 sourceDir 的 TS 入口
 * @param {string} options.outfile   相对 distDir 的产物路径
 * @param {string[]} [options.remove] 不进入安装包的目录（相对 distDir），默认 ["src"]
 */
export async function bundleGameEntry({
  sourceDir,
  distDir,
  entry,
  outfile,
  remove = ["src"],
}) {
  const entryPoint = join(sourceDir, entry);
  if (!existsSync(entryPoint)) {
    throw new Error(`缺少入口：${entryPoint}`);
  }
  const outfilePath = join(distDir, outfile);
  mkdirSync(dirname(outfilePath), { recursive: true });
  // esbuild 在受限环境下无法直接落盘到新建目录：写成内存产物，由 Node 落盘。
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    write: false,
    plugins: [lullResolver],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: {
      js: `// Built from ${entry} by pnpm games:samples:build; do not edit.`,
    },
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`esbuild 没有产出：${entry}`);
  writeFileSync(outfilePath, output.contents);
  for (const relative of remove) {
    rmSync(join(distDir, relative), { recursive: true, force: true });
  }
  return outfilePath;
}
