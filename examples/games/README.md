# Game Examples（示例游戏包）

```text
examples/games/<name>/
  game.json          # 清单（id / version / entry / runtime / capabilities）
  authority/         # authority 入口（entry.authority，隐藏/后台窗口）
  replica/           # 可选：壁纸可见渲染入口（entry.replica）
  controllers/       # 可选：包内控制器页面（controllers[].entry）
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
  community.living-world-1.2.0.lull-game.zip
  community.stability-probe-1.0.3.lull-game.zip
  community.phaser-demo-1.2.0.lull-game.zip
  community.pixi-demo-1.2.0.lull-game.zip
  community.three-demo-1.2.0.lull-game.zip
  manifest.json
```

**一个包同时包含逻辑与渲染**：`entry.authority` 在隐藏/后台窗口运行，
`entry.replica` 由壁纸宿主直接挂载；设置页「游戏 → 设为壁纸」即可，不需要另装场景。

## 引擎示例（P4）

| 示例 | 引擎 | 适配器 | 包大小（replica 产物） |
| --- | --- | --- | --- |
| `phaser-demo` | Phaser 3.90 | `@lull/game-adapter-phaser` | 1.2 MiB |
| `pixi-demo` | PixiJS 8.22 | `@lull/game-adapter-pixi` | 565 KiB |
| `three-demo` | Three.js r186 | `@lull/game-adapter-three` | 556 KiB |

三者玩法与 host-tick authority 结构一致（火星布局 + `phase` + `intensity`），
replica 各自用引擎渲染；但各自有独立的控制器 id / label、初始 seed、火星数量和
渲染色相，方便同时运行多个示例时从界面和数据上区分。都演示了"权威下发世界参数、
replica 本地插值"的写法。
`pixi-demo` 必须先 `import "pixi.js/unsafe-eval"` —— LULL 的游戏 CSP 不允许
`unsafe-eval`，该入口用 polyfill 替代内部的 `new Function`。

## 控制器（游戏输入）

游戏清单用 `controllers[]` 声明 0–8 个控制器窗口。示例统一使用**包内页面**：

```json
"controllers": [
  {
    "id": "panel",
    "label": "Living World 控制台",
    "entry": "controllers/panel/index.html",
    "commands": ["plant.seed", "plant.water"],
    "window": { "width": 380, "height": 520 }
  }
]
```

- **包内载体**（`entry`）：UI 随游戏包分发，宿主用 `/game-controller` 壳 + sandbox
  iframe 承载；页面用 `@lull/game-sdk/controller`（或直接实现壳协议）。
- 运行时仍支持 `widgetId` 载体（UI 在独立 Widget 包），但示例不再分发控制器 Widget；
  第三方游戏需要时仍可按 `docs/game-sdk.md` §6.3 声明。
- 只有**运行中**的游戏能打开/连接控制器：停止/失败时宿主先广播
  `lifecycle(stopped|failed)`，再销毁该游戏全部控制器窗口。
- 设置页只在运行中实例的操作区显示开关；托盘「设置 ▸ 游戏控制器」列出所有运行中
  游戏的控制器，壁纸激活的游戏排前。
- `games.json.controllerFollowsGame`（默认开）：显式启动游戏时自动打开 `autoOpen` 控制器，
  停止时回收该游戏全部控制器窗口。
- `pnpm games:samples:install` 只安装游戏包；包内控制器随包安装，不需要额外装 Widget。

| 控制器示例 | 载体 | 服务的游戏 | 命令 |
| --- | --- | --- | --- |
| [`examples/games/living-world/controllers/panel`](living-world/controllers/panel) | 包内 | `community.living-world` | `plant.seed` / `plant.water` |
| [`examples/games/phaser-demo/controllers/ambient-phaser`](phaser-demo/controllers/ambient-phaser) | 包内 | `community.phaser-demo` | `embers.pulse` / `embers.reseed` |
| [`examples/games/pixi-demo/controllers/ambient-pixi`](pixi-demo/controllers/ambient-pixi) | 包内 | `community.pixi-demo` | `embers.pulse` / `embers.reseed` |
| [`examples/games/three-demo/controllers/ambient-three`](three-demo/controllers/ambient-three) | 包内 | `community.three-demo` | `embers.pulse` / `embers.reseed` |

> 控制器 id 与命令名都只在**游戏包内**唯一；宿主窗口 label 带 gameId hash，
> 不同游戏复用同一个 id/命令名也不会共享 binding、token 或事件。三个示例改用
> 独立 id/label 只是为了让多控制器窗口更容易区分。

zip 结构：根目录直接是 `game.json` + 入口 + 资源，另含 `.lull-integrity.json`
（`sha256("lull-game-package\0" + id + "\0" + version + "\0" + files…)`，与 Rust
`game_package::digest` 同算法）。`manifest.json` 记录 zip 的 sha256、包摘要、
文件数与体积，供发布页或后续在线目录使用。

CI：[`.github/workflows/game-examples.yml`](../../.github/workflows/game-examples.yml)
在 `examples/games/**` 或打包脚本变化时自动执行 check/build/pack，并上传
`game-examples-release` artifact（保留 7 天）；签名与商店分发留给后续发布流程。

## 校验/预算

构建与打包共用 `scripts/lib/game-package.mjs`，按安装器的游戏包预算执行：

- 单文件 ≤ 16 MiB、整包 ≤ 128 MiB、≤ 1024 个文件；
- id 小写且 `game.json.type = "game"`、`schemaVersion = 1`、hostApi ≤ 1；
- `entry.authority`（及可选的 `entry.replica`）必须是包内相对 `.html` 且文件存在；
- 跳过 `dist/`、`node_modules/` 与所有点路径（摘要不覆盖）。

> 安装器按包内是否含 `game.json` 自动选择预算：游戏包 16/128 MiB/1024，
> scene/widget 仍为 8/64 MiB/512。

## 自定义构建

示例可提供 `build.mjs`：

```js
export default async function build({ sourceDir, distDir }) {
  // 用 esbuild 把 TypeScript/引擎依赖打进 dist
}
```

默认行为是直接复制静态文件；`build.mjs` 本身不会进入 dist。
`living-world` / `stability-probe` 为零构建；`phaser-demo` / `pixi-demo` / `three-demo`
用 `build.mjs` + esbuild 把 `src/replica.ts` 与引擎依赖打成单个 `replica/main.js`
（esbuild 以 `write: false` 返回内存产物、由 Node 落盘，`dist/src` 会被清理）。
