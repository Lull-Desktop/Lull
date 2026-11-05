# Game SDK

> 状态：**P2 已落地（authority / controller / scene / testing）｜Experimental**；引擎 Adapter 仍为设计（P4）。
> SDK 实现：[`packages/game-sdk`](../packages/game-sdk/README.md)｜宿主设计：[Game Runtime 设计](./game-runtime.md)。
> 面向第三方游戏作者：包结构 → `game.json` → 角色 API → 场景/Widget 接入 → 引擎适配 → 安全边界。

## 这是什么

一个 Lull 游戏 = 一个静态 Web 包 + 一份 `game.json`。逻辑、渲染与操作分别由三个角色承担：

```text
Game Package
  ├─ authority 入口   逻辑权威：接收命令、推进模拟、提交状态        （必需）
  ├─ replica 入口     可选：游戏自带的渲染器                         （P4）
  └─ Controller Widget 操作与状态面板（独立的 Widget 包）             （推荐）
```

运行位置：

| 角色 | 运行位置 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Authority | 隐藏窗口 `game-authority-<hex>` 内的沙箱 iframe | 读快照、收命令/tick、提交状态与事件 | 写文件、建窗、读宿主配置、绕过 Host 提交 |
| Replica | 壁纸窗口里的场景 iframe（或 P4 的独立 replica iframe） | 读快照/事件/渲染态、绘制 | 提交状态、发命令、访问宿主 |
| Controller | 普通 Widget 窗口内的沙箱 iframe | 读快照/事件、发命令 | 写状态、启停实例、删存档 |

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
  assets/                   # 图片、音频、字体、数据
  LICENSE                   # 建议
  README.md                 # 建议
```

约定：

- 所有资源使用相对路径；入口必须是包内 `.html`，禁止 `..`、绝对路径、反斜杠。
- 游戏包由 `lullgame://<id>/...` 只读服务；不能用 `file://`、不能引用宿主资源。
- 发布时只分发构建产物（`dist/` 内容即包根）；`games/` 目录不是新的 Scene/Widget 目录，不要混用。
- 游戏包与 Scene 包、Widget 包**彼此独立**：一个游戏可以有多个视觉 Scene，也可以有多个 Controller Widget。

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
| `entry.replica` | — | 游戏自带渲染入口；P4 起支持 |
| `engine.id` | — | 开放字符串（不枚举）；缺省 `custom` |
| `engine.version` | — | 引擎版本范围（仅展示与开发者自检） |
| `engine.adapter` | — | 适配器包名（仅元数据；宿主**不加载**） |
| `engine.renderMode` | — | `canvas2d` / `webgl` / `webgpu` / `dom` / `custom`，缺省 `canvas2d` |
| `runtime.authority` | ✅ | `host-tick`（P1–P2 唯一支持）或 `self-loop`（P3） |
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

### Controller Widget 能力

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

## 5. Replica 接入（Scene）

> **P2 已落地**：`@lull/game-sdk/scene` 的 `connectLullGameRender()`、场景 manifest
> `game` 绑定与 `game.*` 桥消息已可用；宿主在场景 `game.ready` 后 attach replica。
> 游戏未运行时 resolve 为 `null`，场景应回退到静态视觉。

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

## 6. Controller Widget

Controller 是普通 Widget 包，声明 `game.*` 能力，用 `@lull/game-sdk/widget` 连接游戏。

### 6.1 widget.json

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "community-living-world-controller",
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

### 6.2 使用

```ts
import { connectLullWidget } from "@lull/widget-sdk";
import { connectLullGameWidget } from "@lull/game-sdk/widget";

const widget = await connectLullWidget();
const game = await connectLullGameWidget(widget, { gameId: "community.living-world" });

const snapshot = await game.getSnapshot<LivingWorldState>();
renderStatus(snapshot);                      // 未运行时为 null

game.onSnapshot((next) => renderStatus(next.state));
game.onEvent("world.changed", () => refreshFromSnapshot());

document.querySelector("#plant")!.addEventListener("click", async () => {
  const result = await game.command("plant.seed", { seedId: `seed-${Date.now()}` });
  if (!result.ok) showError(result.error);
});
```

- `game.command` 生成 `requestId`，宿主按预期 revision 校验并路由给 Authority；返回权威结果或超时错误。
- `expectedRevision` 可选：面板编辑类操作可以传当前 revision，避免"基于过期画面"的误操作。
- Widget 未运行时仍可连接：`context.instanceId` 为 `null`，`getSnapshot()` 返回 `null`；`command` 返回 `game.instance_not_running`。控制器应据此显示"游戏未运行"，而不是报错弹窗。
- 多个 Widget 可以同时连接同一实例，状态一致；它们都不是 Authority。

`LullGameWidgetClient` 暴露：`context`、`getSnapshot()`、`onSnapshot()`、`onEvent()`、`onLifecycle()`、`command()`、`destroy()`。

### 6.3 与 Scene 的职责划分

| 关注点 | Scene（Replica） | Controller Widget |
| --- | --- | --- |
| 画面 | 世界渲染、视觉主题 | 按钮、状态、列表 |
| 输入 | 不接收指针/键盘 | 用户操作入口 |
| 状态 | 只读 | 只读 |
| 命令 | ❌ | ✅ |
| 游戏时间 | 只用来对齐动画相位 | 只用来展示 |

## 7. 引擎与 Adapter

> **P1 状态**：Adapter 包尚未实现（P4）；当前只定义接口与包名。

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

### 7.3 包名（P4）

```text
@lull/game-adapter-canvas    # 原生 Canvas2D，最先支持
@lull/game-adapter-phaser
@lull/game-adapter-pixi
@lull/game-adapter-three
```

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

`runtime.authority: "self-loop"` 时，游戏自己驱动循环并提交状态；宿主仍校验 epoch/lease/revision/配额；`onTick` 不触发。P1–P2 该值会被拒绝（`game.unsupported_authority_mode`）。

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
2. 扩展中心开启开发模式，把目录挂载为 `game` 开发包；宿主跳过摘要锁与签名，但仍校验清单、授权与沙箱。
3. 用任意静态服务器调试页面（浏览器里 `connectLullGame()` 会抛 `not-connected`，这是预期行为）；真正联调用宿主。
4. `.lull-dev.json` 可指向 Vite dev server（仅 debug 构建生效），authority/replica 入口都走它。

### 10.2 构建

- 纯 Vite/esbuild 打包成静态产物即可；不需要 Lull 专属构建工具。
- 入口必须是相对 `.html`；HTML 内的 `<script>` 由资源协议注入 nonce，不要自带 nonce。
- TypeScript 项目直接依赖 `@lull/game-sdk`（P1 起随仓库 `packages/game-sdk` 提供，后续可发布 npm）。

### 10.3 打包与安装（P5 完整化）

```powershell
# 目标形态；P5 提供脚本
pnpm game:hash  --bundle ./my-game     # 写 .lull-integrity.json
pnpm game:pack  ./my-game --out artifacts
```

- 发布物是 `.zip` 或目录，安装到 `%APPDATA%\app.lull.desktop\games\<id>\`。
- 单文件 ≤16 MiB、整包 ≤128 MiB、≤1024 文件。
- 更新同 id 包：先停止运行中的实例；旧存档保留。
- 卸载默认保留存档；用户在设置页可勾选"同时删除存档"。

### 10.4 示例

| 示例 | 阶段 | 说明 |
| --- | --- | --- |
| `examples/games/living-world` | P1/P2 | Canvas2D + host-tick + 场景绑定；最小闭环 |
| `examples/scenes/living-world` | P2 | 只读 Scene 绑定：canvas 绘制植物/水位，走 `game.*` 桥 |
| `examples/widgets/living-world-controller` | P1/P2 | 控制器 Widget：种/浇水/状态面板，走 `game.*` Widget 桥 |
| `examples/games/canvas-demo` | P4 | 原生 Canvas 适配器 |
| `examples/games/phaser-demo` | P4 | Phaser 适配器 |
| `examples/games/pixi-demo` | P4 | PixiJS 适配器 |
| `examples/games/three-demo` | P4 | Three.js 适配器 |

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
| `game.unsupported_authority_mode` | 用了 `self-loop` 但宿主 P1/P2 | 改 `host-tick` 或等 P3 |
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
A：游戏没运行，或当前游戏没有实例。控制器应把 `null` 当作正常状态处理。

**Q：能不能让每个显示器显示不同的世界？**
A：首期不能。`display.policy` 只支持 `shared`；壁纸 `independent` 模式只切场景，不切游戏世界。

**Q：能不能在壁纸区域直接接收鼠标点击？**
A：不能。游戏操作入口是 Controller Widget 与设置页；壁纸区域是桌面层，不承担输入职责。

**Q：能不能自己开一个窗口或读一个本地文件？**
A：不能。游戏包只能通过 `lullgame://` 读自己的资源，所有宿主能力都必须经 Game SDK。

**Q：什么时候需要 `publishRenderState`？**
A：只在"高频、只影响画面、不进存档"时使用，例如插值坐标、摇摆相位、粒子参数。权威状态仍然只走 `commitState`。

---

**相关文档**：[Game Runtime 设计](./game-runtime.md) · [Scene SDK](./scene-sdk.md) · [Widget SDK](./widget-sdk.md) · [扩展中心](./extension-center.md) · [内容包格式](./content-format.md) · [RFC](./rfc/RFC-Game-Runtime.md)
