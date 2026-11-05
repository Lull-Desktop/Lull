# Ambient Embers · PixiJS（单包示例）

一个 zip 同时包含**逻辑**与**渲染**：

```text
pixi-demo/
  game.json              entry.authority + entry.replica
  authority/             零构建：host-tick 推进世界参数并提交
  replica/index.html     壁纸入口，加载构建产物 replica/main.js
  controllers/ambient-pixi/ 包内控制器（零构建，直接实现宿主壳 v1 协议）
  src/replica.ts         PixiJS 渲染源码（构建时打包）
  build.mjs              pnpm games:samples:build 的构建钩子
```

## 安装与运行

```bash
pnpm games:samples:build pixi-demo
pnpm games:samples:pack
pnpm games:samples:install pixi-demo
```

然后在设置页「游戏」启用 `Ambient Embers · PixiJS`，点「设为壁纸」。

## 它演示了什么

- 单包双入口：`entry.authority`（隐藏窗口，host-tick）与 `entry.replica`（可见壁纸）。
- `@lull/game-adapter-pixi`：`render.viewport` → `Application.init/resize`（`resolution = dpr`、
  `autoDensity: true`）、`suspended/stopped/failed` → `app.ticker.stop()`、
  `resumed/running` → `app.ticker.start()`、`destroy` → `app.destroy()`。
- 权威只下发**世界参数**（火星布局、`phase`、`intensity`），replica 用本地时间插值动画。

## 控制器（输入）

游戏清单用 `controllers[]` 声明包内控制器：

```json
"controllers": [
  {
    "id": "ambient-pixi",
    "label": "Pixi 控制台",
    "entry": "controllers/ambient-pixi/index.html",
    "commands": ["embers.pulse", "embers.reseed"],
    "window": { "width": 360, "height": 460 }
  }
]
```

UI 随游戏包分发，宿主用 `/game-controller` 壳 + sandbox iframe 承载，不需要安装 Widget。
运行中实例的操作区会出现该控制器的开关；打开后它读取快照、发命令给权威。
`games.json.controllerFollowsGame` 默认开启，显式启动游戏时会自动打开 `autoOpen` 控制器，
停止时回收该游戏全部控制器窗口。托盘「设置 ▸ 游戏控制器」列出所有运行中游戏的控制器。

本示例使用独立的 controller id、初始 `seed=22`、22 个火星和青绿/粉紫色相；与
Phaser / Three.js 示例同时运行时，控制器窗口、状态和事件都按游戏隔离。控制器
标题栏会显示 `gameId · controllerId · instanceId`，可直接确认它连接的是哪个实例。

## 注意

- **必须 `import "pixi.js/unsafe-eval"`**：PixiJS 8 默认用 `new Function` 生成 uniform/UBO/shader
  同步代码，而 LULL 的游戏 CSP 不允许 `unsafe-eval`。这个名字相反的入口会换成不使用 eval 的
  polyfill（`_unsafeEvalCheck` 被覆盖），包体积几乎不变。
- `replica/main.js` 是构建产物，不在源码目录里；请使用 `dist/`（安装脚本已默认使用）。
- 浏览器直接打开 `replica/index.html` 时没有宿主，页面只显示静态背景与提示。
