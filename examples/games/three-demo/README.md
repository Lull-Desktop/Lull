# Ambient Embers · Three.js（单包示例）

一个 zip 同时包含**逻辑**与**渲染**：

```text
three-demo/
  game.json              entry.authority + entry.replica
  authority/             零构建：host-tick 推进世界参数并提交
  replica/index.html     壁纸入口，加载构建产物 replica/main.js
  controllers/ambient/   包内控制器（零构建，直接实现宿主壳 v1 协议）
  src/replica.ts         Three.js 渲染源码（构建时打包）
  build.mjs              pnpm games:samples:build 的构建钩子
```

## 安装与运行

```bash
pnpm games:samples:build three-demo
pnpm games:samples:pack
pnpm games:samples:install three-demo
```

然后在设置页「游戏」启用 `Ambient Embers · Three.js`，点「设为壁纸」。

## 它演示了什么

- 单包双入口：`entry.authority`（隐藏窗口，host-tick）与 `entry.replica`（可见壁纸）。
- `@lull/game-adapter-three`：自己驱动 rAF（`maxFps: 30`）、`setPixelRatio(dpr)` +
  `setSize(width, height, false)`、`suspended/stopped/failed` 停帧、
  `resumed/running` 恢复、`destroy` → `renderer.dispose()`。
- 相机 aspect 在 `onFrame` 里跟随 canvas backing store，显示器几何变化后不会拉伸。
- 权威只下发**世界参数**（火星布局、`phase`、`intensity`），动画在 replica 本地推进。

## 控制器（输入）

游戏清单用 `controllers[]` 声明包内控制器：

```json
"controllers": [
  {
    "id": "ambient",
    "label": "Ambient Embers · Three.js 控制台",
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

- `replica/main.js` 是构建产物，不在源码目录里；请使用 `dist/`（安装脚本已默认使用）。
- 浏览器直接打开 `replica/index.html` 时没有宿主，页面只显示静态背景与提示。
