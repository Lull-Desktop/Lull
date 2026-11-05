# Ambient Embers · Phaser（单包示例）

一个 zip 同时包含**逻辑**与**渲染**：

```text
phaser-demo/
  game.json              entry.authority + entry.replica
  authority/             零构建：host-tick 推进世界参数并提交
  replica/index.html     壁纸入口，加载构建产物 replica/main.js
  controllers/ambient/   包内控制器（零构建，直接实现宿主壳 v1 协议）
  src/replica.ts         Phaser 渲染源码（构建时打包）
  build.mjs              pnpm games:samples:build 的构建钩子
```

## 安装与运行

```bash
pnpm games:samples:build phaser-demo
pnpm games:samples:pack
pnpm games:samples:install phaser-demo
```

然后在设置页「游戏」启用 `Ambient Embers · Phaser`，点「设为壁纸」——
两块显示器都会直接渲染包内 `entry.replica`，不需要另装场景。

## 它演示了什么

- 单包双入口：`entry.authority`（隐藏窗口，host-tick）与 `entry.replica`（可见壁纸）。
- `@lull/game-adapter-phaser`：`render.viewport` → Phaser 尺寸、`suspended/stopped/failed` →
  `game.loop.sleep()`、`resumed/running` → `game.loop.wake()`、`destroy` → `game.destroy(true)`。
- 权威只下发**世界参数**（火星布局、`phase`、`intensity`），replica 用本地时间插值，
  所以 1s tick 也保持顺滑；replica 永远不写状态。

## 控制器（输入）

游戏清单用 `controllers[]` 声明包内控制器：

```json
"controllers": [
  {
    "id": "ambient",
    "label": "Ambient Embers · Phaser 控制台",
    "entry": "controllers/ambient/index.html",
    "commands": ["embers.pulse", "embers.reseed"],
    "window": { "width": 360, "height": 460 }
  }
]
```

UI 随游戏包分发，宿主用 `/game-controller` 壳 + sandbox iframe 承载，不需要安装 Widget。
运行中实例的操作区会出现该控制器的开关；打开后它读取快照、发命令给权威。
`games.json.controllerFollowsGame` 默认开启，显式启动游戏时会自动打开 `autoOpen` 控制器，
停止时回收该游戏全部控制器窗口。托盘「设置 ▸ 游戏控制器」列出所有运行中游戏的控制器。

## 注意

- Phaser 3 的 Scale Manager 以 CSS 像素为基准，不直接使用 `devicePixelRatio`；
  需要更锐利的画面可改用 PixiJS / Three.js 示例，或自行调整渲染分辨率。
- `replica/main.js` 是构建产物，不在源码目录里；直接安装源码目录不会得到可渲染的副本，
  请使用 `dist/`（`pnpm games:samples:install` 已默认使用它）。
- 浏览器直接打开 `replica/index.html` 时没有宿主，`connectLullGameRender()` 返回 `null`，
  页面只显示静态背景与提示。
