# Game SDK

> 状态：**P1–P3 已落地，P4 四类渲染适配器已落地｜Experimental**；控制器支持每游戏多窗口（包内页面或 Widget），其余引擎矩阵的真机长跑仍待补。
> SDK 实现：[`packages/game-sdk`](../packages/game-sdk/README.md)｜宿主设计：[Game Runtime 设计](./game-runtime.md)。
> 面向第三方游戏作者：包结构 → `game.json` → 角色 API → 场景/Widget 接入 → 引擎适配 → 安全边界。

## 这是什么

一个 Lull 游戏 = 一个静态 Web 包 + 一份 `game.json`。逻辑、渲染与操作分别由三个角色承担：

```text
Game Package
  ├─ authority 入口   逻辑权威：接收命令、推进模拟、提交状态        （必需）
  ├─ replica 入口     可选：游戏自带的渲染器                         （P4）
  └─ controllers[]   控制器窗口：包内页面或独立 Widget 包            （0–8 个）
```

运行位置：

| 角色 | 运行位置 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Authority | 隐藏窗口 `game-authority-<hex>` 内的沙箱 iframe | 读快照、收命令/tick、提交状态与事件 | 写文件、建窗、读宿主配置、绕过 Host 提交 |
| Replica | 壁纸窗口里的场景 iframe（或 P4 的独立 replica iframe） | 读快照/事件/渲染态、绘制 | 提交状态、发命令、访问宿主 |
| Controller | `game-controller-<hash>-<id>`（包内 UI）或 `widget-<id>` 窗口内的沙箱 iframe | 读快照/事件、发命令 | 写状态、启停实例、删存档 |

一个游戏实例只有一个 Authority；多个显示器各自一个 Replica，但消费**同一份**权威状态。Authority 与显示器解耦，显示器热插拔不会重启游戏。

## 1. 包结构

```text
my-game/
  game.json                 # 必需
  authority/
    index.html              # entry.authority 指向它
    main.js
  replica/                  # 可选（P4 独立渲染路径）
    index.html
    main.js
  controllers/              # 可选（包内控制器 UI，见 §6）
    panel/
      index.html
      main.js
  assets/                   # 图片、音频、字体、数据
  LICENSE                   # 建议
  README.md                 # 建议
```

约定：

- 所有资源使用相对路径；入口必须是包内 `.html`，禁止 `..`、绝对路径、反斜杠。
- 游戏包由 `lullgame://<id>/...` 只读服务；不能用 `file://`、不能引用宿主资源。
- 发布时只分发构建产物（`dist/` 内容即包根）；`games/` 目录不是新的 Scene/Widget 目录，不要混用。
- 游戏包与 Scene 包、Widget 包**彼此独立**：一个游戏可以有多个视觉 Scene，也可以声明多个控制器（包内页面或 Widget 载体）。

## 2. game.json

```json
{
  "schemaVersion": 1,
  "type": "game",
  "id": "community.living-world",
  "name": "Living World",
  "version": "1.0.0",
  "description": "低频交互式桌面生态游戏",
  "author": "Community",
  "license": "MIT",

  "hostApi": 1,

  "entry": {
    "authority": "authority/index.html",
    "replica": "replica/index.html"
  },

  "engine": {
    "id": "canvas2d",
    "version": "1.0.0",
    "adapter": "@lull/game-adapter-canvas",
    "renderMode": "canvas2d"
  },

  "runtime": {
    "authority": "host-tick",
    "tickMs": 1000,
    "replicas": true,
    "maxReplicas": 8,
    "commit": { "flushMs": 1000 }
  },

  "display": {
    "policy": "shared",
    "modes": ["mirror", "span"]
  },

  "capabilities": [
    "game.state.read",
    "game.state.write",
    "game.command.receive",
    "game.event.publish",
    "game.event.read",
    "game.render.publish"
  ],

  "commands": {
    "plant.seed": { "description": "种下一颗种子", "idempotent": true, "timeoutMs": 3000 },
    "plant.water": { "description": "浇水", "idempotent": true }
  },

  "events": {
    "world.changed": { "description": "世界状态变化" },
    "task.completed": { "description": "任务完成" }
  },

  "state": { "schemaVersion": 1, "maxSizeBytes": 1048576 },

  "controllers": [
    {
      "id": "panel",
      "label": "Living World 控制台",
      "entry": "controllers/panel/index.html",
      "commands": ["plant.seed", "plant.water"],
      "window": { "width": 380, "height": 520 }
    }
  ],

  "network": []
}
```

### 2.1 字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 固定 `1`；不支持直接拒绝 |
| `type` | ✅ | 固定 `"game"` |
| `id` | ✅ | `^[a-z0-9][a-z0-9._-]{2,63}$`；安装目录名必须一致；建议 `作者.游戏` |
| `name` | ✅ | 设置页显示名 |
| `version` | ✅ | 语义化版本 |
| `description` | — | 设置页/扩展中心说明 |
| `author` | — | 署名 |
| `license` | ✅ | SPDX 标识或许可证名 |
| `hostApi` | ✅ | 最小宿主 API；高于当前宿主 → 明确拒绝 |
| `entry.authority` | ✅ | Authority 入口，相对 `.html` |
| `entry.replica` | — | 游戏自带渲染入口，相对 `.html`；壁纸宿主可直接加载，无需 Scene |
| `engine.id` | — | 开放字符串（不枚举）；缺省 `custom` |
| `engine.version` | — | 引擎版本范围（仅展示与开发者自检） |
| `engine.adapter` | — | 适配器包名（仅元数据；宿主**不加载**） |
| `engine.renderMode` | — | `canvas2d` / `webgl` / `webgpu` / `dom` / `custom`，缺省 `canvas2d` |
| `runtime.authority` | ✅ | `host-tick`（默认）或 `self-loop`（P3 experimental） |
| `runtime.tickMs` | — | host-tick 间隔，200–60000，默认 1000 |
| `runtime.replicas` | — | 是否允许渲染副本，默认 `true` |
| `runtime.maxReplicas` | — | 1–16，默认 8 |
| `runtime.commit.flushMs` | — | 合并落盘间隔，250–10000，默认 1000 |
| `display.policy` | ✅ | 首期只接受 `shared` |
| `display.modes` | — | `mirror` / `span` 的子集，默认两者 |
| `capabilities` | ✅ | 非空、白名单内、去重；见 §3 |
| `commands` | ✅ | 允许的命令类型；可为空对象（不接受操作的游戏） |
| `events` | — | 允许发布的事件类型；发布未声明类型会被拒绝 |
| `state.schemaVersion` | ✅ | 存档结构版本，游戏自己维护 |
| `state.maxSizeBytes` | — | 单次提交上限，默认 1 MiB，硬上限 8 MiB（只能收紧） |
| `controller.widgetId` | — | 旧版单数声明（deprecated）：归一化为 `controllers=[{id:"default",…}]` |
| `controller.label` | — | 同上 |
| `controllers` | — | 0–8 个控制器窗口；`entry`（包内页面）或 `widgetId`（外部 Widget）二选一，见 §6 |
| `network` | — | `https://` / `wss://` 源列表；需要 `game.network` 能力且被授权才生效 |

**未知字段一律拒绝。** manifest 严格是为了让拼写错误在安装时暴露，而不是运行到一半才失效。

### 2.2 版本与兼容

- `schemaVersion` / `hostApi` / `version` / `state.schemaVersion` 四个版本相互独立。
- 升级游戏包版本**不会**自动迁移存档；`state.schemaVersion` 变化时旧存档会拒绝加载，P5 才提供迁移机制。
- 引擎版本升级与存档迁移没有因果关系：换渲染器不需要动存档，除非你自己改了状态结构。

## 3. 能力与授权

“声明”不等于“授权”。安装后由用户在扩展中心/设置页逐项授予，运行期以授权账本为准。

### 游戏包能力

| 能力 | 谁需要 | 作用 |
| --- | --- | --- |
| `game.state.read` | authority / replica / controller | 读快照、订阅快照 |
| `game.state.write` | authority | 提交权威状态 |
| `game.command.receive` | authority | 接收命令并回传结果 |
| `game.event.publish` | authority | 发布事件 |
| `game.event.read` | replica / controller | 订阅事件 |
| `game.render.publish` | authority | 发布渲染态（只给 replica） |
| `game.network` | authority / replica | 按 `network` 声明放开远程源 |

### 宿主保留、不可申请

`game.authority.claim`、`game.instance.manage`、`game.storage.raw`、`game.window`。

### 外部 Controller Widget 能力（可选）

Widget 包（`widget.json`）声明以下能力，用户授权后生效：

| 能力 | 作用 |
| --- | --- |
| `game.state.read` | 读快照、订阅快照/事件 |
| `game.command.send` | 发送命令 |
| `game.event.read` | 订阅游戏事件 |

Widget 拿不到写状态、启停实例、删除存档、修改授权的能力——这些是宿主控制面（设置页/扩展中心）的职责。

> 游戏包与 Widget 的能力名相同但作用域不同：游戏包的 `game.state.read` 决定 authority/replica 能读什么；Widget 的 `game.state.read` 决定控制器能读什么。两者各自授权、互不继承。

## 4. Authority 接入

### 4.1 连接

```ts
import { connectLullGame } from "@lull/game-sdk";

const game = await connectLullGame();

console.log(game.context);
// {
//   protocol: 1, hostApi: 1, role: "authority",
//   gameId: "community.living-world", instanceId: "0192...",
//   authorityId: "6f1c...", authorityEpoch: 3,
//   revision: 42, simulationTimeMs: 1234567,
//   render: null, locale: "zh-CN", limits: { ... }
// }
```

`LullGameClient` 暴露：`context`、`getSnapshot()`、`onSnapshot()`、`onEvent()`、`onCommand()`、`onTick()`、`onLifecycle()`、`commitState()`、`publishEvent()`、`publishRenderState()`、`commandResult()`、`reportReady()`、`reportError()`、`destroy()`。

`connectLullGame()` 只能在 authority 入口（`entry.authority`）里调用；在浏览器直接打开（非宿主 iframe）会抛 `not-connected`，便于本地调试时快速发现。

### 4.2 生命周期

```ts
const snapshot = await game.getSnapshot<LivingWorldState>();
let world: LivingWorldState = snapshot?.state ?? createInitialWorld();

game.onLifecycle((event) => {
  // started / resumed / suspended / stopped / authority-changed / failed
  if (event.state === "resumed" && event.offlineMs) {
    world = settleOffline(world, event.offlineMs);
  }
});

await game.reportReady(); // 宿主据此进入 running、开始 tick、向 replica 发首帧
```

- `reportReady()` 之前宿主不会发 tick、命令或副本快照。
- `stopped` 到达后宿主会等待最终提交（≤3s），之后销毁窗口；此时 `commitState` 返回 `game.instance_not_running`。
- `authority-changed` 通知 replica / controller "世界换了权威"；旧权威窗口在 failover 时已被销毁，不要依赖旧窗口收到该事件。新权威拿到的是 `started`/`resumed`。

### 4.3 命令

```ts
game.onCommand("plant.seed", async (command) => {
  const { seedId, position } = command.payload as PlantSeedPayload;
  world = plantSeed(world, seedId, position);

  const result = await game.commitState({
    state: world,
    events: [{ type: "world.changed", payload: { reason: "seed", seedId } }],
  });

  await game.commandResult({
    requestId: command.requestId,
    ok: result.ok,
    result: result.ok ? { revision: result.revision } : undefined,
    error: result.ok ? undefined : result.error?.code,
  });
});
```

约定：

- 命令类型必须在 `game.json.commands` 里声明；未声明类型在进入 Authority 之前就被 Host 拒绝。
- `requestId` 由 Host 生成并保证去重；你只需原样回传。
- 同一命令**可能**因为超时被用户重试，但 Host 不会把重复 requestId 再投一次；你的逻辑不必额外做去重，但仍建议处理"同一业务意图多次到达"（例如种子 id 已存在时幂等返回）。
- 每个命令有超时（默认 5s，可由 `commands.<type>.timeoutMs` 收紧到 ≤8s）；超时后 Host 不再等待结果，但已经发生的提交不会撤回。
- 慢操作不要阻塞 `onCommand`：先落状态再异步做副作用；需要长任务时用事件/渲染态表达进度。

### 4.4 host-tick 模式（P1–P2）

```ts
game.onTick(async (tick) => {
  // tick.simulationTimeMs：宿主推进后的游戏时间建议值
  // tick.deltaMs：距上次 tick 的墙钟差（首次为 0）
  // tick.wallClockMs：宿主墙钟
  world = advance(world, tick.deltaMs);
  await game.commitState({ state: world, simulationTimeMs: tick.simulationTimeMs });
});
```

`host-tick` 的确定性约定（不满足会导致画面/存档在重放时漂移）：

1. **模拟只由 tick 与命令驱动**；不要用 `setInterval` / `requestAnimationFrame` / `setTimeout` 推进游戏时间。
2. 需要随机数时使用 `createSeededRandom(seed)`（`@lull/game-sdk` 导出），种子随存档持久化；不要直接用 `Math.random()`。
3. 不读取 `Date.now()` 做游戏逻辑；需要墙钟时用 `tick.wallClockMs` 或 `lifecycle.offlineMs`。
4. 不要在 tick 里做渲染；渲染交给 replica 或 render state。
5. 单次 tick 的提交最多一次；高频变化先累积，再在 tick 里合并提交。

`self-loop`（P3）则相反：由游戏自己驱动循环，宿主只做提交校验与限流。在 `self-loop` 下 `onTick` 不会触发。

### 4.5 提交状态

```ts
type GameStateUpdate<T> = {
  state: T;                       // 必需：新的完整状态
  simulationTimeMs?: number;      // 建议填；缺省沿用上次
  events?: Array<{ type: string; payload: unknown }>;   // ≤32 条
  renderState?: unknown;          // ≤64 KiB，不落盘
  baseRevision?: number;          // 一般不用填；SDK 默认使用最近一次已知 revision
};

type GameCommitResult = {
  ok: boolean;
  revision: number;               // 成功时为新 revision；失败时为当前 revision
  error?: { code: string; message?: string };
  deduplicated?: boolean;
};
```

- SDK 自动填充 `authorityId` / `authorityEpoch` / `baseRevision`，并在成功后更新 `game.context.revision`。
- 失败不要重试到死：`state.revision_conflict` 说明你的基准过期（通常不该发生），刷新快照后合并；`state.too_large` 请压缩状态；`state.commit_rate_limited` 请降低提交频率。
- **不要每帧提交**：状态提交会落盘、广播快照；高频画面变化走 `publishRenderState`。
- 提交是"整份状态覆盖"，不是增量补丁；Host 只做版本与大小校验。

### 4.6 事件与渲染态

```ts
// 低频、有语义的事件（会进事件流、给 replica 与 controller）
await game.publishEvent("task.completed", { taskId: "water-3", coins: 5 });

// 高频、只影响画面的状态（不进事件流、不落盘、可丢帧）
await game.publishRenderState({
  plants: world.plants.map((plant) => ({
    id: plant.id,
    x: plant.x,
    y: plant.y,
    sway: Math.sin(world.simulationTimeMs / 800 + plant.id.length),
  })),
});
```

- 事件类型必须在 `game.json.events` 声明；单条 ≤16 KiB。
- 渲染态按"最新覆盖"投递，允许丢中间帧；**不要**把权威状态塞进渲染态（replica 不能反向写）。
- 渲染态不是存档：宿主重启或 replica 重建后不会重放，replica 必须能从快照重新绘制。

### 4.7 离线结算

```ts
game.onLifecycle((event) => {
  if (event.state !== "resumed" || !event.offlineMs) return;
  world = settle(world, Math.min(event.offlineMs, 7 * 24 * 3600_000));
  void game.commitState({ state: world });
});
```

- `offlineMs` 由宿主按 `lastCommittedAt` 墙钟差计算，默认上限 7 天（可配到 30 天）。
- 不要逐帧重放离线时间；按时间差一次结算。
- 首次启动没有存档时不会收到 `resumed`。

### 4.8 错误上报

```ts
await game.reportError({ code: "render.context-lost", message: "WebGL 上下文丢失" });
```

上报只用于诊断与状态展示，不会触发权威 failover；真正的崩溃由宿主心跳/窗口销毁检测。

## 5. Replica 接入（包内入口 / Scene）

> **P4 已落地**：`@lull/game-sdk/scene` 的 `connectLullGameRender()`、场景 manifest
> `game` 绑定与 `game.*` 桥消息可用；壁纸宿主也能直接加载游戏包的
> `entry.replica`（不需要 Scene）。游戏未运行时 resolve 为 `null`，渲染入口应回退到静态视觉。

宿主支持两种 replica 来源，消息协议完全相同：

| 来源 | 配置 | 适用 |
| --- | --- | --- |
| 包内 `entry.replica` | `display.game = <id>`；independent 下也可写 `monitors[<device>].game`（设置页 / 壁纸库「壁纸类型」） | 完整的单包游戏，逻辑与渲染一起分发 |
| Scene 绑定 | 场景 manifest 的 `game: { id, role: "replica" }` | 可换主题的视觉层；Scene 可选，不是显示游戏的必需品 |

两种来源都由宿主 top-level 页执行 `game_connect`，iframe 只拿到只读的
`game.init/snapshot/event/render/lifecycle`；提交能力始终留在 authority 窗口。

### 5.1 场景绑定

场景包在清单里声明绑定（场景宿主 API 2 起）：

```json
{
  "schemaVersion": 1,
  "type": "scene",
  "id": "community.living-world-forest",
  "name": "Living World · 森林",
  "version": "1.0.0",
  "license": "CC-BY-4.0",
  "capabilities": ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.script", "wallpaper.params"],
  "compatibility": { "hostApi": 2, "platforms": ["windows"] },
  "game": { "id": "community.living-world", "role": "replica" }
}
```

规则：

- `game.role` 只能是 `"replica"`；场景永远不能成为 Authority。
- 声明 `game` 必须同时声明 `wallpaper.script`，否则清单校验失败。
- 一个游戏可以被多个场景绑定（不同视觉主题）；一个场景只能绑定一个游戏。
- 场景被选中不等于游戏被启动：宿主按 `autoStartWithWallpaper` 决定是否自动 `game_start`；未运行时场景应回退到自己的静态视觉。
- 使用 `game` 绑定要求 `compatibility.hostApi >= 2`；老宿主会在清单解析阶段跳过该场景（记为目录 issue），这是预期行为。

### 5.2 渲染桥

```ts
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (!game) {
  drawIdleScene();           // 没有运行中的实例 / 当前场景未绑定
} else {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
  const ctx = canvas.getContext("2d")!;

  // 渲染上下文：显示模式、跨屏画布、本屏矩形、视口与 DPR
  fitCanvas(canvas, game.render);

  const snapshot = await game.getSnapshot<LivingWorldState>();
  if (snapshot) drawWorld(ctx, snapshot.state, game.render);

  game.onSnapshot((next) => drawWorld(ctx, next.state, game.render));
  game.onEvent("task.completed", (event) => toast(event.payload));
  game.onRenderState((render) => animateTo(ctx, render));
  game.onLifecycle((event) => {
    if (event.state === "stopped") drawIdleScene();
  });
}
```

`LullGameRenderClient` 暴露：`context`、`render`、`getSnapshot()`、`onSnapshot()`、`onEvent()`、`onRenderState()`、`onLifecycle()`、`requestSnapshot()`、`destroy()`。

`connectLullGameRender()` 在以下情况 resolve 为 `null`（不是抛错）：

- 浏览器预览/非桌面宿主；
- 场景没有声明 `game`；
- 对应游戏实例未运行；
- replica 数量已达上限。

连接成功时宿主的 `game.init` 已带首份快照，`getSnapshot()` 不会因为"刚连上"而返回 null（实例恰好在连接后停止的情况除外）。

### 5.3 渲染上下文

```ts
type GameRenderContext = {
  protocol: 1;
  displayId: string;              // 显示器设备名，用于诊断
  mode: "mirror" | "span";
  canvas: { x: number; y: number; w: number; h: number };  // 物理像素，可为负
  view: { x: number; y: number; w: number; h: number };
  viewport: { width: number; height: number; dpr: number };
};
```

- `canvas` / `view` 是**物理像素桌面坐标**，语义与 SceneFrame 完全一致；不要自己再算一套。
- `span` 下 `canvas` 是虚拟桌面并集、`view` 是本屏矩形；按 `view` 裁剪画布。
- `mirror` 下 `canvas === view`，按视口渲染完整世界。
- 壁纸 `independent` 模式对游戏没有"独立世界"含义：每屏仍是同一实例，只是渲染视口不同。

### 5.4 消息类型

```ts
type GameSnapshot<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  simulationTimeMs: number;
  state: T;
};

type GameEvent<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  eventId: string;              // 宿主生成，形如 `${instanceId}:${revision}:${seq}`
  revision: number;
  authorityEpoch: number;
  type: string;
  payload: T;
  simulationTimeMs: number;
};

type GameRenderState<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  state: T;
  publishedAt: number;          // 宿主墙钟（毫秒）
};
```

`game.render` 通道只投递 `GameRenderState`；replica 不写回任何东西。

### 5.5 快照与事件规则

```ts
// SDK 内部等价逻辑：断档就重取快照，不猜测、不跳过
if (event.authorityEpoch !== game.context.authorityEpoch) { game.requestSnapshot(); return; }
if (event.revision !== lastRevision + 1) { game.requestSnapshot(); return; }
applyEvent(event);
lastRevision = event.revision;
```

- 初次连接由宿主投递完整快照；`getSnapshot()` 返回最近一份缓存。
- 快照可能被合并（125ms 窗口内只保最新一份），因此**不要**假设收到每一版快照；渲染以最新为准。
- 事件按 revision 顺序投递；发现缺口时 SDK 会自动请求快照，你只需保证 `applyEvent` 可重复执行（幂等）。
- `onRenderState` 与事件/快照是两条独立通道，允许乱序与丢帧；不要用渲染态反推权威状态。

### 5.6 权限

Replica **只能读**：没有 `commitState`、没有 `publishEvent`、没有命令发送。SDK 不导出写接口；即使手写 postMessage，宿主壳也不会转发写请求。

## 6. Controller 窗口

Controller 是独立窗口，有且只有两种载体，都由游戏 `game.json.controllers[]` 声明：

| 载体 | UI 位置 | 页面宿主 | 授权 |
| --- | --- | --- | --- |
| 包内（`entry`） | 游戏包 `controllers/<slot>/` | 宿主壳 `/game-controller` + sandbox iframe | 清单 `commands` / `events` scope + 窗口 token |
| 外部 Widget（`widgetId`） | 独立 Widget 包 | 既有 `/embed` 壳 + sandbox iframe | Widget 能力账本 + 清单 scope |

示例游戏统一使用包内载体；`widgetId` 保留给需要复用独立 Widget UI 的第三方游戏。

同一游戏最多 8 个；一个 Widget 同一时刻只服务一个游戏。只有实例处于
`running / hidden / suspended / background` 时才能打开/连接控制器；停止或失败时
宿主先广播 `lifecycle(stopped|failed)`，再销毁该游戏全部控制器窗口。

### 6.1 声明

```jsonc
"controllers": [
  {
    "id": "panel",
    "label": "控制台",
    "entry": "controllers/panel/index.html",
    "commands": ["plant.seed"],
    "window": { "width": 380, "height": 520 }
  }
]
```

| 字段 | 规则 |
| --- | --- |
| `id` | 同一游戏内唯一，`^[a-z][a-z0-9-]{0,31}$` |
| `entry` / `widgetId` | 二选一；`entry` 必须在 `controllers/` 下且文件存在 |
| `commands` / `events` | 可选子集；缺省 = 全部声明；`[]` = 只读 |
| `window` | 宽 240–1600、高 200–1200；`resizable` / `alwaysOnTop` 默认 false |
| `autoOpen` | 默认 true；`controllerFollowsGame` 开启时随启动自动打开 |

不同游戏可复用同一个 controller id 或命令名：宿主窗口 label 带 `gameId` hash，
binding、token 与事件都按游戏隔离。示例游戏仍使用不同的 id/label 以便在多个
控制器窗口同时打开时直接区分。

### 6.2 包内控制器（`@lull/game-sdk/controller`）

页面由宿主壳加载，只通过 postMessage 桥通信；页面本身拿不到 Tauri IPC 与窗口 token。

```ts
import { connectLullGameController } from "@lull/game-sdk/controller";

const game = await connectLullGameController();
console.log(game.context.controllerId);          // "panel"

game.onSnapshot((snapshot) => render(snapshot.state));
game.onEvent("world.changed", () => render(game.snapshot?.state));
game.onLifecycle((event) => {
  if (event.state === "stopped" || event.state === "failed") showOffline();
});

const result = await game.command("plant.seed", { seedId: crypto.randomUUID() });
if (!result.ok) showError(result.error);
```

- 宿主负责 `game_connect`；SDK 只等 `init`（含 `context` 与首份快照），失败时抛
  `init-error`（例如 `game.controller_not_active`）。
- `command()` 走 `command.send`，宿主按清单 scope 与实例状态校验后转给 Authority。
- `getSnapshot()` 无缓存时向宿主取一次；游戏停止后窗口由宿主销毁。
- 零构建页面也可以直接实现同一条壳协议，见
  `examples/games/living-world/controllers/panel`。

### 6.3 外部 Widget 控制器（`@lull/game-sdk/widget`）

外部 Widget 控制器仍是受支持的载体（示例游戏不默认分发）：

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "example.game-controller",
  "name": "Living World 控制器",
  "version": "1.0.0",
  "license": "MIT",
  "hostApi": 1,
  "entry": "index.html",
  "capabilities": ["widget.ui", "widget.theme", "game.state.read", "game.command.send", "game.event.read"],
  "window": {
    "width": 420,
    "height": 360,
    "minWidth": 360,
    "minHeight": 300,
    "resizable": false,
    "transparent": true,
    "chrome": "custom"
  },
  "network": []
}
```

```ts
import { connectLullWidget } from "@lull/widget-sdk";
import { connectLullGameWidget } from "@lull/game-sdk/widget";

const widget = await connectLullWidget();
// 宿主打开控制器时已写入目标游戏，通常无需传 gameId：
const game = await connectLullGameWidget(widget);

const snapshot = await game.getSnapshot<LivingWorldState>();
renderStatus(snapshot);

game.onSnapshot((next) => renderStatus(next.state));
game.onEvent("world.changed", () => refreshFromSnapshot());

document.querySelector("#plant")!.addEventListener("click", async () => {
  const result = await game.command("plant.seed", { seedId: `seed-${Date.now()}` });
  if (!result.ok) showError(result.error);
});
```

- **目标游戏**：`gameId` 可省略——宿主在打开控制器时写入 binding；已有 binding 时
  传了不同的 gameId 会得到 `game.controller_target_mismatch`。手动从扩展中心打开
  （没有 binding）必须显式传 `{ gameId }`，且该游戏清单确实声明了这个 Widget。
- 控制器只在游戏运行中可连接：未运行时 `game.connect` 返回
  `game.controller_not_active`，页面应提示"先启动游戏"。
- `game.command` 生成 `requestId`，宿主按清单 scope、实例状态与 revision 校验后路由给 Authority。
- 多个控制器可以同时连接同一实例，状态一致；它们都不是 Authority。

`LullGameWidgetClient` 暴露：`context`、`getSnapshot()`、`onSnapshot()`、`onEvent()`、`onLifecycle()`、`command()`、`destroy()`。

### 6.4 与 Scene 的职责划分

| 关注点 | Scene（Replica） | Controller 窗口 |
| --- | --- | --- |
| 画面 | 世界渲染、视觉主题 | 按钮、状态、列表 |
| 输入 | 不接收指针/键盘 | 用户操作入口 |
| 状态 | 只读 | 只读 |
| 命令 | ❌ | ✅ |
| 游戏时间 | 只用来对齐动画相位 | 只用来展示 |

### 6.5 打开入口与自动跟随

| 入口 | 行为 |
| --- | --- |
| 设置页「游戏」卡片 | 只在**运行中**实例的操作区显示每个控制器的开关；未安装/未启用置灰，游戏未运行时不渲染控制器行 |
| 托盘 | 「设置 ▸ 游戏控制器」列出全部运行中游戏的控制器，壁纸激活的游戏排前；多显示器同一游戏去重，多游戏按游戏分组 |
| `games.json.controllerFollowsGame`（默认开） | 显式启动游戏时自动打开 `autoOpen` 控制器；停止时回收该游戏全部控制器 |
| 游戏侧 | Authority 调 `game_controller_request({controllerId, action})` 打开/关闭自己的控制器 |

```bash
# 包内控制器随游戏包安装；Widget 载体由脚本额外安装（已安装的不覆盖）
pnpm games:samples:install
```

## 7. 引擎与 Adapter

> **P4 状态**：`@lull/game-adapter-canvas`、`-phaser`、`-pixi`、`-three` 均已落地，
> 并有对应单包示例（`examples/games/{phaser,pixi,three}-demo`）。

### 7.1 定位

- Lull **不是**游戏引擎，也不提供渲染 API；你仍然用 Phaser / PixiJS / Three.js / Canvas2D / 自己的渲染器。
- **Adapter 只是开发者侧的帮助库**，由你的游戏包自己 import 并打包；宿主不加载、不依赖、不解析 adapter 包。
- `game.json.engine.adapter` 是元数据，用于扩展中心展示与开发者自检，不影响宿主行为。

### 7.2 统一接口

```ts
interface LullEngineAdapter<TEngine = unknown> {
  readonly id: string;
  readonly version: string;

  initialize(canvas: HTMLCanvasElement, context: GameRenderContext): Promise<TEngine>;
  applySnapshot(engine: TEngine, snapshot: GameSnapshot): Promise<void> | void;
  applyEvent(engine: TEngine, event: GameEvent): Promise<void> | void;
  applyRenderState?(engine: TEngine, render: GameRenderState): void;
  resize(engine: TEngine, context: GameRenderContext): void;
  setVisibility(engine: TEngine, visible: boolean): void;
  destroy(engine: TEngine): Promise<void> | void;
}
```

注意：

- `applySnapshot` / `applyEvent` / `applyRenderState` 只把权威状态**应用到渲染器**，不代表引擎可以修改权威状态。
- Adapter 不承载游戏规则（例如"植物怎么长"不属于 Phaser Adapter）。
- Authority 入口通常不需要 adapter：它不渲染，只计算。
- 实际发布的四个包提供的是更薄的绑定器 `create{Canvas,Phaser,Pixi,Three}GameAdapter`：
  它们内部完成"订阅 + 尺寸/DPI + 生命周期 + 销毁"，把上表的 `initialize/resize/setVisibility/destroy`
  收敛成 `create` 与 `applySnapshot` 两个回调；`applyEvent` / `setVisibility` 未单独暴露——
  事件可按需在 `applySnapshot` 之外用 `LullGameRenderClient.onEvent` 自行订阅。

### 7.3 包名（P4）

```text
@lull/game-adapter-canvas    # 原生 Canvas2D
@lull/game-adapter-phaser    # Phaser.Game（loop/scale）
@lull/game-adapter-pixi      # PIXI.Application（ticker/renderer）
@lull/game-adapter-three     # THREE.WebGLRenderer（自驱 rAF）
```

四个包都是**零运行时依赖**：不 import 引擎类型，用结构化类型接收引擎实例，
版本由你的游戏包决定；宿主同样不加载它们。

四者的共同行为：

| 行为 | canvas | phaser | pixi | three |
| --- | --- | --- | --- | --- |
| 尺寸来自 `render.viewport` | ✅ 每帧 | ✅ 轮询 500ms | ✅ 轮询 500ms | ✅ 每帧 |
| 设备像素比 | ✅ backing store | ⚠️ Phaser 3 以 CSS 像素为基准 | ✅ `resolution = dpr` | ✅ `setPixelRatio` |
| `suspended`/`stopped`/`failed` | 停帧 | `game.loop.sleep()` | `app.ticker.stop()` | 停 rAF |
| `resumed`/`running` | 恢复 | `game.loop.wake()` | `app.ticker.start()` | 恢复 rAF |
| 快照 / 渲染态 | `draw(frame)` | `applySnapshot` | `applySnapshot` | `applySnapshot` |
| `destroy()` | 取消 rAF + 退订 | `game.destroy(true)` | `app.destroy()` | `renderer.dispose()` |

Canvas 适配器用法（游戏包自己 import 并打包，宿主不加载）：

```ts
import { createCanvasGameRenderer } from "@lull/game-adapter-canvas";
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const renderer = createCanvasGameRenderer({
    canvas,
    game,
    maxFps: 30,
    draw: ({ context, width, height, state }) => drawWorld(context, state, width, height),
  });
  renderer.start();
}
```

引擎适配器形状一致，只是把 `draw` 换成 `create` + `applySnapshot`：

```ts
import { Application } from "pixi.js";
import { createPixiGameAdapter } from "@lull/game-adapter-pixi";

const adapter = createPixiGameAdapter<Application>({
  game,
  create: async ({ width, height, dpr }) => {
    const app = new Application();
    await app.init({ width, height, resolution: dpr, autoDensity: true });
    document.getElementById("stage")?.appendChild(app.canvas);
    return app;
  },
  applySnapshot: (app, snapshot) => world.apply(snapshot.state),
});
await adapter.start();
```

Phaser 用 `create: ({ width, height }) => new Phaser.Game({ parent: "stage", width, height, ... })`，
Three.js 用 `create: ({ width, height, dpr }) => ({ renderer, scene, camera })` 并在需要时传
`onFrame` / `maxFps`。它不写状态、不发命令、不创建窗口；引擎生命周期与 LULL 生命周期的对齐
由适配器负责，游戏规则仍在你自己的场景里。

**引擎在 LULL 的 CSP 下必须注意**（游戏包 CSP 不允许 `unsafe-eval`、不允许外连）：

| 引擎 | 约束 | 处理 |
| --- | --- | --- |
| PixiJS 8 | 默认用 `new Function` 生成 uniform/shader 同步代码，初始化即抛 `not allow unsafe-eval` | 在 `new Application()` 之前 `import "pixi.js/unsafe-eval"`（polyfill 入口，不再需要 eval） |
| Phaser 3 | Scale Manager 以 CSS 像素为基准，不读 `devicePixelRatio` | 接受 CSS 分辨率；需要更锐利时改用 PixiJS/Three.js 或自行处理渲染尺寸 |
| Three.js | 没有主循环，相机 aspect 需跟随 canvas | 用适配器自驱 rAF，在 `onFrame` 里按 canvas 尺寸更新 `camera.aspect` |
| 全部 | 不能从 CDN 拉引擎 | 引擎必须打进包内（示例由 esbuild 打包成单个 `replica/main.js`） |


### 7.4 渲染模式

| `renderMode` | 含义 | 首期 |
| --- | --- | --- |
| `canvas2d` | 2D Canvas 主路径 | ✅ |
| `webgl` | WebGL（Phaser 2D/WebGL、Pixi、Three） | ✅ 主要基线 |
| `dom` | 纯 DOM/CSS 渲染 | ✅ |
| `webgpu` | WebGPU | 可选，不作为强制条件 |
| `custom` | 自带渲染/其他 | ✅ |

WebGL 是首期主要图形能力基线；WebGPU 不是运行所有游戏的必需条件。隐藏 Authority 窗口下的 WebGL 稳定性在 P3 单独验证（见 Game Runtime §21）。

### 7.5 引擎权威（P3）

`runtime.authority: "self-loop"` 时，游戏自己驱动循环并提交状态；宿主仍校验 epoch/lease/revision/配额；`onTick` 不触发。P3 起可用但标记 **experimental**（隐藏 WebView2/WebGL 稳定性尚未出真机报告，见 [稳定性报告](./game-runtime-webview-stability.md)）；默认仍建议 host-tick。

### 7.6 稳定性探针（P3）

`@lull/game-sdk/diagnostics` 提供页面级采样，用于填写稳定性报告：

```ts
import { createStabilityProbe } from "@lull/game-sdk/diagnostics";

const probe = createStabilityProbe({ canvas: webglCanvas });
probe.start();
// 2h 后
console.log(JSON.stringify(probe.summary(), null, 2));
probe.stop();
```

包含帧率/长帧/最差帧、`webglcontextlost/restored`、页面隐藏时长、JS 堆增长与采样序列。
报告方法、阈值与转正门槛见 [隐藏 WebView2 / WebGL 稳定性报告](./game-runtime-webview-stability.md)。

## 8. 状态、事件与命令约定

### 8.1 版本

每次成功提交 `revision + 1`；一个 revision 只对应一个状态版本。宿主拒绝 `baseRevision` 不匹配的提交（`state.revision_conflict`）。不要尝试"最后写入者获胜"的补丁式提交。

### 8.2 事件

- 事件类型必须在 `game.json.events` 声明；未声明 → `event.undeclared_type`。
- 单条 ≤16 KiB，单次提交 ≤32 条。
- `eventId` 由宿主生成（`instanceId:revision:seq`），你不需要自己造。
- 事件不落盘；重要状态必须写进 `state`，不能只发事件。

### 8.3 命令

- 命令类型必须在 `game.json.commands` 声明；未声明 → `command.unknown_type`。
- payload ≤32 KiB。
- 命令超时默认 5s；`commands.<type>.timeoutMs` 可收紧（≤8000）。
- 命令结果通过 `commandResult` 回传；也可以只提交状态不回结果，此时调用方会收到超时——不推荐。
- 命令是"请求"，不是"保证"：控制器可能重试、用户可能连点；业务上按幂等处理。

### 8.4 配额

| 项 | 默认 |
| --- | --- |
| 单次提交 state | 1 MiB（`state.maxSizeBytes` 可收紧，硬上限 8 MiB） |
| 单条事件 / 单次事件数 | 16 KiB / 32 |
| 渲染态 | 64 KiB |
| 命令 payload | 32 KiB |
| 命令速率（每 Widget） | 8 次/秒，burst 16 |
| 提交速率 | host-tick ≤1 次/tick；self-loop ≤4 次/秒 |
| 渲染态速率 | 10 次/秒 |

超限返回稳定错误码，不做静默截断。manifest 只能收紧上限，不能放宽宿主硬上限。

### 8.5 时间

- `simulationTimeMs` 由 Authority 提交、Host 校验单调；离线结算用 `lifecycle.offlineMs`。
- `GameRenderContext` 里没有时间；需要动画相位时用 `simulationTimeMs` 或 `tick.wallClockMs`。

### 8.6 Ambient Game 设计约定

Lull 的游戏定位是 Ambient Game（见 [Ambient Game 需求澄清](<./Lull Ambient Game需求澄清.md>)）：世界存在于桌面，用户不需要持续参与。以此为默认，游戏应当：

- **按真实时间推进**，离线也继续成长（用 `lifecycle.offlineMs` 结算，不要逐帧重放）；
- **不设计强制签到、倒计时、失败惩罚、掉线损失**——植物不该因为用户忙而死，宠物不该因为没及时操作而受罚；
- **默认不主动打扰**：宿主没有系统通知通道，事件只发给已订阅的界面（Controller / Scene）；
- **输入低频且可选**：所有主动操作都能通过 Controller 完成，不要求即时响应；
- **与工作流共存**：壁纸区域的视觉变化以低干扰为原则，长时间运行要照顾性能与功耗。

首个官方方向是 Living World（桌面生态/宠物）；示例包会把上述约定作为默认实现，而不是运行时强制的规则。

## 9. 安全规则

必须遵守：

1. 游戏代码只能通过 `@lull/game-sdk` 与宿主通信，不直接调用 Tauri IPC。
2. 不读取/写入宿主文件系统；不尝试枚举窗口、创建窗口、操作 Widget。
3. 不通过修改消息里的 `role` / `instanceId` / `authorityEpoch` 尝试提权；宿主按窗口 label 认定身份。
4. 不把 `authorityToken` 或任何宿主凭据写进日志、状态、事件、渲染态。
5. 外部资源只用 manifest `network` 声明的源；未授权时不要在运行时改 CSP。
6. 不依赖隐藏窗口"一定可见/一定不节流"；渲染相关恢复逻辑（`webglcontextlost`、resize、DPR 变化）要自己处理。
7. 不把大状态塞进渲染态或事件；权威状态只走 `commitState`。
8. 不假设 iframe 与宿主同源；不要读写 `parent.document`、Cookie、localStorage 里的宿主数据。

宿主侧对应的硬边界（详见 [Game Runtime §16](./game-runtime.md)）：

- 不透明源 iframe + 窗口 ACL + 顶层帧 token + 宿主二次校验；
- 提交必须过 epoch/lease/revision/大小/速率校验；
- 资源只经 `lullgame://`，逐包 CSP；
- WebView2 可能把 Tauri 初始化脚本注入子帧——"调不到 IPC"不是安全承诺，宿主校验才是。

## 10. 开发、构建与打包

### 10.1 本地开发

1. 在 `examples/games/<name>/` 建包（或在任意目录）。
2. 用 `pnpm games:samples:build <name>` + `pnpm games:samples:install <name>` 安装到用户游戏目录
   （开发模式挂载 `game` 包、跳过摘要锁的能力尚未实现，见 P5 待办）。
3. 用任意静态服务器调试页面（浏览器里 `connectLullGame()` 会抛 `not-connected`，这是预期行为）；真正联调用宿主。
4. 包内 `.lull-dev.json` 的 Vite dev server 目前只对 widget 生效，对 `authority`/`replica` 入口
   尚未接入（P5）；游戏包请先走构建 + 安装。

### 10.2 构建

- 纯 Vite/esbuild 打包成静态产物即可；不需要 Lull 专属构建工具。
- 入口必须是相对 `.html`；HTML 内的 `<script>` 由资源协议注入 nonce，不要自带 nonce。
- TypeScript 项目直接依赖 `@lull/game-sdk`（P1 起随仓库 `packages/game-sdk` 提供，后续可发布 npm）。

### 10.3 打包与安装

```powershell
node scripts/build-game-examples.mjs my-game   # 校验 + 生成 dist（可带 build.mjs 打 TS/引擎）
node scripts/pack-game.mjs                     # 写 .lull-integrity.json 并打 .lull-game.zip
node scripts/install-game-examples.mjs my-game # 安装 dist 到用户游戏目录
```

- 发布物是 `.zip` 或目录，安装到 `%APPDATA%\app.lull.desktop\games\<id>\`。
- 单文件 ≤16 MiB、整包 ≤128 MiB、≤1024 文件。
- 更新同 id 包：先停止运行中的实例；旧存档保留。
- 卸载默认保留存档；用户在设置页可勾选"同时删除存档"。

### 10.4 示例

| 示例 | 阶段 | 说明 |
| --- | --- | --- |
| `examples/games/living-world` | P1/P2/P4 | Canvas2D + host-tick；**包内 replica 可直接作壁纸**，场景绑定保留为可选主题；自带包内控制器 `controllers/panel` |
| `examples/games/stability-probe` | P3/P4 | **单包双入口**：self-loop authority + `replica/` 指标墙；设为壁纸即可双屏验收 |
| `examples/games/phaser-demo` | P4 | Phaser 3 单包示例：适配器接 `loop.sleep/wake` 与 `scale.resize`；自带包内控制器 `controllers/ambient-phaser` |
| `examples/games/pixi-demo` | P4 | PixiJS 8 单包示例：`resolution = dpr`，适配器接 ticker；自带包内控制器 |
| `examples/games/three-demo` | P4 | Three.js 单包示例：适配器自驱 rAF，`setPixelRatio` + 相机 aspect 跟随；自带包内控制器 |
| `examples/scenes/living-world` | P2 | 只读 Scene 绑定：canvas 绘制植物/水位，走 `game.*` 桥 |

> `@lull/game-adapter-canvas` 没有独立示例包：它由 4 项单测与
> `src/games/replica/adapter-compat.test.ts` 的编译期契约覆盖，用法见 §7.3。

### 10.5 示例打包

```bash
pnpm games:samples:check     # 校验 examples/games/*/game.json 与预算（CI）
pnpm games:samples:build     # 生成 examples/games/<name>/dist
pnpm games:samples:pack      # 打 .lull-game.zip + release/manifest.json
pnpm games:samples:install   # 安装 dist 到 %APPDATA%\app.lull.desktop\games\<id>\
```

- 校验/预算在 `scripts/lib/game-package.mjs`，按游戏包 16 MiB/128 MiB/1024 文件执行；
- zip 根目录直接是包内容，并写入与 Rust `game_package::digest` 同算法的 `.lull-integrity.json`；
- `release/manifest.json` 记录每个 zip 的 sha256、包摘要与体积，供发布页/目录使用；
- 示例可提供 `build.mjs` 做 TypeScript/引擎打包，默认直接复制静态文件；
- CI 在 `examples/games/**` 变化时自动 check/build/pack 并上传 release artifact。
  细节见 [`examples/games/README.md`](../examples/games/README.md)。

## 11. 版本兼容

| 版本 | 规则 |
| --- | --- |
| `game.json.schemaVersion` | 破坏性格式变更才 +1；旧宿主明确拒绝 |
| `hostApi` | 宿主能力最小版本；高于宿主 → 拒绝，不做降级 |
| `GAME_PROTOCOL` | SDK 与宿主之间的线上协议；破坏性变更才 +1 |
| `state.schemaVersion` | 游戏存档结构；与包版本、引擎版本无关 |
| `engine.version` | 展示与开发者自检；不参与宿主校验 |

- 新增可选字段不升 `GAME_PROTOCOL`；读取方忽略未知字段。
- 不支持的值一律明确报错，不静默降级。
- SDK 的 Experimental 阶段不保证向后兼容；每次破坏性调整都会在 CHANGELOG 与本文标注。

## 12. 错误码与常见问题

常见错误（完整表见 [Game Runtime 附录 A](./game-runtime.md#附录-a错误码)）：

| 错误码 | 常见原因 | 处理 |
| --- | --- | --- |
| `game.instance_not_running` | 控制器先于游戏启动操作 | 显示"未运行"，等待启动 |
| `game.unsupported_authority_mode` | 宿主尚不认识的 `runtime.authority` | 改用 `host-tick` / `self-loop` |
| `game.unsupported_display_policy` | 写了 `per-monitor` | 改 `shared` |
| `command.unknown_type` | `commands` 未声明 | 补 manifest |
| `command.timeout` | 命令处理超过超时 | 缩短同步逻辑、尽早回结果 |
| `state.revision_conflict` | 基于过期 revision 提交 | 用 SDK 默认行为，不要手填 `baseRevision` |
| `state.too_large` | 状态超过 `maxSizeBytes` | 压缩状态或调小可变数据 |
| `state.commit_rate_limited` | 提交过频 | 合并到 tick / 降低频率 |
| `event.undeclared_type` | `events` 未声明 | 补 manifest |
| `authority.epoch_mismatch` | 旧 Authority 的残留提交 | 不重试；等待新权威 |
| `network.origin_denied` | `network` 写了非 `https://`/`wss://` | 修正清单 |

常见问题：

**Q：为什么我在浏览器里跑不起来？**
A：Game SDK 依赖宿主壳注入上下文与 postMessage 桥。浏览器预览只适合调 UI；`connectLullGame()` 会明确抛 `not-connected`。

**Q：为什么控制器拿到的 snapshot 是 null？**
A：只有"游戏已运行但刚启动/尚未提交"时才可能；游戏停止后控制器窗口会被宿主销毁，
连接阶段则直接返回 `game.controller_not_active`，应提示"先启动游戏"。

**Q：能不能让每个显示器显示不同的世界？**
A：首期不能。`display.policy` 只支持 `shared`；壁纸 `independent` 模式只切场景，不切游戏世界。

**Q：能不能在壁纸区域直接接收鼠标点击？**
A：不能。游戏操作入口是 Controller 窗口（包内 UI 或 Widget）与设置页；壁纸区域是桌面层，不承担输入职责。

**Q：能不能自己开一个窗口或读一个本地文件？**
A：不能。游戏包只能通过 `lullgame://` 读自己的资源，所有宿主能力都必须经 Game SDK。

**Q：什么时候需要 `publishRenderState`？**
A：只在"高频、只影响画面、不进存档"时使用，例如插值坐标、摇摆相位、粒子参数。权威状态仍然只走 `commitState`。

---

**相关文档**：[Game Runtime 设计](./game-runtime.md) · [Scene SDK](./scene-sdk.md) · [Widget SDK](./widget-sdk.md) · [扩展中心](./extension-center.md) · [内容包格式](./content-format.md) · [RFC](./rfc/RFC-Game-Runtime.md)
