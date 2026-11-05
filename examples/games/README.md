# Game Examples（示例游戏包）

```text
examples/games/<name>/
  game.json          # 清单（id / version / entry / runtime / capabilities）
  authority/         # 可选：authority 入口（entry.authority）
  replica/           # 可选：独立 replica 入口（P4，宿主入口尚未实现）
  build.mjs          # 可选：自定义构建钩子（复制 dist 后调用）
  dist/              # pnpm games:samples:build 生成（不入库）
```

## 命令

```bash
pnpm games:samples:build            # 校验并生成 examples/games/<name>/dist
pnpm games:samples:check            # 只校验，CI 用（写入 pnpm check）
pnpm games:samples:pack             # build + 打 .lull-game.zip + release/manifest.json
pnpm games:samples:install          # 安装 dist 到 %APPDATA%\app.lull.desktop\games\<id>\
```

指定示例：在命令后加目录名，例如 `pnpm games:samples:build living-world`。

## 发布产物

`pnpm games:samples:pack` 输出到 `examples/games/release/`（gitignored）：

```text
release/
  community.living-world-1.0.0.lull-game.zip
  community.stability-probe-1.0.0.lull-game.zip
  manifest.json
```

zip 结构：根目录直接是 `game.json` + 入口 + 资源，另含 `.lull-integrity.json`
（`sha256("lull-game-package\0" + id + "\0" + version + "\0" + files…)`，与 Rust
`game_package::digest` 同算法）。`manifest.json` 记录 zip 的 sha256、包摘要、
文件数与体积，供发布页或后续在线目录使用。

CI：[`.github/workflows/game-examples.yml`](../../.github/workflows/game-examples.yml)
在 `examples/games/**` 或打包脚本变化时自动执行 check/build/pack，并上传
`game-examples-release` artifact（保留 7 天）；签名与商店分发留给后续发布流程。

## 校验/预算

构建与打包共用 `scripts/lib/game-package.mjs`，按安装器当前实际预算执行：

- 单文件 ≤ 8 MiB、整包 ≤ 64 MiB、≤ 512 个文件；
- id 小写且 `game.json.type = "game"`、`schemaVersion = 1`、hostApi ≤ 1；
- `entry.authority`（及可选的 `entry.replica`）必须是包内相对 `.html` 且文件存在；
- 跳过 `dist/`、`node_modules/` 与所有点路径（摘要不覆盖）。

> 设计文档中的游戏专用 16/128 MiB/1024 文件预算尚未在 Rust 安装器落地；
> 本脚本按实际 8/64 MiB/512 执行，避免生成安装器会拒绝的包。

## 自定义构建

示例可提供 `build.mjs`：

```js
export default async function build({ sourceDir, distDir }) {
  // 用 esbuild 把 TypeScript/引擎依赖打进 dist
}
```

默认行为是直接复制静态文件；`build.mjs` 本身不会进入 dist，当前 `living-world` /
`stability-probe` 均为零构建。
