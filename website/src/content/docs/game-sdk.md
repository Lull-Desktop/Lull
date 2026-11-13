---
title: Game SDK(Beta)
description: 用「静态 Web 包 + game.json」写一个桌面环境游戏：三个角色的分工、能力授权、Authority 接入、引擎适配与打包边界。
order: 6
group: 扩展开发
source: docs/game-sdk.md
---

> 状态：**Experimental**。P1–P3 已落地，四类渲染适配器（Canvas2D / Phaser / PixiJS / Three.js）可用；
> 控制器支持每个游戏多窗口（包内页面或 Widget）。SDK 在实验阶段不承诺向后兼容，
> 破坏性变更会在更新日志里标注。

## 这是什么

一个 Lull 游戏就是**一个静态 Web 包 + 一份 `game.json`**。逻辑、渲染与操作分别由三个角色承担：

```text
Game Package
  ├─ authority 入口   逻辑权威：接收命令、推进模拟、提交状态        （必需）
  ├─ replica 入口     可选：游戏自带的渲染器
  └─ controllers[]   控制器窗口：包内页面或独立 Widget 包            （0–8 个）
```

| 角色 | 运行位置 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Authority | 隐藏窗口内的沙箱 iframe | 读快照、收命令与 tick、提交状态与事件 | 写文件、建窗、读宿主配置 |
| Replica | 壁纸窗口里的场景 iframe | 读快照/事件/渲染态、绘制 | 提交状态、发命令、访问宿主 |
| Controller | 专用窗口或 Widget 窗口内的沙箱 iframe | 读快照/事件、发命令 | 写状态、启停实例、删存档 |

一个实例只有一个 Authority；每个显示器各自一个 Replica，但消费**同一份**权威状态。
Authority 与显示器解耦，因此热插拔显示器不会重启游戏。

## 包结构

```text
my-game/
  game.json                 # 必需
  authority/
    index.html              # entry.authority 指向它
    main.js
  replica/                  # 可选
    index.html
  controllers/              # 可选（包内控制器 UI）
    panel/index.html
  assets/                   # 图片、音频、字体、数据
  LICENSE
```

- 所有资源用相对路径；入口必须是包内 `.html`，禁止 `..`、绝对路径与反斜杠。
- 游戏包由 `lullgame://<id>/…` 只读服务，不能用 `file://`，也不能引用宿主资源。
- 发布时只分发构建产物（`dist/` 内容即包根）。游戏包、Scene 包、Widget 包彼此独立。

## game.json

```json
{
  "schemaVersion": 1,
  "type": "game",
  "id": "community.living-world",
  "name": "Living World",
  "version": "1.0.0",
  "license": "MIT",
  "hostApi": 1,
  "entry": { "authority": "authority/index.html", "replica": "replica/index.html" },
  "engine": { "id": "canvas2d", "adapter": "@lull/game-adapter-canvas", "renderMode": "canvas2d" },
  "runtime": { "authority": "host-tick", "tickMs": 1000, "replicas": true, "maxReplicas": 8 },
  "display": { "policy": "shared", "modes": ["mirror", "span"] },
  "capabilities": ["game.state.read", "game.state.write", "game.command.receive", "game.event.publish"],
  "commands": { "plant.seed": { "description": "种下一颗种子", "idempotent": true } },
  "events": { "world.changed": { "description": "世界状态变化" } },
  "state": { "schemaVersion": 1, "maxSizeBytes": 1048576 },
  "controllers": [
    {
      "id": "panel",
      "label": "Living World 控制台",
      "entry": "controllers/panel/index.html",
      "commands": ["plant.seed"],
      "window": { "width": 380, "height": 520 }
    }
  ]
}
```

关键约束：

| 字段 | 规则 |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9._-]{2,63}$`，与安装目录名一致，建议 `作者.游戏` |
| `hostApi` | 声明所需的最小宿主 API；高于当前宿主会被**明确拒绝**，不降级 |
| `runtime.authority` | `host-tick`（默认）或 `self-loop` |
| `display.policy` | 首期只接受 `shared` |
| `capabilities` | 非空、白名单内、去重 |
| `state.maxSizeBytes` | 单次提交上限，默认 1 MiB，硬上限 8 MiB |

**未知字段一律拒绝。** manifest 严格校验是为了让拼写错误在安装时暴露，而不是运行到一半才失效。

## 能力与授权

「声明」不等于「授权」：安装后由用户在扩展中心逐项授予，运行期以授权账本为准。

| 能力 | 谁需要 | 作用 |
| --- | --- | --- |
| `game.state.read` | 三个角色 | 读快照、订阅快照 |
| `game.state.write` | authority | 提交权威状态 |
| `game.command.receive` | authority | 接收命令并回传结果 |
| `game.event.publish` | authority | 发布事件 |
| `game.event.read` | replica / controller | 订阅事件 |
| `game.render.publish` | authority | 发布渲染态（只给 replica） |
| `game.network` | authority / replica | 按 `network` 声明放开远程源 |

宿主保留、不可申请：`game.authority.claim`、`game.instance.manage`、`game.storage.raw`、`game.window`。
外部 Controller Widget 另有 `game.command.send`，但拿不到写状态、启停实例、删存档、改授权的能力。

## Authority 接入

```ts
import { connectLullGame } from "@lull/game-sdk";

const game = await connectLullGame();
const snapshot = await game.getSnapshot<LivingWorldState>();
let world = snapshot?.state ?? createInitialWorld();

game.onLifecycle((event) => {
  // started / resumed / suspended / stopped / authority-changed / failed
  if (event.state === "resumed" && event.offlineMs) {
    world = settleOffline(world, event.offlineMs);
  }
});

game.onCommand("plant.seed", async (command) => {
  world = plantSeed(world, command.payload);
  const result = await game.commitState({
    state: world,
    events: [{ type: "world.changed", payload: { reason: "seed" } }],
  });
  await game.commandResult({ requestId: command.requestId, ok: result.ok });
});

game.onTick(async (tick) => {
  world = advance(world, tick.deltaMs);
  await game.commitState({ state: world, simulationTimeMs: tick.simulationTimeMs });
});

await game.reportReady(); // 宿主据此进入 running、开始 tick
```

`connectLullGame()` 只能在 authority 入口里调用。生命周期与命令有三条硬约定：

- `reportReady()` 之前宿主不会发 tick、命令或副本快照；`stopped` 之后还有 ≤3s 的最终提交窗口。
- 命令类型必须在 `game.json.commands` 里声明；`requestId` 由宿主生成并去重，你只需原样回传。
- 慢操作不要阻塞 `onCommand`：先落状态，副作用异步做，进度用事件或渲染态表达。

### host-tick 的确定性要求

不满足这四条，画面与存档在重放时会漂移：

1. 模拟只由 **tick 与命令**驱动，不要用 `setInterval` / `requestAnimationFrame` 推进游戏时间；
2. 随机数用 SDK 导出的 `createSeededRandom(seed)`，种子随存档持久化，不要用 `Math.random()`；
3. 不读 `Date.now()` 做游戏逻辑，需要墙钟时用 `tick.wallClockMs` 或 `lifecycle.offlineMs`；
4. 不要在 tick 里渲染，渲染交给 replica 或 render state。

## 开发、构建与打包

```bash
pnpm games:samples:build   <name>   # 校验 + 生成 dist
pnpm games:samples:check            # 校验 game.json 与体积预算（CI 同款）
pnpm games:samples:pack             # 写 .lull-integrity.json 并打 .lull-game.zip
pnpm games:samples:install <name>   # 安装到用户游戏目录
```

- 纯 Vite/esbuild 打包成静态产物即可，不需要 Lull 专属构建工具。
- 安装位置 `%APPDATA%\app.lull.desktop\games\<id>\`；单文件 ≤16 MiB、整包 ≤128 MiB、≤1024 文件。
- 更新同 id 包会保留旧存档；卸载默认也保留存档，用户可勾选一并删除。

## 版本兼容

`game.json.schemaVersion`、`hostApi`、SDK 与宿主间的线上协议、`state.schemaVersion` 四者相互独立。
升级游戏包版本**不会**自动迁移存档；新增可选字段不升协议版本，读取方忽略未知字段。
不支持的值一律明确报错，不静默降级。

## 注意与限制

- **浏览器里跑不起来是预期行为**：SDK 依赖宿主注入的上下文与 postMessage 桥，`connectLullGame()` 会抛 `not-connected`，浏览器预览只适合调 UI。
- **每个显示器不能显示不同世界**：`display.policy` 只支持 `shared`，壁纸的 `independent` 模式只切场景，不切游戏世界。
- **壁纸区域不接收点击**：游戏操作入口是 Controller 窗口与设置页；场景若只要视觉反馈，可读**仅移动**的指针位置。
- **不能自己开窗或读本地文件**：游戏包只能用 `lullgame://` 读自己的资源，所有宿主能力都必须经 Game SDK。
- **`publishRenderState` 只用于高频、只影响画面的数据**（插值坐标、粒子参数）；权威状态仍然只走 `commitState`。

常见错误码：`game.instance_not_running`（控制器先于游戏启动）、`command.unknown_type`（manifest 未声明）、
`command.timeout`、`state.too_large`、`state.commit_rate_limited`、`event.undeclared_type`、
`authority.epoch_mismatch`（旧权威的残留提交，不要重试）。
