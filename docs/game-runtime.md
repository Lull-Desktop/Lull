# Game Runtime 设计

> 状态：**v0.5.4 —— P1–P3 部分落地（含 background 策略），P4 单包双入口与四类渲染适配器（Canvas2D / Phaser / PixiJS / Three.js）已落地；控制器已支持每游戏多窗口、包内 UI 与激活门禁；真机长跑与多屏目视验收待补**。
> 基线：[RFC `LULL-RFC-GAME-001`](./rfc/RFC-Game-Runtime.md)（Proposed）｜代码基线：`0.2.2`。
> 实现：`src-tauri/src/game/`、`src-tauri/src/game_package/`、`packages/game-sdk/`（含 `./scene`、`./widget`、`./controller`）、`src/games/`（authority / controller / bridge / replica）、`examples/games/living-world/`、`examples/scenes/living-world/`；未覆盖项见 §19。
> 范围：Lull 宿主侧 —— 游戏包、实例与权威、状态仓储、命令/事件协议、多屏渲染副本、权限与窗口接线、阶段计划与验收。
> 第三方开发者契约见 [Game SDK](./game-sdk.md)；本文的设计章节仍描述目标形态，未落地部分不要当成既有能力。

本文把 RFC 的架构主张翻译成本仓库可执行的决策。优先级规则：**代码事实 > 本文 > RFC**。凡是本文与 RFC 不同的地方，都在附录 C 记录原因；凡本文提到的"新增"，都表示当前代码里不存在。

---

## 0. 产品定位

Game Runtime 服务的是 **Ambient Game（环境式桌面游戏）**，不是传统桌面小游戏：游戏世界存在于壁纸层、用户不操作也继续演化，主动操作只通过 Widget 低频发生。产品约束见 [Ambient Game 需求澄清](<./Lull Ambient Game需求澄清.md>)，它们直接决定本设计的三层结构与默认值：

| 产品约束 | 设计落点 |
| --- | --- |
| 游戏世界持续存在，用户不操作也继续演化 | Host 掌握状态与持久化 + 真实时间推进 + 离线结算（§7.6） |
| 用户通过 Widget 低频操作，不在壁纸区域持续输入 | Authority 与显示器解耦，输入只来自 Controller（§14、§22） |
| 多显示器展示同一个世界 | 单实例 + 多 Render Replica（§12） |
| 不设计强制签到、倒计时、失败惩罚 | 运行时不提供这类机制；示例游戏与 SDK 文档明确不采用（见 [Game SDK §8.6](./game-sdk.md)） |
| 默认不主动打扰 | 运行时没有通知通道；事件只投给已订阅的界面 |
| 游戏状态是用户长期资产 | 存档独立于包、原子写、备份、卸载默认保留（§8） |
| 首个产品方向：Living World（生态 / 宠物） | P1 示例 `examples/games/living-world`，P2 增加绑定场景 |

首期只支持生态/放置类最需要的 `host-tick` 权威与 `shared` 显示策略；需要引擎自循环或每屏独立世界的游戏，等 P3/P4 之后再评估。

---

## 1. 结论先行

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| D1 | 包管理与运行时分离：`game_package`（清单/协议/存储/授权）+ `game`（实例/权威/状态/副本） | 与 `widget_package` / `wallpaper` 的现有分层一致，避免包校验代码混进运行时 |
| D2 | Authority 是独立隐藏窗口 `game-authority-<hex>`，**不与任何显示器绑定** | Explorer 重启、壁纸重建、显示器热插拔不会顺带重启游戏逻辑 |
| D3 | Replica 不自建窗口，寄生在既有 `wallpaper-<index>` 窗口里 | 复用 `SceneFrame` 的 canvas/view/viewport/dpr 与桌面挂载，不新增 Win32 表面 |
| D4 | Controller 是独立窗口：包内页面（`/game-controller` 壳 + iframe）或普通 `widget-<id>` 窗口，每个游戏可声明 1–8 个 | 复用既有 Widget 授权与桥，同时让游戏包自带 UI；窗口存在即绑定，只有运行中的游戏可打开 |
| D5 | Authority 分 `host-tick`（P1）与 `self-loop`（P3）两种执行模式；P1–P2 只支持 host-tick，P3 起 self-loop 为 experimental | 先避开 RFC 自认最高风险的"隐藏 WebView 自循环 + WebGL"部分 |
| D6 | 身份只由宿主认定：窗口 label + 宿主注入 token；消息里的 `role` 一律不可信 | RFC §12.2 的硬约束 |
| D7 | Host 是状态提交的最终裁决者：校验 `instanceId / authorityId / epoch / lease / baseRevision / token`，拒绝即失败，**没有最后写入者获胜** | RFC §4.3、§4.4 |
| D8 | 状态仓储与游戏包目录分离：包在 `games/<id>/`，存档在 `game-data/<id>/<instanceId>/` | 包摘要扫描不能罩住存档；卸载包不应连坐存档 |
| D9 | 协议用显式 Tauri 命令 + 定向事件，camelCase，版本化；不用"一个万能 `game_call`" | 每条命令的窗口 ACL 更窄，错误码与审计更清晰 |
| D10 | 快照为主、事件为增量；replica 发现 epoch 变化或 revision 断档就重新取快照 | RFC §5.2 |
| D11 | Scene 只能只读接入（`game: { id, role: "replica" }` + 场景桥追加消息） | RFC §7.4、§10；Scene 永远不能是 Authority |
| D12 | Widget 只能发命令与读状态，新增 3 个 Widget 能力；拿不到写权限 | RFC §11 |
| D13 | 游戏包是第三类扩展包，安装/授权/启停复用 Extension Center 共享管线 | 不另造一套安装器、签名与授权 UI |
| D14 | P1 先跑通"单实例、单权威、无 replica（控制面板读快照）"的闭环，P2 再上多屏 | 先把权威/仓储/协议测稳，再引入多屏几何复杂度 |

## 2. 术语与标识

| 术语 | 形态 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| Game Package | 目录 + `game.json` | 安装到磁盘，随包更新 | 游戏逻辑、入口与资源；不含存档 |
| `gameId` | `^[a-z0-9][a-z0-9._-]{2,63}$` | 随包 | 全局唯一；同一 `gameId` 同时只允许一个活动 Instance |
| Game Instance | `instanceId`（UUIDv7，32 位 hex 去连字符） | 从启动到停止；落在存档目录 | 一个游戏会话；与显示器无关 |
| Authority | `authorityId`（UUIDv4）+ `authorityEpoch` | 一次权威进程/窗口 | 唯一拥有游戏逻辑执行与状态提交权的执行体 |
| `authorityEpoch` | `u32`，从 1 开始，持久化递增 | 随每次创建/接管 +1 | 旧 epoch 的提交必须被拒绝 |
| Authority Lease | `leaseId` + `expiresAt` | 心跳续租 | Host 侧的在位凭证，**不写入存档** |
| `authorityToken` | 32 字节随机数的 hex（64 字符） | 与 authority 窗口同寿命 | 只注入 authority 宿主壳；Widget / Replica / 游戏 iframe 永远拿不到 |
| Replica | `replicaId` + 窗口 label | 与壁纸窗口同寿命 | 只读渲染副本；消费同一份权威快照 |
| Controller | 窗口 label `widget-<id>` | 与 Widget 窗口同寿命 | 命令与状态查看入口 |
| `stateRevision` | `u64`，从 0 开始单调 +1 | 随实例持久化 | 一个 revision 只对应一个权威状态版本 |
| `simulationTimeMs` | `u64` | 随实例持久化 | 游戏内时间；由 authority 提交、Host 校验单调 |
| Snapshot | `GameSnapshot` | 不落盘（state 本身落盘） | 完整权威状态 + revision + epoch |
| Event | `GameEvent` | 不落盘 | 低频增量通知，带 `eventId` 去重 |
| Render State | `GameRenderState` | 不落盘 | 只给 replica 的画面状态（插值、动画相位、局部特效） |
| Display policy | `shared` | 随包 | 首期唯一支持；`per-monitor` 明确拒绝 |

**Authority 与 Host 的分工**：Authority 可以计算、可以提议提交，但不能写磁盘、不能创建窗口、不能读写宿主配置。Host 负责裁决、持久化与分发（RFC §4.3）。

## 3. 与现有子系统的边界

### 3.1 依赖方向

```text
src-tauri/src/lib.rs（接线：协议注册 / 命令注册 / 窗口事件 / 退出 flush）
   │
   ├─ game_package/            # 游戏包：manifest / store / lullgame:// 协议
   │      └─ extension::install、package_hash、resource、content_trust
   │
   ├─ game/                    # 运行时：实例 / 权威 / 租约 / 状态 / 副本 / 命令
   │      ├─ game_package（读包与授权）
   │      ├─ window_host（窗口 label 前缀约定、notify_changed）
   │      ├─ i18n（语言注入）
   │      └─ 不依赖 wallpaper / media / widget_package 的业务实现
   │
   └─ wallpaper/               # 只通过“窗口 label → 显示器设备名”只读查询对接
          └─ 不反向依赖 game

前端：
src/app/(games)/game-authority  →  src/games/authority（宿主壳）
src/app/(wallpaper)             →  src/scenes/host → src/games/bridge（replica 桥）
src/app/(widgets)/embed         →  src/components/widget-plugin-shell（controller 复用）
src/app/(control)/setting       →  src/components/settings/games-panel
packages/game-sdk               →  游戏包内代码（authority / replica / widget 三个入口）
```

约束：

- `game` / `game_package` 属于 Core 的新增子系统；`src/games/**` 属于 Extensions 的宿主壳层；游戏包属于 Community 内容。
- **Core 不依赖任何具体游戏引擎**；`engine` 字段只做校验与展示，宿主从不加载 adapter 包。
- `game` 不直接操作壁纸窗口的 native 挂载；壁纸窗口的生命周期仍由 `wallpaper` 拥有，game 只按 label 收/发消息。
- Scene SDK 继续只负责几何/参数/相位；Game SDK 单独负责快照/事件/渲染上下文。**两者互不 import**，场景页面同时使用时各自监听自己的消息类型。

### 3.2 与现有子系统的关系表

| 子系统 | 现有职责 | 与 Game Runtime 的关系 | 改动方式 |
| --- | --- | --- | --- |
| `wallpaper` | 每屏 WebView、桌面挂载、URL 画面协议、显示器拓扑 | Replica 运行在其 WebView 内；显示器几何复用 `SceneFrame` | 窗口创建时追加注入 `__LULL_GAME_TOKEN__`（顶层帧）；`on_window_event::Destroyed` 调用 `game::on_window_destroyed` |
| Scene / `@lull/scene-sdk` | `init/frame/visibility` 只读帧 | 追加 `game.*` 消息（协议不升版）；scene manifest 增加可选 `game` 绑定 | `src/scenes/scene-bridge.ts`、`src/scenes/external-scene.tsx`、`packages/scene-sdk/src/protocol.ts` 增量扩展 |
| Widget / `@lull/widget-sdk` | 插件窗口、能力授权、postMessage 桥 | Controller 复用；新增 3 个游戏能力与 4 个桥方法 | `src/sdk/widget/types.ts`、`packages/widget-sdk/src/protocol.ts`、`widget-plugin-shell` 增量扩展 |
| Extension Center | 安装/启停/授权/开发模式 | 增加第三类包 `game`；运行状态按钮接 `game_start/stop` | `extension::{Kind,install,mod}`、`content_trust::PackageKind` 增量扩展 |
| `media` | 音乐/音境工坊/视频壁纸 | **无耦合**；不复用 `media_call`，也不走 `media:event` | 不改 |
| `config` | `display.json` | 游戏运行偏好单独放 `games.json`，不塞进显示配置 | 不改 |
| 托盘 | 内置窗口/扩展入口 | 首期不加游戏菜单；P5 再评估"当前游戏"子菜单 | 不改 |

### 3.3 明确不修改的现有契约

- 壁纸 URL 哈希（`#mode/sync/scene/canvas/view/params`）不变；游戏渲染几何从既有 `SceneFrame` 推导。
- `SCENE_PROTOCOL = 1` 与 `WIDGET_PROTOCOL = 1` 不升版：游戏消息是**新增类型**，旧客户端按"未知类型忽略"处理。
- `display.json` 的 schema 不变。
- Widget 卸载删状态的语义不变；游戏卸载默认保留存档（见 §8.7）。

## 4. 运行模型

### 4.1 进程与窗口

```text
lull.exe（Rust）
 ├─ 托盘 / 设置窗（settings）                         ← 管理：启动、停止、授权、存档
 ├─ 壁纸窗 × N（wallpaper-<index>）                    ← Replica 宿主（顶层帧注入 game token）
 │    └─ 场景 iframe（sandbox=allow-scripts）           ← Scene SDK + Game SDK（只读副本）
 ├─ 游戏权威窗 × M（game-authority-<instanceIdHex>）   ← 隐藏、无任务栏、Host 壳 + 游戏 iframe
 │    └─ authority iframe（sandbox=allow-scripts）      ← Game SDK authority（提交状态）
 ├─ 包内控制器窗 × K（game-controller-<hash>-<id>）     ← 可见、Host 壳 + 游戏包控制器 iframe
 │    └─ controller iframe（sandbox=allow-scripts）      ← Game SDK controller（读写状态、发命令）
 └─ 外部控制器 Widget × L（可选，widget-<id>）          ← Widget SDK + Game SDK widget（发命令）
```

- `M` = 同时运行的游戏实例数，默认上限 3（`games.json.maxRunning`）。
- `K + L` = 当前运行中的游戏声明的控制器窗口（每游戏最多 8 个；同一 Widget 同一时刻只服务一个游戏）。
- 示例游戏都使用包内控制器（`controllers[].entry`）；`widgetId` 是保留给第三方的可选载体。
- 权威窗照 `media-engine` 的建窗方式：非主线程、`visible(false)`、`skip_taskbar(true)`、`decorations(false)`、`resizable(false)`。
- 所有 WebView 继续复用 `src-tauri/src/webview.rs` 的 Chromium 参数（关闭后台定时器节流 / occluded / backgrounding）。这是隐藏权威窗能跑的基础，但**不是充分条件**：WebGL 上下文与 GPU 行为仍必须单独验证（见 §21）。
- Authority 窗的页面是宿主壳 `/game-authority`，而不是直接加载游戏页面。这样游戏代码始终处在不透明源 iframe 里，Tauri IPC 只落在宿主壳。

### 4.2 启动来源

| 来源 | 行为 | 默认 |
| --- | --- | --- |
| 设置页「游戏」页签点击"启动" | 调 `game_start(gameId)` | 显式操作 |
| 场景绑定自动启动 | 壁纸窗发现当前 scene 绑定该游戏且实例未运行时，调 `game_auto_start` | `games.json.autoStartWithWallpaper = true`（P2 起，默认开） |
| 应用启动恢复 | 上次非正常退出（`metadata.status = "running"`）→ 标记 `interrupted`，不自动启动 | `resumeOnLaunch = false` |
| 控制器窗口打开 | **不**自动启动游戏；只有实例 `running/hidden/suspended/background` 时才允许打开 | — |

自动启动只放宽"谁来触发 `game_start`"，**不会**绕过能力授权、包校验或单实例规则。

### 4.3 一次命令提交的时序

```text
Controller（包内页面 / 外部 Widget）──postMessage──► 宿主壳 ──game_command_send──► Game Host
                                                                          │ 校验：
                                                                          │ 角色/能力/类型/大小
                                                                          │ requestId 去重
                                                                          │ expectedRevision
                                                                          ▼
                                                                   Authority 窗口事件
                                                                          │
                                                     宿主壳 ──postMessage──► 游戏 iframe
                                                                          │ 执行
                                                     宿主壳 ◄──commitState── 游戏 iframe
                                                                          │ game_state_commit(token)
                                                                          ▼
                                                                 Game Host 校验 epoch/lease/revision
                                                                          │
                                                                 Game State Repository（合并落盘）
                                                                          │
                                                          ┌───────────────┼───────────────┐
                                                                          ▼
                                                          game:snapshot / game:event / game:render
                                                                          │
                                                     Replica 窗 / Controller 窗 / 发起者结果
```

### 4.4 一次多屏渲染的时序

```text
显示器 A 壁纸窗 ─┐
显示器 B 壁纸窗 ─┼─ game_connect(render) ─► Replica Registry ─► 返回 GameContext
显示器 C 壁纸窗 ─┘                                          │
                                                             ▼
                                            初始 game:snapshot（每窗一份）
                                                             │
                                   后续提交 → 合并节流 → game:snapshot / game:event / game:render
                                                             │
                                              各窗顶层帧 → 场景 iframe（Game SDK）
```

Replica 只影响自己那台显示器；任意一窗重建后重新 attach 并拿新快照，Authority 与游戏实例不受影响。

## 5. 模块划分与依赖规则

### 5.1 Rust 模块

```text
src-tauri/src/
  game_package/            # 游戏包（对标 widget_package）
    mod.rs                 #   门面：资源协议注册（handle_protocol）
    manifest.rs            #   game.json 校验 / 能力白名单 / entry 安全
    digest.rs              #   旁路 .lull-integrity.json + 整包摘要
    store.rs               #   根目录、安装/卸载、授权账本、运行前检查
    protocol.rs            #   lullgame:// 资源服务 + 逐包 CSP
  game/                    # Game Runtime P1
    mod.rs                 #   门面：init/shutdown/窗口销毁钩子/壁纸 token
    manager.rs             #   实例表、参与者表、命令去重/等待、ticker、事件分发
    instance.rs            #   单实例数据与状态机
    authority.rs           #   game-authority-* 窗口创建/销毁与上下文注入
    lease.rs               #   lease、epoch、token、心跳、过期判定
    state.rs               #   提交校验、revision、事件/渲染态构造、配额
    repository.rs          #   存档读写、metadata、备份、原子写、恢复
    journal.rs             #   提交 journal（诊断用 NDJSON，滚动裁剪）
    config.rs              #   games.json（autoStart / resumeOnLaunch / maxRunning / offlineMaxMs）
    lifecycle.rs           #   启动/停止/立即保存/failover 编排
    api.rs                 #   24 条 Tauri 命令（管理 + 参与者 + 诊断）
    protocol.rs            #   线上结构体、协议版本、错误体
    permissions.rs         #   窗口角色判定、顶层帧 token、Widget 授权
    error.rs               #   稳定错误码 GameError
```

设计阶段曾规划独立的 `command.rs` / `event.rs` / `snapshot.rs` / `replica.rs`；P1 把它们合并进 `manager.rs`（参与者、命令去重、事件分发、副本注册）与 `api.rs`（命令路由），后续阶段若代码继续膨胀再拆文件，不影响对外协议。

与 RFC §13 的文件对应关系：RFC 的 `authority_lease.rs` 在这里拆成 `lease.rs`；RFC 的 `manifest.rs` 落在 `game_package`；其余能力由 `manager` / `api` 承担。

新增顶层模块需要在 `src-tauri/src/lib.rs` 声明并在 `generate_handler!` 注册命令、在 `src-tauri/build.rs` 的 `APP_COMMANDS` 同步（两者由 `pnpm widgets:check` 比对，漏一个运行期就会被 ACL 拒绝）。

### 5.2 前端模块

```text
src/games/
  authority/
    game-authority-shell.tsx  # /game-authority 宿主壳：注入上下文、路由请求、心跳续租
  bridge/
    use-game-replica.ts       # 壁纸顶层帧的只读 game.* 桥（场景与包内 replica 共用）
  replica/
    game-replica-host.tsx     # 包内 entry.replica 的沙箱 iframe 宿主
    game-host.tsx             # display.game 的壁纸宿主（几何 / 跨屏 wrapper）
src/lib/games.ts              # 宿主侧 GameView/Instance/Context 等类型
src/hooks/use-games.ts        # 列表/状态/事件订阅与实例操作
src/components/settings/games-panel.tsx
src/app/(games)/game-authority/page.tsx
```

宿主侧类型**不从 SDK 源码推导**（SDK 独立发布），与 `src/scenes/scene-bridge.ts` 对 `@lull/scene-sdk` 的处理方式一致：两侧各自声明契约，由测试与联调钉住字段。

### 5.3 SDK 包

| 包 | 入口 | 用途 | 阶段 |
| --- | --- | --- | --- |
| `@lull/game-sdk` | `.` | 游戏 authority 客户端、context / 快照 / 事件（replica 部分 P2） | P1 |
| `@lull/game-sdk/widget` | `./widget` | 外部 Controller Widget 客户端（可选载体） | P1 |
| `@lull/game-sdk/scene` | `./scene` | 只读渲染桥（场景绑定与包内 replica 共用客户端） | P2/P4 |
| `@lull/game-sdk/testing` | `./testing` | 内存传输与样例消息 | P1 |
| `@lull/game-adapter-canvas` | — | 原生 Canvas2D 适配器 | P4 已落地 |
| `@lull/game-adapter-phaser` | — | Phaser 3 适配器（`loop.sleep/wake` + `scale.resize`） | P4 已落地 |
| `@lull/game-adapter-pixi` | — | PixiJS 8 适配器（ticker + `renderer.resize`） | P4 已落地 |
| `@lull/game-adapter-three` | — | Three.js 适配器（自驱 rAF + `setPixelRatio`） | P4 已落地 |

SDK 与现有 `packages/*-sdk` 一样用 `tsc` 构建 `dist` + `.d.ts`，包 license 为 Apache-2.0，新增 `game:sdk` / `game:sdk:check` 脚本并纳入 `pnpm check`。

### 5.4 依赖规则

- `src/games/**` 不得 import `src/app/**`、`src/components/**`。
- 游戏包代码只能通过 `@lull/game-sdk` 与宿主说话；不得直接调用 Tauri IPC、不得读写宿主文件、不得创建窗口。
- `game` 模块不得 import 具体引擎包。
- `Scene SDK` 不依赖 `Game SDK`；`Widget SDK` 不依赖 `Game SDK`；`Game SDK` 不依赖任何宿主实现（只依赖 postMessage 与可注入 transport）。
- 宿主不得把 `authorityToken` 放进任何发给游戏 iframe、Replica 或 Widget 的消息。

## 6. 权威、租约、epoch、revision

### 6.1 身份注入

Authority 窗口创建时，宿主注入（页面脚本执行前）：

```ts
window.__LULL_GAME_AUTHORITY__ = {
  protocol: 1,
  hostApi: 1,
  gameId: "community.living-world",
  instanceId: "0192f3a...",
  authorityId: "6f1c...",
  authorityEpoch: 3,
  role: "authority",
  mode: "host-tick",
  entryUrl: "http://lullgame.localhost/community.living-world/authority/index.html",
  token: "<32-byte hex>",
  limits: {
    maxStateBytes: 1048576,
    maxEventBytes: 16384,
    maxEventsPerCommit: 32,
    maxRenderStateBytes: 65536,
    maxReplicas: 8,
    tickMs: 1000,
  },
  locale: "zh-CN",
};
```

壁纸窗口注入（与 `__LULL_MEDIA_TOKEN__` 同一模式，只写顶层帧）：

```js
if (window.top === window) {
  window.__LULL_GAME_TOKEN__ = "<32-byte hex>";
}
```

Widget 窗口不追加游戏注入：控制器走既有 `__LULL_PLUGIN__` 与桥 token，游戏能力从授权账本读取。

### 6.2 租约

```rust
pub(crate) struct AuthorityLease {
  pub(crate) instance_id: String,
  pub(crate) authority_id: String,
  pub(crate) epoch: u32,
  pub(crate) lease_id: String,
  pub(crate) token: String,
  pub(crate) expires_at_ms: u64,
}
```

- Authority 壳页每 2s 调一次 `game_heartbeat()`；缺省 TTL 10s。
- 宿主每次校验提交前先检查 `expires_at_ms`；过期即视为 `authority.lease_expired`，并触发 failover。
- Lease 只在内存；重启后靠 `metadata.authorityEpoch` 继续递增，**不重复使用旧 epoch**。
- `authorityToken` 不进存档、不进日志、不进事件。

### 6.3 提交校验顺序

`game_state_commit` 严格按下表顺序校验，命中即返回对应稳定错误码：

| # | 校验 | 失败码 |
| --- | --- | --- |
| 1 | 调用窗口 label 是 `game-authority-<instanceId>` 且实例存在 | `permission.denied` / `game.instance_not_found` |
| 2 | 实例状态允许提交（`running` / `background`） | `game.instance_not_running` |
| 3 | `authorityToken` 有效 | `authority.token_invalid` |
| 4 | `authorityId` 匹配当前权威 | `authority.not_owner` |
| 5 | `authorityEpoch` 匹配 | `authority.epoch_mismatch` |
| 6 | Lease 未过期 | `authority.lease_expired` |
| 7 | `baseRevision === currentRevision` | `state.revision_conflict` |
| 8 | state JSON 大小 ≤ manifest `state.maxSizeBytes`（硬上限 8 MiB） | `state.too_large` |
| 9 | 事件条数/单条大小/类型声明合法 | `event.too_large` / `event.undeclared_type` |
| 10 | 提交速率未超限（self-loop 生效；host-tick 按 tick 节流） | `state.commit_rate_limited` |
| 11 | `simulationTimeMs` 单调且不超过墙钟 + 1h | `state.invalid` |

全部通过后：`revision += 1` → 写入内存快照 → 按策略落盘 → 构造并投递 `game:snapshot` / `game:event` / `game:render` → 返回 `GameCommitResult`。

**显式禁止**：任何"版本不一致就以旧覆盖新"的兜底。

### 6.4 epoch 规则

- 每次创建 Authority（首次、崩溃重建、用户手动重启、导出/导入后接管）都 `epoch += 1`。
- epoch 只增不减；持久化在 `metadata.json`，启动时以存档为准再 +1。
- 任何把旧 epoch 提交应用到新状态的路径都不存在；旧窗口即使还活着也只能收到 `game:lifecycle { state: "authority-changed" }`，后续提交一律拒绝。

### 6.5 revision 规则

- 每次成功提交 `revision += 1`，从 0 开始；一个 revision 只对应一个权威 state。
- 快照与事件使用同一个 revision 轴；事件 revision 等于产生它的那次提交。
- Replica / Controller 不生成 revision，只消费。
- `expectedRevision` 用于命令与设置页写入的乐观并发检查；不匹配返回 `state.revision_conflict`。

### 6.6 故障切换（failover）

```text
Authority 崩溃 / 心跳超时 / 窗口销毁
        │
        ▼
停止接受提交、撤销 lease（旧 token 立即失效）
        │
        ▼
从最后一次成功落盘的 state.json 恢复（未落盘的提交丢失）
        │
        ▼
authorityEpoch += 1，新建 authorityId + token
        │
        ▼
新权威窗口启动 → game_connect → ready → 收到快照
        │
        ▼
向所有 replica 广播 lifecycle: authority-changed + 新快照
```

- 恢复失败（存档损坏 / schemaVersion 不匹配 / 大小超限）→ 实例置 `failed`，`metadata.lastError` 记录原因，**不静默回退默认存档**。
- 失败切换最多自动重试 2 次（间隔 1s、5s），仍失败则停在 `failed`，等用户处理。
- 未成功提交的 authority 内存状态**永远不当作正式存档**（RFC §9.3）。

## 7. 实例生命周期与离线结算

### 7.1 状态机

```text
                 game_start             ready
  stopped ────────────────► starting ─────────► ready ──► running
     ▲                        │                 │            │
     │                        │ 失败            │            ├─ 用户暂停 / 系统休眠 → suspended
     │                        ▼                 │            ├─ 无副本且无控制器 → hidden（P2）
     │                      failed              │            └─ 用户要求后台运行 → background
     │                        │                 │                         │
     │                        └── 重试/清理 ────┘                         │ resume
     │                                                                  ▼
     └──────────────── stopping ◄──────────── 用户停止 / 退出 / 卸载 ── running
                          │
                          ▼
                       stopped
```

| 状态 | 含义 | tick | 接受命令 | 接受提交 |
| --- | --- | --- | --- | --- |
| `starting` | 校验包、载入存档、建权威窗、等 ready | 否 | 否（`game.instance_not_running`） | 否 |
| `ready` | 权威已就绪但尚未开始首个 tick | 否 | 否 | 是（初始化提交） |
| `running` | 正常 | `tickMs` | 是 | 是 |
| `hidden` | 无可见副本且无控制器（P2） | 暂停 | 是（排队或拒绝，P1 先拒绝） | 是（最后的清理提交） |
| `suspended` | 用户暂停或系统休眠 | 否 | 否 | 仅允许"暂停前收尾"一次 |
| `background` | 用户要求后台继续 | `tickMs × 4` | 是 | 是 |
| `stopping` | 拒绝新命令，等待保存 | 否 | 否 | 是（最终提交） |
| `stopped` | 已释放权威与副本 | 否 | 否 | 否 |
| `failed` | 恢复/启动/校验失败 | 否 | 否 | 否 |

`hidden` 与 `background` 的默认策略由 `games.json` + 用户设置决定；首期用"无副本即 hidden、用户显式后台则 background"。

### 7.2 启动序列（`game_start`）

```text
1. 校验 gameId / 包存在 / 已启用 / 能力授权 / 单实例规则 / 运行上限
2. 读取 game.json（含 hostApi / schemaVersion / display.policy / runtime.authority）
3. 打开或初始化存档目录，读 metadata.json / state.json，检查 state.schemaVersion
4. 生成 authorityId、authorityEpoch = 已存 epoch + 1、token、lease
5. 创建隐藏权威窗（非主线程），注入 __LULL_GAME_AUTHORITY__
6. 等 ready（10s 超时 → failed，authority.not_ready）
7. 首次快照落盘（revision 不变，确认可写）
8. 状态置 running，启动 tick（host-tick）
9. 向已 attach 的 replica / controller 广播 lifecycle: started + 快照
10. 返回 GameInstanceView
```

### 7.3 暂停与后台

- `game_suspend` / `game_resume` 从 P2 起可用（设置页「暂停 / 恢复」）：暂停前先落盘，恢复时把暂停时长作为 `offlineMs` 下发。**P1 不提供暂停操作**，避免出现"暂停了但状态未落盘"的中间态。
- `game_set_background` 从 P3 起可用（设置页「后台运行 / 回到前台」）：后台 tick 为 `tickMs × 4`（下限 200ms），没有参与者时也继续；回到前台时若有参与者或从未接入过参与者则回 `running`，否则回 `hidden`。`background` 只降低 tick 频率，不降低提交校验强度。
- P2 的 `hidden` 是自动状态：实例曾有副本/控制器，后来全部离开且仍在 `running` 时，ticker 把它置为 `hidden` 并停止 tick；新的副本/控制器接入会恢复为 `running`，并把 hidden 时长作为 `offlineMs` 下发。从未接入过参与者的实例保持 `running`（例如只在设置页启动、尚未绑定场景）。
- 系统休眠/锁屏事件首期不监听；恢复后按墙钟差补一次 offline 结算（见 §7.5）。
- `background` 只降低 tick 频率，不降低状态提交校验强度。

### 7.4 停止序列（`game_stop`）

```text
1. 状态置 stopping，拒绝新命令
2. 向权威窗发 lifecycle: stop
3. 等权威最终提交/落盘（超时 3s）
4. flush state（失败 → 不回滚状态为 stopped，实例置 failed 并报告）
5. 广播 lifecycle: stopped
6. 销毁全部 replica 会话、释放 lease、销毁权威窗
7. 写 metadata（lastStoppedAt / revision / epoch），状态置 stopped
```

**保存失败不允许假装停止成功**（RFC §14.3）：返回 `io.error`，实例停在 `failed` 并保留可恢复文件，设置页给出明确提示。

### 7.5 异常退出与恢复

| 场景 | 行为 |
| --- | --- |
| 应用被强杀 / 断电 | 下次启动读 `metadata.status`，把 `running` 改标 `interrupted`；不自动启动；设置页显示"可恢复，最后提交 revision=N" |
| Authority 窗口被用户关闭（Alt+F4） | `WindowEvent::Destroyed` → 立即 failover（§6.6） |
| Authority 页面报错 | `reportError` → 记账；连续 3 次或致命错误（`authority.crash`）→ failover |
| 存档被外部改坏 | 启动校验失败 → `failed`，保留原文件与最近备份，提示用户选择备份恢复 |

### 7.6 离线结算

- Host 记录 `metadata.lastCommittedAt`（墙钟）与 `state.simulationTimeMs`。
- 启动时向权威发 `lifecycle: resume { offlineMs }`；`offlineMs = min(now - lastCommittedAt, games.json.offlineMaxMs)`，默认上限 7 天（604800000），可配到 30 天。
- 算法由游戏实现（时间差结算），Host 只提供时长；**禁止逐帧重放**（RFC §9.4）。
- 首期不做"离线收益按 tick 补发"；如果游戏需要，自己在 resume 里按 delta 计算并提交。

### 7.7 运行上限与并发

- 同一 `gameId` 同时最多 1 个活动实例（`game.start_exists`）。
- 同时运行实例默认上限 3（`games.json.maxRunning`，clamp 1–3），超出返回 `game.instance_limit`。
- 每个实例最多 1 个权威窗、`maxReplicas` 个副本（默认 8，clamp 1–16）、不限控制器（但每个 Widget 受自身限流约束）。
- 停止/失败实例不占运行名额。

## 8. 状态仓储

### 8.1 路径

```text
%APPDATA%\app.lull.desktop\
  games\                                   # 游戏包（安装目录，对标 widgets\content）
    <gameId>\
      game.json
      authority\ ... replica\ ... assets\ ...
    .grants.json                           # 启用状态 + 能力授权 + 清单指纹
  game-data\                               # 游戏存档（独立根，卸载包不删）
    <gameId>\
      <instanceId>\
        metadata.json                      # 实例元数据与运行状态
        state.json                         # 最后一次成功落盘的权威状态
        journal.ndjson                     # 提交诊断日志（不回放，滚动裁剪）
        backups\
          state-<revision>.json            # 最多保留 3 份
  games.json                               # 运行偏好（maxRunning / resumeOnLaunch / autoStart / offlineMaxMs）
```

开发与测试可用 `LULL_GAMES_DIR`、`LULL_GAME_DATA_DIR` 覆盖（与 `LULL_WIDGETS_DIR`、`LULL_CONTENT_DIR` 同思路）。目录权限与创建走 `app_data_dir()`。

### 8.2 metadata.json

```json
{
  "schemaVersion": 1,
  "gameId": "community.living-world",
  "instanceId": "0192f3a6...",
  "gameVersion": "1.0.0",
  "stateSchemaVersion": 1,
  "engine": { "id": "canvas2d", "version": "1.0.0", "renderMode": "canvas2d" },
  "status": "running",
  "authorityEpoch": 3,
  "revision": 42,
  "simulationTimeMs": 1234567,
  "lastCommittedAt": 1760000000000,
  "createdAt": 1760000000000,
  "lastStartedAt": 1760000100000,
  "lastStoppedAt": null,
  "lastError": null
}
```

### 8.3 state.json

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "authorityEpoch": 3,
  "simulationTimeMs": 1234567,
  "updatedAt": 1760000200000,
  "state": { "resources": { "food": 12 }, "plants": [] }
}
```

`state` 对宿主是不透明 JSON：宿主只校验大小、外层字段与 revision/epoch，不解释业务结构。

### 8.4 写盘策略

| 时机 | 行为 |
| --- | --- |
| 每次成功提交 | 更新内存快照；合并写盘（host-tick 默认 1s、self-loop 2s；可用 `runtime.commit.flushMs` 收紧到 ≥250ms） |
| `suspend` / `stop` / 应用退出 | 强制 flush（有界等待，默认 3s） |
| 干净停止 | 额外写一份备份 |
| 每 N 次提交（默认 60） | 写一份备份，滚动保留 3 份 |
| 恢复/failover | 只读 `state.json`；不改写；不做"猜回退" |

写盘统一"临时文件 → rename 原子替换"，与现有 `widget_package::store::write_atomic`、`config` 的做法一致；写盘失败必须把错误上抛到命令调用方，不允许吞掉。

### 8.5 大小与版本限制

| 项 | 默认 | 来源 |
| --- | --- | --- |
| 单次提交 state | 1 MiB（manifest 可收紧；硬上限 8 MiB） | `state.maxSizeBytes` |
| 单条事件 payload | 16 KiB | 常量 |
| 单次提交事件数 | 32 | 常量 |
| 渲染态 | 64 KiB | 常量 |
| `state.schemaVersion` | 包自己声明；不匹配拒绝加载 | manifest |
| 实例目录总数 | 单游戏 1 个活动实例；历史实例目录保留（可手动删） | `games.json` |

manifest 可以**收紧**上限，不能放宽硬上限；放宽只能由宿主版本发布。

### 8.6 损坏与恢复

- `state.json` 解析失败 / 外层字段缺失 → 尝试最近一份 `backups/state-*.json`；仍失败 → `failed`，保留现场，设置页提示"打开存档目录"。
- `metadata.json` 损坏但 `state.json` 可用 → 重建 metadata（epoch 以 1 开始重新计数，留诊断日志），不丢状态。
- 存档目录不可写 → `game_start` 失败（`io.error`），不创建半运行实例。

### 8.7 卸载、删除与导出

- 卸载游戏包：若实例在运行，先停止；停止失败则拒绝卸载。**默认保留 `game-data/<gameId>/`**；设置页提供"同时删除存档"勾选，走 `game_save_delete`。
- `game_save_delete` 要求实例已停止，删除整个 `game-data/<gameId>/`（含所有 instance 目录、备份与 metadata）；命令需二次确认（前端对话框）。
- 设置页「清除数据」是前端编排：`game_stop` → `game_save_delete` → `game_start`。只在运行中显示，需二次确认；会停止游戏、删除全部存档并以初始状态重新启动（新的 `instanceId`，`revision` / `simulationTimeMs` 归零），控制器与壁纸副本会短暂断开后重新接入。
- 导出/导入存档：P5，不在首期范围。

## 9. 协议总览

### 9.1 版本常量

| 常量 | 值 | 变更规则 |
| --- | --- | --- |
| `GAME_SCHEMA_VERSION` | 1 | `game.json` 破坏性变更才 +1 |
| `GAME_HOST_API` | 1 | 宿主 API 破坏性变更才 +1 |
| `GAME_PROTOCOL` | 1 | 命令/事件 payload 破坏性变更才 +1 |
| `state.schemaVersion` | 由游戏声明 | 游戏存档结构独立演进 |

不支持的值一律**明确拒绝**（`game.unsupported_schema` / `game.unsupported_host_api` / `protocol.unsupported`），不静默降级。

### 9.2 命令

`GameErrorBody`（§9.4）是唯一的错误载体；SDK 把失败映射为带 `code` 的 rejection 或结果对象。命令参数与返回签名见附录 B。

**宿主管理（settings / 扩展中心；`game_auto_start` 额外开放给壁纸窗）**

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `games_list` | — | `GameView[]` | 已安装游戏 + 运行状态 + 存档摘要 + `entryReplicaUrl` |
| `game_replica_entry` | `gameId` | `GameReplicaEntry` | 壁纸窗专用：读取包内 `entry.replica` URL；不需要运行时 token |
| `game_start` | `gameId` | `GameInstanceView` | 启动实例（幂等：已运行返回现状） |
| `game_open_controller` | `gameId, controllerId?` | `()` | 打开并绑定控制器窗口；缺省 `controllerId` = 全部声明控制器；要求实例处于运行中 |
| `game_close_controller` | `gameId, controllerId?` | `()` | 关闭控制器窗口；缺省 = 全部 |
| `game_controller_request` | `{ controllerId, action: "open" \| "close" }` | `()` | Authority 专用：游戏请求打开/关闭**自己**的控制器窗口 |
| `games_config_get` / `games_config_set` | `config`（set） | `GamesConfig` | 读取/写入 `games.json`（autoStart / maxRunning / offlineMaxMs / controllerFollowsGame） |
| `game_auto_start` | `gameId` | `GameInstanceView \| null` | 壁纸窗专用：按 `autoStartWithWallpaper` 启动场景绑定或设为壁纸的游戏 |
| `game_stop` | `gameId` | `GameInstanceView` | 停止并落盘 |
| `game_suspend` / `game_resume` | `gameId` | `GameInstanceView` | 暂停 / 恢复（P2；恢复时下发 offlineMs） |
| `game_set_background` | `gameId, enabled` | `GameInstanceView` | 后台运行（tickMs×4）/ 回到前台（P3） |
| `game_runtime_diagnostics` | — | `GameRuntimeDiagnostics` | 只读运行时计数（稳定性报告用） |
| `game_flush` | `gameId` | `GameInstanceView` | 立即落盘（"立即保存"） |
| `game_save_delete` | `gameId` | `()` | 删除整份游戏存档（需已停止）；设置页「清除数据」在运行中组合 stop → delete → start |

**角色参与（authority / wallpaper / widget / settings）**

| 命令 | 可调用窗口 | 权限 | 说明 |
| --- | --- | --- | --- |
| `game_connect` | authority / wallpaper / widget / controller | 按角色 + 包授权；控制器先查宿主 binding | 注册参与者，返回 `GameContext`（replica 附带渲染上下文与 `replicaId`，controller 附带 `controllerId`） |
| `game_snapshot_get` | authority / wallpaper / widget / controller | `game.state.read` | 取当前完整快照（断档恢复用） |
| `game_command_send` | widget / controller / settings | Widget 需 `game.command.send`；包内控制器按清单 scope；settings 免 | 发送命令，等待 authority 结果或超时 |
| `game_state_commit` | authority | `game.state.write` | 提交权威状态 |
| `game_event_publish` | authority | `game.event.publish` | 发非状态事件 |
| `game_render_state_publish` | authority | `game.render.publish` | 发渲染态（不落盘） |
| `game_command_result` | authority | `game.command.receive` | 回传命令执行结果 |
| `game_ready` | authority / wallpaper | — | 就绪握手 |
| `game_heartbeat` | authority | — | 续租 |
| `game_report_error` | 所有参与者 | — | 上报错误（限流） |
| `game_detach` | 所有参与者 | — | 注销参与者 / 停止权威 |

ACL 只表示"该窗口可以调用这条命令"，角色、能力与提交校验全部在 Rust 里二次执行。

### 9.3 事件

| 事件 | 目标 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `game:snapshot` | replica / controller 窗口 | `GameSnapshot` | 初始与合并后的完整快照 |
| `game:event` | replica / controller 窗口 | `GameEvent` | 增量事件 |
| `game:render` | replica 窗口 | `GameRenderState` | 渲染态（不落盘） |
| `game:lifecycle` | authority / replica / controller | `{ gameId, instanceId, authorityEpoch, revision, state, reason?, offlineMs?, error? }` | `started/stopped/suspended/resumed/authority-changed/failed` |
| `game:command` | authority 窗口 | `GameCommandEnvelope` | 路由到权威的命令 |
| `game:command-result` | 命令发起窗口 | `GameCommandResult` | 权威回传结果 |
| `game:tick` | authority 窗口 | `{ simulationTimeMs, deltaMs, wallClockMs }` | host-tick 模式 |
| `games-changed` | 广播 | `()` | 设置页/扩展中心/托盘刷新列表 |

事件只走**已订阅窗口**（Rust 侧维护订阅表，按实例与窗口 label 投递），不做全局广播，避免游戏数据泄漏到无关窗口。Rust 用 `emit_to(label)` 定向投递；前端 `listen` 必须同时把当前窗口 label 作为 target，原因见 §10.1.1。

### 9.4 错误体

```ts
type GameErrorBody = {
  code: string;      // 稳定标识，前端按 code 映射文案
  message: string;   // 可直接展示
  detail?: string;   // 仅诊断
};
```

完整错误码见附录 A。

### 9.5 幂等、超时与限流

- **幂等**：`game_command_send` 按 `(instanceId, requestId)` 在内存保留近期结果（256 条 / 5 分钟）。重复 requestId 直接返回已记录结果，不重新执行。幂等表不落盘：authority 重启后丢失，跨重启的幂等由游戏按业务键自行处理（P5 再评估是否落 journal）。
- **超时**：`game_command_send` 默认 5s（manifest 可按命令声明 `timeoutMs`，上限 8s）；超时返回 `command.timeout`，Host 记一条 `command.timeout` 事件，**不撤回**可能已经发生的状态变化。
- **限流**：
  - Controller 命令：8 次/秒，burst 16；
  - Authority 提交：host-tick ≤ 1 次/tick 且 ≤ 8 次/秒 burst 16；self-loop ≤ 4 次/秒 burst 8；
  - 渲染态：≤ 10 次/秒 burst 20；
  - 错误上报：≤ 1 次/秒，burst 5；
  - 快照投递：按窗口合并，≤ 8 次/秒。
- 被限流的调用返回稳定错误码，不做静默丢弃。

### 9.6 版本兼容

- 新增可选字段不升 `GAME_PROTOCOL`；读取方必须忽略未知字段。
- 破坏性变更升版本，宿主对旧版本明确拒绝并给出升级提示。
- 游戏包版本（`version`）与存档结构（`state.schemaVersion`）相互独立；引擎版本升级**不会**自动触发存档迁移。

## 10. 命令路由与结果回传

### 10.1 来源与角色判定

角色只由窗口 label 推导：

| label | 角色 | 额外凭证 |
| --- | --- | --- |
| `game-authority-<hex>` | authority | `authorityToken`（注入） |
| `wallpaper-<index>` | replica | `gameToken`（顶层帧注入） |
| `game-controller-<hash>-<id>` | controller | 窗口 token（建窗时签发）+ 宿主 binding |
| `widget-<id>` | controller | Widget 桥 token + 授权账本 + 宿主 binding |
| `settings` | manager | 无 token（宿主控制面） |

任何消息里的 `role` 字段只用于协议完整性检查，**不参与授权判定**。控制器窗口的
`gameId / controllerId` 一律取自宿主写入的 binding，页面传参只用于一致性校验。

#### 10.1.1 前端监听必须带窗口 target

Tauri JS `listen(event, handler)` 默认注册 `{ kind: "Any" }`。`emit_to(label)` 的
定向过滤只检查**监听器注册的 target**，`Any` 监听器无条件匹配；因此所有注册了
同名事件的窗口都会收到每个 `emit_to` 事件。多游戏同时运行时，authority 会收到
其它游戏的 `game:tick` / `game:command`，replica/controller 会收到其它游戏的
`game:snapshot` / `game:event`，表现为状态串台。

游戏事件统一通过 `src/games/bridge/game-events.ts` 的 `listenGameEvent` 注册：

```ts
listenGameEvent("game:snapshot", handler); // 自动带 { target: { kind: "AnyLabel", label } }
```

- 浏览器预览/单测没有 Tauri 内部对象时才退回默认监听；Tauri 内取不到窗口 label
  会拒绝注册并报错，绝不退回全局监听。
- snapshot / event / render / lifecycle 还应检查载荷 `gameId`，作为第二层防护。
- `game:command` / `game:tick` 载荷不含 `gameId`，只能依赖窗口 target；这两类
  监听绝不能省略 target。
- 新增针对 `emit_to` 的监听点也必须传 target；`games-changed`、`media:event` 等
  全局广播事件不受此限制。

### 10.2 校验流水线（`game_command_send`）

```text
1. 窗口角色 = controller/manager
2. 控制器先查宿主 binding（窗口存在即存在）；Widget 再走授权账本校验 `game.command.send`
3. requestId 格式合法、非重复（重复 → 返回已记录结果）
4. 命令类型在 manifest.commands 中出现
5. 命令类型在该控制器的 allowedCommands 内（清单未声明 = 全部；[] = 只读）
6. 游戏声明并授权了 game.command.receive
7. payload 大小 ≤ 32 KiB
8. **P1 只做类型声明与大小校验**；按 `commands.<type>.schema` 做参数 JSON Schema 校验延后到 P2
9. expectedRevision（可选）与当前 revision 一致，否则 state.revision_conflict
10. 发送方/实例限流
11. 实例 running / background，否则 game.instance_not_running
12. 生成 GameCommandEnvelope，定向发给 authority 窗口，登记 pending（requestId → 发起窗口）
13. 等待 game_command_result / 超时
14. 定点回传 game:command-result（只给发起窗口），记录幂等结果
```

### 10.3 权威侧

- 权威壳页把 `game:command` 转给游戏 iframe；游戏通过 Game SDK `onCommand` 处理。
- 游戏处理完后通过 `game_command_result(requestId, ok, result?, error?)` 回传；也可以先提交状态再回传。
- 权威不主动发命令结果，只应答；Host 对未应答的 requestId 在 TTL 后标记超时。
- **实现约束**：`game_command_send` 必须在阻塞线程上等待回执（`spawn_blocking`），不能占住主线程。
  authority 的 `state.commit` / `game_command_result` 回复也走主线程 IPC，同步等待会把它们
  一起卡到命令超时（表现为命令总是 timeout、状态却已经改变）。

### 10.4 结果与状态的关系

- 命令"已接受"不等于"状态已改变"：最终以提交后的 revision 与事件为准。
- 命令结果可以携带 `revision`（游戏自己填），Host 会以实际提交的 revision 为准做校验；不一致只记日志，不拒绝。

## 11. 快照、事件、渲染态

### 11.1 生成

- 每次成功提交：`GameSnapshot`（完整 state + revision + epoch + simulationTimeMs）。
- 同一提交可附带 `events[]`（≤32）与可选 `renderState`。
- `game_event_publish` 只发事件、不改 revision（用于非状态通知，如"任务完成"提示，实际任务状态仍应走提交）。
- `game_render_state_publish` 只发渲染态，不落盘、不进事件历史。

### 11.2 Envelope

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
  eventId: string;        // `${instanceId}:${revision}:${seq}`
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
  publishedAt: number;
};
```

### 11.3 合并与节流

- 快照按窗口合并：同一窗口 125ms 窗口内只投最新一份（保证最终一致，不保证逐次）。
- 事件不合并（低频、有顺序），但按窗口分别投递；单次提交事件数超限时整次提交被拒，避免半分发。
- 渲染态按最新覆盖，允许丢中间帧。
- 分发失败（窗口已销毁）不重试，直接从订阅表移除。

### 11.4 订阅与过滤

- Authority 订阅：`game:command`、`game:lifecycle`、`game:tick`。
- Replica 订阅：`game:snapshot`、`game:event`、`game:render`、`game:lifecycle`。
- Controller 订阅：`game:snapshot`、`game:event`、`game:lifecycle`、`game:command-result`。
- 事件按实例隔离：A 游戏的事件不会投给 B 游戏的窗口。

### 11.5 断档处理

Replica 侧规则与 RFC §5.2 一致：

```ts
if (event.authorityEpoch !== context.authorityEpoch) {
  requestSnapshot();
  return;
}
if (event.revision !== lastRevision + 1) {
  requestSnapshot();
  return;
}
applyEvent(event);
lastRevision = event.revision;
```

`requestSnapshot()` 在宿主侧对应"顶层帧向 `game_snapshot_get` 取一次并转发 `game.snapshot`"，不对 authority 产生命令流量。

### 11.6 大小上限

见 §8.5；超限整次提交/事件被拒绝并返回错误，不做截断（截断会制造不可恢复的状态歧义）。

## 12. 多屏 Replica

### 12.1 注册表

```rust
pub(crate) struct ReplicaEntry {
  pub(crate) replica_id: String,
  pub(crate) instance_id: String,
  pub(crate) window_label: String,     // wallpaper-<index>
  pub(crate) display_device: String,   // \\.\DISPLAY1（来自 wallpaper::runtime::device_for_label）
  pub(crate) source: ReplicaSource,    // Scene | Package（P4）
  pub(crate) mode: String,             // mirror | span
  pub(crate) canvas: Option<Rect>,     // 物理像素跨屏画布
  pub(crate) view: Option<Rect>,       // 当前显示器矩形
  pub(crate) viewport: Viewport,       // CSS 像素 + dpr
  pub(crate) last_ack_revision: u64,
  pub(crate) connected_at_ms: u64,
}
```

- 按 `window_label` 唯一：同一壁纸窗重建后重新 attach，旧条目先移除。
- `replica_id` 每次 attach 新发，用于让前端识别"我这一份连接"。
- 显示器断开 → 窗口销毁 → `game::on_window_destroyed` 移除条目；**不停止实例**。

### 12.2 attach 流程

```text
壁纸窗顶层帧（isDesktopWindow）
  │ 1. 读取当前 scene 绑定的 gameId（scene manifest.game.id）
  │ 2. 实例未运行时不 attach（P2 不做自动启动；用户在设置页启动后再连接）
  │ 3. game_connect({ gameId, sceneId, render: { mode, canvas, view, viewport } })
  ▼
Rust 校验（窗口 label、gameToken、能力、实例存在、replica 上限）
  ▼
返回 { replicaId, context }
  ▼
Rust 立即投递初始 game:snapshot（每窗一份）
  ▼
顶层帧把 game.init（context + snapshot）转发给场景 iframe（场景 ready 后）
```

场景 iframe 尚未 ready 时，顶层帧先缓存最新快照，收到场景 `ready` 后再发 `game.init`；不丢首帧。场景回 `game.ready` 后，顶层帧调一次 `game_ready()` 标记该 replica 就绪（仅用于诊断与设置页展示，不影响分发）。

### 12.3 几何与显示模式

- `displayId` 由宿主按壁纸窗口 label 解析（`wallpaper::runtime::device_for_label`），前端传入值被忽略；与 `display.json` 的 monitors key 一致，便于诊断。
- `GameRenderContext` 直接由 `SceneFrame` 映射：

```ts
type GameRenderContext = {
  protocol: 1;
  displayId: string;
  mode: "mirror" | "span";   // 游戏只区分"单屏视口"与"跨屏画布"
  canvas: SceneRect;          // 物理像素，可为负
  view: SceneRect;
  viewport: { width: number; height: number; dpr: number };
};
```

- `mirror`：`canvas = view`，每屏按视口渲染完整世界。
- `span`：`canvas` 是虚拟桌面并集、`view` 是本屏矩形；replica 用 `view` 对画布做裁剪，**不重新计算游戏坐标**（复用 `core/wallpaper/params.ts` 的 `canvasTransform` 语义）。
- 游戏世界逻辑坐标不依赖某个显示器的 DPR；DPR 只影响渲染采样。
- 壁纸 `independent` 模式：每屏可独立选择场景或游戏；底层仍支持同一游戏实例被多屏 attach，但壁纸设置页的逐屏下拉只允许一台显示器选中同一游戏，视频/图片等场景可重复。不同游戏各自实例（受 `maxRunning` 限制）。`display.policy` 仍是 `shared`，区别只在“每屏选哪个内容源”。

### 12.4 显示模式矩阵

| 壁纸模式 | `display.policy` | Replica 行为 | 游戏世界 |
| --- | --- | --- | --- |
| `mirror` | `shared` | 每屏一个 replica，整幅渲染 | 一个 |
| `span` | `shared` | 每屏一个 replica，按 canvas/view 裁剪 | 一个 |
| `independent` | `shared` | 每屏一个 replica；可各自选场景或不同游戏，同一游戏在壁纸设置 UI 中最多一台屏选中 | 每个游戏一个 |
| 任意 | `per-monitor` | 启动时拒绝（`game.unsupported_display_policy`） | — |

### 12.5 重建与热插拔

```text
显示器新增 / 壁纸开关打开
        │
        ▼
壁纸窗口创建 → 场景 ready → replica attach → 初始快照 → 渲染

显示器移除 / 壁纸窗口销毁
        │
        ▼
replica detach（只删条目，不停止实例）

壁纸重建（拓扑变化 / ensure）
        │
        ▼
旧窗口销毁（detach）→ 新窗口创建 → 重新 attach → 新快照
```

### 12.6 上限与失败

- 超出 `maxReplicas`：`game_connect` 返回 `replica.limit_reached`；壁纸窗回退到普通场景渲染（不显示游戏）。
- 单窗口 attach 失败：记日志 + 显示场景自身的错误提示，不影响其它屏。
- 实例未运行：`game_connect` 返回 `{ context: null, replicaId: null }`（正常态），场景按普通壁纸渲染；不报错弹窗。

### 12.7 可见性与暂停

- 壁纸总开关隐藏（native `set_visible`）首期**不**自动暂停游戏：游戏是桌面级实例，可能在别的屏或控制器上继续。显式暂停入口在设置页（P2 起）。
- `hidden` 状态只由"无 replica 且无 controller"触发（P2 起）。
- P3 再评估监听 `media-master-visible` / 系统锁屏决定是否降频。

## 13. Scene Game Bridge

### 13.1 绑定方式

Scene manifest 增加可选字段：

```json
{
  "game": {
    "id": "community.living-world",
    "role": "replica"
  }
}
```

规则：

- `game` 属于**场景宿主 API 2**：P2 把 `SCENE_HOST_API` 从 1 提升到 2，使用该字段的场景包声明 `compatibility.hostApi: 2`。老宿主的清单解析器不认未知字段，会在目录加载阶段把该场景记为 issue 并跳过；新宿主解析后按 `compatibility` 正常加载。
- 场景包自身 `schemaVersion` 仍是 1；`game` 是新增可选字段，新宿主不要求所有场景都声明。
- `game.role` 只接受 `"replica"`；Scene 永远不能声明 authority。
- 声明 `game` 的 scene 必须同时声明 `wallpaper.script`，否则清单校验失败。
- 一个游戏可被多个 scene 绑定（不同视觉主题）；一个 scene 只能绑定一个游戏。
- 绑定只表示"这个场景想渲染这个游戏"，**不自动创建实例**；实例生命周期归 `game_start`。
- 场景 id 与游戏 id 各自独立；卸载游戏不会卸载 scene，scene 回退普通渲染。

### 13.2 消息扩展（协议保持 v1）

宿主 → 场景 iframe（新增类型，旧 SDK 忽略）：

| 消息 | 载荷 | 时机 |
| --- | --- | --- |
| `game.init` | `{ gameId, instanceId, authorityEpoch, revision, render, snapshot }` | 场景 ready 后、首次 attach 成功 |
| `game.snapshot` | `{ snapshot }` | 初始之后的合并快照 |
| `game.event` | `{ event }` | 增量事件 |
| `game.render` | `{ renderState }` | 渲染态 |
| `game.lifecycle` | `{ state, reason? }` | `started/stopped/suspended/resumed/authority-changed/failed`（hidden 用 `suspended` + `reason: "hidden"`） |
| `game.unavailable` | `{ reason? }` | 场景已 ready，但当前没有可渲染实例（未运行/未启用） |
| `game.init`（重复） | 同首次 | iframe 重载/重新 attach 时更新 context 与渲染几何 |

场景 → 宿主 iframe（新增类型）：

| 消息 | 载荷 | 说明 |
| --- | --- | --- |
| `game.ready` | `{}` | 场景游戏桥就绪（可延迟到首帧） |
| `game.requestSnapshot` | `{}` | 断档/epoch 变化时主动重取 |
| `game.reportError` | `{ code, message }` | 上报渲染错误（不触发权威 failover） |
| `game.detach` | `{}` | 场景销毁时通知宿主移除 replica（宿主也会在窗口卸载时兜底 detach） |

- 消息仍是 `{ v: 1, type: "...", ... }`，走既有 `postMessage` 与 `event.source === iframe.contentWindow` 校验。
- `@lull/scene-sdk` 的 `isSceneHostMessage` 对未知类型返回 `false`，旧场景页面不受影响；新场景使用 `@lull/game-sdk/scene` 的 `connectLullGameRender()` 独立监听。
- 宿主在**只有 scene manifest 声明了 `game`** 时才发送这些消息。

### 13.3 时序

```text
场景 iframe load → 场景 ready（scene 桥）
        │
        ▼
宿主：game_connect（若需要）→ 收初始快照
        │
        ▼
game.init（context + snapshot）→ 场景渲染
        │
        ▼
后续 game.snapshot / game.event / game.render / game.lifecycle
        │
        ▼
场景发现断档 → game.requestSnapshot → 宿主 game_snapshot_get → game.snapshot
```

### 13.4 权限矩阵

| API | Scene | Authority | Controller |
| --- | --- | --- | --- |
| `getSnapshot` / `onSnapshot` | 允许 | 允许 | 允许 |
| `onEvent` | 允许 | 允许 | 允许 |
| `onRenderState` | 允许 | — | — |
| `onCommand` / `onTick` | 禁止 | 允许 | 禁止 |
| `commitState` | 禁止 | 允许 | 禁止 |
| `publishEvent` | 禁止 | 允许 | 禁止 |
| `publishRenderState` | 禁止 | 允许 | 禁止 |
| `command`（发命令） | 禁止 | 禁止 | 允许 |
| `myRole` / 上下文 | 只读 | 只读 | 只读 |

SDK 在类型层与运行时双重拒绝越权调用；即使绕过 SDK 直接 postMessage，宿主壳也不会转发对应请求。

### 13.5 示例

```ts
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
  const snapshot = await game.getSnapshot();
  drawWorld(canvas, snapshot, game.render);
  game.onSnapshot((next) => drawWorld(canvas, next, game.render));
  game.onEvent("world.changed", (event) => playRipple(event.payload));
  game.onRenderState((state) => animateTo(state));
} else {
  drawIdleScene(); // 该屏没有绑定到运行中的游戏
}
```

## 14. Controller 接入

### 14.1 能力（外部 Widget 载体）

外部 Widget 控制器在 `widget.json` 声明三项能力（宿主授权后生效）：

| 能力 | 用途 |
| --- | --- |
| `game.state.read` | 取快照、订阅快照与事件 |
| `game.command.send` | 发送命令 |
| `game.event.read` | 订阅游戏事件 |

不可申请：`game.state.write`、`game.authority.claim`、`game.instance.manage`、`game.storage.raw`、`game.window`。Widget 不能暂停/停止游戏——那是设置页（宿主控制面）的能力。

新增能力必须同步四处白名单（漏一处就会出现"清单能写、运行期不认"）：`src/sdk/widget/types.ts`（宿主枚举，`gen-widgets.mjs` 读它）、`packages/widget-sdk/src/protocol.ts`（客户端校验）、`src-tauri/build.rs` 的 `CAPABILITIES`（内置清单生成）、`src-tauri/src/widget_package/manifest.rs` 的 `PLUGIN_CAPABILITIES`（第三方清单校验）。

### 14.2 桥方法

Widget 桥协议保持不变（`WIDGET_PROTOCOL = 1`），新增方法：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `game.connect` | `{ gameId? }` | `GameWidgetContext` |
| `game.snapshot` | `{}` | `GameSnapshot \| null` |
| `game.command` | `{ requestId, type, payload, expectedRevision? }` | `GameCommandResult` |
| `game.disconnect` | `{}` | `{ disconnected: boolean }` |

`game.connect` 的 `gameId` 可省略：宿主打开控制器时写入 `controller_bindings`
（窗口 label → `{gameId, controllerId, kind, allowedCommands, allowedEvents}`），
页面不需要也不应该自己猜游戏 id。已有 binding 时传了不同的 gameId 直接
`game.controller_target_mismatch`；没有 binding（例如从扩展中心手动打开 Widget）
必须显式传 gameId，且该游戏清单确实声明了这个 Widget，否则 `game.controller_not_declared`。

宿主壳收到方法后：先查 Widget 上下文的能力清单，再调对应 `game_*` 命令；Rust 再按窗口 label + 授权账本二次校验。`game.event` 事件由宿主壳监听 Tauri `game:event` 后转发给 iframe。

### 14.2.1 声明、打开入口与激活门禁

游戏清单用 `controllers[]` 声明 0–8 个控制器窗口：

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

| 字段 | 规则 |
| --- | --- |
| `id` | 同一游戏内唯一，`^[a-z][a-z0-9-]{0,31}$`；窗口 label 与 binding 的槽位标识 |
| `entry` / `widgetId` | 二选一：包内页面（`controllers/` 下的 `.html`）或外部 Widget |
| `commands` / `events` | 可选子集；缺省 = 全部声明；`[]` = 只读 |
| `window` | 宽 240–1600、高 200–1200；`resizable` / `alwaysOnTop` 默认 false |
| `autoOpen` | 默认 true；仅在 `controllerFollowsGame` 开启时随启动自动打开 |

不同游戏可以复用同一个 controller id 或命令名：窗口 label 为
`game-controller-<fnv1a32(gameId)>-<id>`，binding、token、命令和事件都按游戏隔离。
`examples/games` 的三个引擎示例仍使用不同 id/label，方便多控制器窗口同时打开时分辨。

旧的单数 `controller: { widgetId }` 仍接受，归一化为 `controllers=[{id:"default",…}]`；
两者同时声明会被清单校验拒绝。

**激活门禁**：控制器只在实例 `running | hidden | suspended | background` 时可用。
`game_open_controller`、`game_connect`、`game_controller_request`、设置页开关与托盘入口
共用 `InstanceStatus::accepts_controller()`；停止/失败时先广播 `lifecycle(stopped|failed)`，
再销毁该游戏全部控制器窗口（不再保留"手动打开"的窗口）。

| 入口 | 行为 |
| --- | --- |
| `games_list` 的 `GameView.controllers[]` | `{id, kind, label, widgetId, entry, installed, enabled, autoOpen, windowOpen, connected}` |
| 设置页 | 只在运行中实例操作区显示每个控制器的开关；游戏未运行时不渲染控制器行 |
| 托盘 | 「设置 ▸ 游戏控制器」列出全部运行中游戏的控制器，壁纸激活的游戏排前；多显示器同一游戏去重，多游戏按游戏分组 |
| `games.json.controllerFollowsGame`（默认开） | `game_start` 后打开 `autoOpen` 控制器；`game_stop` 回收该游戏全部控制器 |
| 游戏侧 | Authority 调 `game_controller_request({controllerId, action})` 打开/关闭自己的控制器 |

错误码：`game.controller_not_declared` / `not_installed` / `disabled` / `unknown` /
`not_active` / `in_use` / `target_mismatch` / `not_targeted` / `read_only`。
安装脚本 `pnpm games:samples:install` 只安装游戏包；示例控制器全部是包内页面，
随游戏包一起安装。第三方游戏仍可声明 `widgetId` 载体。

### 14.3 时序

```text
设置页/托盘/游戏 → game_open_controller / game_controller_request
  → 校验实例 accepts_controller + 载体可用 → 写 binding → 建窗
控制器页 ready → 壳 game_connect(token) → 查 binding + 校验激活 → init{context, snapshot}
  → 用户操作 → command.send → game_command_send（binding scope + 实例状态）→ authority
  → 游戏提交 → game:snapshot / game:event / game:lifecycle → 壳 → iframe
停止/失败 → 先广播 lifecycle(stopped|failed) → 销毁该游戏全部控制器窗口（删 binding）
```

### 14.4 与设置页控制面的区别

| 能力 | Controller 窗口 | 设置页 / 扩展中心 |
| --- | --- | --- |
| 读状态 / 发命令 | ✅ | ✅ |
| 启动 / 停止 / 暂停 | ❌ | ✅ |
| 清除数据 / 删除存档 / 打开目录 | ❌ | ✅ |
| 修改授权 | ❌ | ✅ |
| 写权威状态 | ❌ | ❌（只有 Authority 能写） |

## 15. 游戏包、授权与资源协议

### 15.1 目录与安装

```text
<来源>/<gameId>/
  game.json          # 必需
  authority/index.html
  replica/index.html # 可选：壁纸直接渲染入口（P4 已接入）
  assets/ ...
```

- 来源与 scene/widget 一致：随应用分发的官方包（P5）、用户安装 `%APPDATA%\app.lull.desktop\games\`、开发模式挂载（P1 起支持）。
- 安装统一走 `extension::install` 的 staging → 校验 → 原子 rename 管线；安装器识别 `game.json` 作为第三类清单。
- 游戏包单独的体积预算：单文件 16 MiB、整包 128 MiB、最多 1024 个文件。理由：Web 游戏可能携带引擎与贴图；scene/widget 的 8 MiB/64 MiB/512 不变。安装器按包内是否含 `game.json` 自动选择预算。
- 摘要：与 widget 相同的旁路 `.lull-integrity.json`（不进摘要、不参与协议服务），算法域分隔符用 `lull-game-package\0`。
- 签名：复用 `content_trust` 的发布者签名链路，`PackageKind::Game`；官方包按既有策略豁免社区签名。

### 15.1.1 单包双入口：authority + replica

一个 `.lull-game.zip` 同时承载逻辑与可见渲染，不需要再安装 Scene：

| 入口 | 运行位置 | 权限 |
| --- | --- | --- |
| `entry.authority` | 隐藏/后台 `game-authority-*` 窗口 | 提交状态、发事件、回传命令结果（token + 租约） |
| `entry.replica` | 壁纸窗内的 `sandbox="allow-scripts"` iframe | 只读快照/事件/渲染态；没有 Tauri IPC 与提交入口 |

- 壁纸选择：`display.game = <id>`（独立字段，不写进 `display.scene`）。`wallpaper_set_game` 校验包内存在 `entry.replica` 后热更所有壁纸窗；选择场景会自动清空 `display.game`。
- 逐屏游戏：independent 模式新增 `monitors[<device>].game`。每块屏可在「壁纸类型」下拉里独立选择游戏（`wallpaper_set_monitor_game`），选择场景会用 `wallpaper_set_monitor_scene` 清掉该屏游戏；mirror/span 忽略逐屏游戏，只认 `display.game`。
- 进入独立模式：若当前有全局游戏，`wallpaper_set_display` 会把游戏固定到主屏（`primary: true`），所有其它显示器的逐屏场景写为 `display.scene` 并清掉游戏（含已关闭/离线条目），再应用模式。主屏画面保持，副屏回退到选中游戏前的壁纸；`display.game` 保留，切回复制/跨屏时仍恢复全局游戏。
- 逐屏互斥：独立模式的每屏下拉会禁用其它显示器当前生效的游戏并标注，避免同一游戏同时出现在多块屏；视频/图片等场景不互斥，可以重复。
- URL 协议：壁纸 hash 同时携带 `scene=` 与可选的 `game=`；`monitor_url` 按 `effective_game(device)` 解析，前端只在 `game` 非空时挂 `GameReplicaHost`，清空后立即回退到场景，不重载页面。
- 信任边界：两个入口同包同源，但 authority 的提交能力来自窗口角色 + token，replica 永远拿不到 token；副本 iframe 的 `allow-scripts` 不包含 `allow-same-origin`。
- `display.policy` 仍是 `shared`：同一游戏实例仍可被多块屏 attach（mirror/span 或旧配置），但 independent 的新选择受逐屏互斥约束；`wallpaper::runtime::active_games()` 取全局 + 逐屏游戏的并集，托盘控制器按游戏分组。
- 切换游戏：壁纸设置下拉切换时若旧游戏仍有运行实例，会提示「停止游戏 / 后台继续运行 / 取消」；停止调用 `game_stop`，后台继续调用 `game_set_background(enabled=true)`，确认后才写新壁纸。

### 15.2 校验规则（`game_package::manifest`）

- `schemaVersion === 1`、`type === "game"`、`id` 格式合法且与目录名一致（用户安装/官方目录）。
- `version` 语义化版本；`license` 必填；`capabilities` 非空、白名单内、去重。
- `entry.authority` 必填；`entry.replica` 可选；两者都必须是相对、`..` 之外的 `.html`。
- `hostApi` 必须是正整数且 ≤ 当前 `GAME_HOST_API`。
- `engine.id` 为开放字符串（缺省 `custom`，非空、≤64 字符）；`engine.renderMode ∈ {canvas2d, webgl, webgpu, dom, custom}`，缺省 `canvas2d`。
- `runtime.authority ∈ {host-tick, self-loop}`；P3 起两者都接受，self-loop 仍为 experimental（默认仍推荐 host-tick）。未知值在 manifest 校验阶段被拒绝。
- `runtime.maxReplicas` 1–16；`runtime.tickMs` 200–60000；`runtime.commit.flushMs` 250–10000。
- `display.policy` 只接受 `shared`；`display.modes ⊆ {mirror, span}`。
- `commands` 必填（可为空对象，表示该游戏不接受操作）；`events` 可选。两者的类型键合法（`^[a-z][a-z0-9._-]{0,63}$`）且不重复。
- `state.schemaVersion` 正整数；`state.maxSizeBytes` ≤ 8 MiB。
- `network` 只允许 `https://` / `wss://` 源；只有授权 `game.network` 后才进 CSP。
- 未知字段一律拒绝（沿用 scene manifest 的严格策略）。

### 15.3 授权账本

```text
%APPDATA%\app.lull.desktop\games\.grants.json
{
  "version": 1,
  "games": {
    "community.living-world": {
      "enabled": true,
      "granted": ["game.state.read", "game.state.write", "game.command.receive", "game.event.publish", "game.event.read", "game.render.publish"],
      "manifestHash": "…",
      "updatedAt": 1760000000000
    }
  }
}
```

- 声明（manifest）与授权（账本）分离；运行期以账本为准。
- 清单指纹漂移（用户手动改包）→ 阻止加载或要求重新授权（与 widget 的"清单漂移复核"一致）。
- 授权在运行中变更：**critical 能力被撤销时停止实例**（`failed`，`permission.revoked`），设置页提示重启；新增授权在下次启动生效。
- `game.network` 是能力 + 清单网络源的组合；两者缺一不可。

### 15.4 启停与扩展中心

- 安装/卸载/启用/授权复用 `extensions_*` 命令：`extensions_list` 返回 `kind: "game"` 的条目；`extensions_set_enabled` / `extensions_set_capability` 对游戏生效。
- `extensions_open(kind=game)` 语义 = `game_start`；`extensions_stop` = `game_stop`；`extensions_close` = 无操作（游戏没有可隐藏的宿主窗口）。设置页同时提供直达按钮。
- 安装/卸载/更新前若实例在运行：先停止；停止失败则拒绝操作并保留现场。
- 更新同 id 包：先停止，替换目录，旧存档保留；`state.schemaVersion` 不匹配时新包拒绝加载该存档（由用户在设置页选择保留/删除），**不做自动迁移**。

### 15.5 `lullgame://` 资源协议与 CSP

- 协议与 `lullwidget://` / `lullcontent://` 同构：`<id>/<path>`、`safe_join` 根校验、拒绝 `..`/反斜杠/点号路径、`Access-Control-Allow-Origin: *`、`Cache-Control: no-store`、HTML 注入 nonce。
- Windows 实际源为 `http://lullgame.localhost`。
- 逐包 CSP（仅授权后放开网络）：

```text
default-src {origin};
script-src {origin} 'nonce-…' 'wasm-unsafe-eval';
style-src {origin} 'unsafe-inline';
img-src {origin} data: blob: {network};
media-src {origin} data: blob: {network};
font-src {origin} data: {network};
connect-src {origin} {network};
worker-src {origin} blob:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

- `wasm-unsafe-eval` 允许 WebAssembly 编译（部分引擎需要），不授予任何宿主能力。
- 未授权 `game.network` 时 `{network}` 为空；授权后只放入清单声明的源。

### 15.6 开发模式

- P1 起：`extensions.json` 的开发包记录增加 `kind`（`widget` 默认 / `game`），挂载目录按 `game.json` 识别；`.lull-dev.json` 的 dev server 对 authority/replica 入口同样生效（仅 debug 构建）。
- 开发包跳过摘要锁与签名，但**不跳过**清单校验、能力授权与沙箱。
- 关闭开发模式只销毁权威窗与挂载记录，不删除目录与授权账本。

### 15.7 版本兼容

- 不支持的 `schemaVersion` / `hostApi` / `protocol` 明确拒绝，错误进设置页。
- 新增可选字段不算破坏性变更；未知字段在清单层仍严格拒绝（避免拼写错误静默生效）。
- 引擎版本只做展示与开发者自检；宿主不做引擎版本解析。

## 16. 安全与隔离

### 16.1 信任边界

| 组件 | 信任级 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| 设置页 / 扩展中心 | 宿主同信任 | 全部管理命令 | — |
| Authority 宿主壳（顶层帧） | 宿主代码 | 调 `game_*`、转发消息、持有 token | 不解释业务、不落盘 |
| 游戏 authority iframe | 不可信 | 只能 postMessage | 直接 IPC / 文件 / 窗口 |
| 壁纸宿主页（顶层帧） | 宿主代码 | 调只读 `game_*`、转发 | 不暴露 token 给 iframe |
| 场景 iframe（游戏 replica） | 不可信 | 渲染、postMessage | 提交、发命令、读宿主 |
| Controller iframe（包内 / 外部 Widget） | 不可信 | 读状态、发命令 | 写状态、管理实例、删存档 |
| 游戏包资源 | 不可信静态文件 | 被 `lullgame://` 只读服务 | 访问宿主文件系统 |

### 16.2 威胁与缓解

| 威胁 | 缓解 |
| --- | --- |
| 游戏伪造 authority 身份提交 | 身份由窗口 label 判定；token 只在权威壳注入；提交校验 epoch/lease/revision |
| 旧 authority 残留覆盖新状态 | epoch 单调递增；旧租约立即失效；旧提交返回 `authority.epoch_mismatch` |
| Replica 偷偷写状态 | 壁纸窗 ACL 无提交命令；角色判定拒绝；场景桥无写接口 |
| Widget 越权 | 能力账本 + Rust 二次校验；不暴露 `game.state.write` |
| 游戏读宿主文件 | 不透明源 iframe + 资源协议根校验；无 FS 命令 |
| 游戏直连外网 | 清单声明 + `game.network` 授权 + 逐包 CSP；未授权时 connect-src 只有包自身 |
| 游戏无限提交拖垮宿主 | 大小/条数/速率配额；超限拒绝并记账 |
| 恶意路径穿越 | `safe_join` + 拒绝点号路径（复用 `resource.rs`） |
| 无限重试打爆 CPU | failover 重试上限 2 次；命令/错误/心跳全部限流 |
| 存档被写坏 | 原子替换 + 备份 + 损坏即 `failed` 不猜回退 |

### 16.3 Token 模型（必须写清的边界）

- `authorityToken`：只在 authority 宿主壳的 `__LULL_GAME_AUTHORITY__` 里；游戏 iframe 读不到父页面（不透明源）。
- `gameToken`：只在壁纸窗顶层帧；与 `__LULL_MEDIA_TOKEN__` 相同注入模式。
- Widget 桥 token：**游戏 iframe 本来就能拿到**（Widget SDK 需要它发请求），因此它只用于"请求属于哪个窗口"，不是权限边界；Widget 的权限边界是 Rust 侧能力账本。
- **已知限制**：WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍可能看到 `__TAURI_INTERNALS__`。因此"游戏调不到 IPC"不是安全保证；真正的边界是窗口 ACL + 顶层帧 token + 宿主二次校验。禁止在文档或 UI 里宣称"第三方代码完全无法访问 Tauri"。

### 16.4 配额汇总

| 项 | 默认 | 可调 |
| --- | --- | --- |
| 同时运行实例 | 3 | `games.json.maxRunning`（1–3） |
| 每实例 replica | 8 | manifest `maxReplicas`（1–16） |
| 提交 state | 1 MiB | manifest 可收紧，硬上限 8 MiB |
| 单事件 / 单次事件数 | 16 KiB / 32 | 常量 |
| 渲染态 | 64 KiB | 常量 |
| 命令 payload | 32 KiB | 常量 |
| 命令速率（每 Widget） | 8/s burst 16 | 常量 |
| 提交速率 | 见 §9.5 | 常量 |
| 错误上报 | 1/s burst 5 | 常量 |
| 包体积 | 16 MiB/文件、128 MiB/包、1024 文件 | 常量 |

### 16.5 日志与诊断

- 通用日志写入 `%TEMP%\lull\app.log`；实现时把 `wallpaper::ffi::wlog` 提升为 `src-tauri/src/log.rs::app_log`，`game` 不反向依赖 `wallpaper`。
- 日志只记录 ids、revision、错误码与耗时，**不记录 state 内容、token、命令 payload 明文**。
- 实例错误同时写入 `metadata.lastError`（`code/message/at`），设置页展示最近一次。

## 17. 前端宿主界面

### 17.1 设置页「游戏」页签

现有页签是 `preferences / extensions / about`（见 `src/app/(control)/setting/page.tsx`），新增 `games`：

- 列表：名称、版本、运行状态、revision、存档大小、最近更新时间。
- 操作：启动 / 停止 / 暂停 / 恢复 / 后台运行 / 回到前台 / 立即保存 / 清除数据（运行中，二次确认，停止 → 删除存档 → 重启） / 打开存档目录 / 删除存档（二次确认）。
- 授权：按能力勾选（`game.*`），与扩展中心的授权入口共用一套数据。
- 诊断：最近错误、authority epoch、replica 数量、包校验状态。
- 壁纸：包内有 `entry.replica` 的游戏提供「设为壁纸 / 取消游戏壁纸」，写入 `display.game`；同时同步覆盖每块屏的逐屏游戏（含其它模式留下的旧值），避免切回 independent 时旧游戏复活。壁纸页签选择场景会自动退出游戏壁纸；逐屏游戏与切换提示见 §15.1.1。
- 控制器：只在**运行中**实例的操作区显示每个控制器的开关（包内 / 扩展徽章 + 已连接状态）；未安装/未启用置灰，游戏未运行时不渲染控制器行。运行中同时显示已连接控制器数量。
- 偏好：`controllerFollowsGame` 开关（默认开）——显式启动游戏时自动打开 `autoOpen` 控制器；停止时回收该游戏全部控制器窗口。
- 空态：没有安装游戏时引导到扩展中心；没有运行实例时说明"启动后由壁纸场景或控制器接入"。
- 文案全部走 `i18n/messages/{zh-CN,en-US}.json`，键前缀 `games_*` / `settings_tab_games`；风格与现有设置卡片一致。

### 17.2 扩展中心

- 安装、预览、卸载、启用、能力授权复用现有面板；游戏条目显示引擎、显示策略、包体积与存档提示。
- 运行状态只在游戏详情显示"运行中/未运行"，启停走 `game_start` / `game_stop`。
- 卸载对话框明确区分"保留存档（默认）/ 同时删除存档"。

### 17.3 壁纸窗内的 Replica 宿主

- `src/scenes/host.tsx` 仍是场景选择者；`ScriptedScene` 内部挂 `useGameReplica`（`src/games/bridge/scene-game-bridge.ts`）。
- 只有 `entry.manifest.game` 存在、且桌面窗口环境（`isDesktopWindow()`）时才建立游戏连接；浏览器预览不连接。
- 连接失败/实例未运行时静默回退普通场景渲染（可 console.warn），不打断壁纸。

### 17.4 Authority 宿主壳

- 路由 `/game-authority`，页面只做：读 `__LULL_GAME_AUTHORITY__`、渲染隐藏 iframe、转发消息、上报 ready/错误。
- 顶栏/菜单不渲染（窗口不可见）；不引入任何业务逻辑。
- 与 `src/components/widget-plugin-shell.tsx` 共享"init / request / response / ready"的桥样式，但**不复用其窗口 UI 与媒体逻辑**。

### 17.5 i18n 与可用性

- 新增文案键：`settings_tab_games`、`games_empty`、`games_start`、`games_stop`、`games_save_now`、`games_delete_save`、`games_status_running`、`games_error_*` 等；中英同步。
- 错误码到文案的映射集中在一个 `gamesErrorText(code)` 函数，未映射的 code 展示原文并附错误码。
- 所有危险操作（删存档、撤销 critical 授权）必须二次确认。

## 18. 构建、测试与 CI

### 18.1 脚本与命令（P1 起）

| 脚本 | 内容 |
| --- | --- |
| `pnpm game:sdk` | `tsc -p packages/game-sdk/tsconfig.json` |
| `pnpm game:sdk:check` | `tsc -p packages/game-sdk/tsconfig.check.json` |
| `pnpm games:check`（P1 后期） | 校验 `game.json`、能力白名单、命令表与 capability 生成同步 |
| `pnpm check` | 追加 `game:sdk:check` 与 `games:check` |

### 18.2 接线清单（P1 已落地）

1. `src-tauri/src/lib.rs`：声明模块、注册 `lullgame://` 协议、注册 `game_*`/`games_*` 命令、`WindowEvent::Destroyed` 调 `game::on_window_destroyed`、`RunEvent::Exit` 调 `game::shutdown`。
2. `src-tauri/build.rs`：`APP_COMMANDS` 增加全部游戏命令；`CAPABILITIES` 增加三个 Widget 游戏能力；窗口清单生成逻辑读取新增的 authority 能力文件。`src-tauri/src/widget_package/manifest.rs` 的 `PLUGIN_CAPABILITIES` 也要加同一批能力。
3. `scripts/gen-widgets.mjs`：生成 `window-game-authority.json`；`window-wallpaper.json` / `window-widgets.json` / `window-settings.json` 权限扩列；命令表校验自动覆盖新命令。
4. `src-tauri/capabilities/`：新增 `window-game-authority.json`，其余三份重新生成。
5. `src-tauri/src/extension/{mod,install}.rs`：`Kind::Game`、`MANIFESTS` 增 `game.json`、安装/卸载/启停/授权分支、体积预算参数化。
6. `src-tauri/src/content_trust/verify.rs`：`PackageKind::Game`。
7. `tsconfig.json`：`@lull/game-sdk*` 路径；`package.json`：`game:sdk*` 脚本。
8. `src-tauri/src/webview.rs`：一般不改；若 P3 验证发现需要额外参数，先做实验再统一改，**不允许只给权威窗单独参数**（WebView2 environment options 必须一致）。
9. `src-tauri/src/wallpaper/windows.rs`：创建壁纸窗时追加 `__LULL_GAME_TOKEN__`（顶层帧）。
10. `src/app/(games)/game-authority/page.tsx` 与 `src/games/**`、`src/hooks/use-games.ts`、设置页页签。
11. 实现时同步更新 `docs/widget-sdk.md` 的能力表与 `docs/scene-sdk.md` 的场景清单字段（本文只给设计，不代替这两份开发者文档的维护）。

### 18.3 Rust 测试（纯逻辑，不上 WebView）

| 模块 | 用例 |
| --- | --- |
| `game_package::manifest` | 合法/非法字段、未知字段、entry 安全、capability 白名单、display/authority 模式拒绝、版本拒绝、network 源校验 |
| `game::lease` | 签发、续租、过期、token 校验、owner 判定、epoch 单调 |
| `game::state` | revision 递增、baseRevision 冲突、大小/事件数/速率限制、simulationTime 单调、旧 epoch 拒绝 |
| `game::command` | 类型未声明、payload 超限、requestId 去重、超时、expectedRevision |
| `game::repository` | 原子写、备份滚动、损坏回退到备份、metadata 重建、schemaVersion 不匹配、不可写失败 |
| `game::replica` | attach 上限、同 label 重入、detach 不影响实例、几何映射、未运行返回空 |
| `game::permissions` | 角色矩阵（authority/replica/controller/manager × 命令）、token 缺失/错误 |
| `game::lifecycle` | start→ready→stop 顺序、保存失败不置 stopped、failover 递增 epoch、重试上限 |
| `game::snapshot` | 合并节流、订阅过滤、窗口销毁清理 |

### 18.4 前端测试（Vitest）

| 范围 | 用例 |
| --- | --- |
| `packages/game-sdk` | 协议校验、握手超时、revision 断档触发 requestSnapshot、角色越权调用被拒、destroy 语义、内存 transport |
| `src/games/bridge` | 仅 scene 绑定发送 game.*、几何映射 mirror/span、initial snapshot 缓存、旧场景协议不误发 |
| `src/games/authority` | 请求路由权限矩阵、token 不外泄、ready 流程、错误上抛 |
| Widget 桥 | `game.*` 能力门控、未知方法、事件转发、断线处理 |
| 设置页 `games-panel` | 空态、运行态、启动/停止/删除确认、错误映射、i18n |
| 契约 | `src/games/protocol.ts` 与 `packages/game-sdk/src/protocol.ts` 的同构测试（同一组 fixtures 双向校验） |

### 18.5 真机验收（发布门槛）

1. 双屏/三屏 mirror 与 span 下同一游戏状态一致，滚动/缩放不错位。
2. 壁纸窗口重建（切换场景、拓扑变化）不重启实例、不丢状态。
3. 显示器插拔、壁纸总开关切换后 replica 重新加入并恢复一致。
4. 强杀 authority 进程/窗口后恢复到最后落盘 revision，旧窗口无法再提交。
5. 隐藏 authority 窗连续运行 2 小时，host-tick 无漂移、内存无泄漏、WebGL（P3）上下文不丢。
6. 断网/未授权网络时游戏资源与连接被 CSP 阻止，宿主功能不受影响。
7. 安装恶意构造的包（路径穿越、超大文件、摘要不匹配、未知字段）全部被拒绝且不落盘。

## 19. 实施阶段

### P1 · Game Host 与 Host-authoritative（RFC Phase 1）

**目标**：单实例、单权威、无 replica 的闭环；设置页可启动/停止；控制器窗口可读状态、发命令；存档可恢复。

**改动**：`game_package` 全套；`game` 的 manager/instance/authority/lease/state/repository/command/event/snapshot/permissions/lifecycle/error；`lullgame://`；`game-authority` 路由与壳；16 条命令与 8 个事件；`@lull/game-sdk`（authority + controller + testing）；设置页 games 页签与 i18n；Extension Center `Kind::Game`；`examples/games/living-world`（authority + 包内控制器）；Rust/前端测试；`gen-widgets.mjs` / `build.rs` / `lib.rs` / `tsconfig` / `package.json` 接线。

**退出标准**：RFC §16 Phase 1 五条验收全过；`game_state_commit` 的 epoch/lease/revision 拒绝用例齐全；重复 requestId 不重复执行；两个控制器看到同一份状态；停止后重启恢复到同一 revision 的存档。

**P1 实现状态**：已落地 `game_package`（清单/摘要/授权/`lullgame://`）、`game` 运行时（实例、租约、提交、仓储、命令、ticker、隐藏权威窗、failover）、17 条 Tauri 命令、设置页「游戏」页签、`@lull/game-sdk`（authority + widget + testing）、Widget 游戏桥与 `examples/games/living-world`（零构建 authority 示例）。

P1 明确**未覆盖**、留给后续阶段：

- Render Replica 与 Scene 绑定（P2）：`game_connect` 的 replica 分支已就绪，但壁纸窗尚未接入 `game.*` 场景桥；`@lull/game-sdk` 当前没有 `./scene` 入口。
- 暂停 / hidden / background 状态机（P2/P3）：暂停/恢复、hidden 自动停 tick 与 `game_set_background` 后台降频均已开放。
- `self-loop` 权威、崩溃检测硬化、journal（P3）：**self-loop 已放行**（提交限流 4 次/秒），租约过期的 failover、稳定 60s 后重试计数复位、`resumeOnLaunch`、提交 journal 与稳定性工具链已落地；见 [稳定性报告](./game-runtime-webview-stability.md)（真机长跑待执行，暂不转正）。
- `entry.replica` 独立副本与 Phaser/PixiJS/Three.js Adapter（P4）：包内 replica 入口、`GameReplicaHost`、壁纸内容源选择与四类适配器均已落地；缺引擎矩阵真机验收（见 P4 状态）。
- 游戏开发挂载（dev mode）、官方游戏、在线目录与签名 UI（P5）。
- 扩展中心的游戏详情/逐能力开关 UI：命令已支持 `kind="game"`，设置页当前只提供整体启用/停用。

> 控制器产品链路（声明、设置页/托盘入口、目标注入、自动跟随）已在 P2 补齐，见 §14.2.1 与 P2 实现状态。

### P2 · 多屏 Render Replica（RFC Phase 2）

**目标**：一个游戏世界、多屏独立渲染；场景绑定；重建/热插拔不丢状态。

**改动**：`game::replica`、`game:snapshot/event/render/lifecycle` 投递、`game_connect` 渲染上下文、`game_package` 的 scene 绑定校验；`src/sdk/scene/manifest.ts` 增加 `game` 字段与校验并把 `SCENE_HOST_API` 升到 2；`scene-bridge.ts` 追加 `game.*`、`external-scene.tsx` 挂 `useGameReplica`；`@lull/game-sdk/scene`；`examples/scenes/living-world`、`examples/games/living-world/controllers/panel`；暂停/恢复（`game_suspend` / `game_resume`）与 hidden 自动停 tick；`games.json`（autoStart / maxRunning / offlineMaxMs）与 `game_auto_start` 自动启动、设置页偏好。

**退出标准**：RFC §16 Phase 2 四条验收全过；双屏 mirror/span 目视一致；任意一屏重建不影响实例；新 replica 加入后快照恢复一致；`independent` 壁纸模式下世界仍共享（有测试/文档说明）。

**P2 实现状态**：场景绑定、`game_connect` replica、快照/事件/渲染态/生命周期转发、`useGameReplica`（含场景尺寸/DPI 变化重新 attach、实例停止后低频重试）、`@lull/game-sdk/scene`、`examples/scenes/living-world`、`examples/games/living-world/controllers/panel`、`games.json`（autoStart / maxRunning / offlineMaxMs）与随壁纸自动启动、暂停/恢复与 hidden 自动停 tick 已落地。**控制器已升级为多窗口 + 包内 UI**：`game.json.controllers[]`（1–8 个，`entry` 或 `widgetId` 二选一）、`GameView.controllers[]`、设置页运行中操作区的开关、托盘「设置 ▸ 游戏控制器」列出全部运行中游戏（壁纸激活的游戏排前）、`game_open_controller` / `game_close_controller`、`game_controller_request`（游戏侧）、`@lull/game-sdk/controller` 与 `/game-controller` 宿主壳；激活门禁统一为 `InstanceStatus::accepts_controller()`，停止/失败回收该游戏全部控制器窗口。示例见 `examples/games/{living-world,phaser-demo,pixi-demo,three-demo}/controllers/`（全部为包内页面，示例不再使用控制器 Widget）。尚未覆盖：多显示器真机目视验收。

### P3 · Engine-authoritative（RFC Phase 3）

**目标**：支持 `self-loop` 权威；崩溃检测与恢复硬化；后台策略。

**改动**：`runtime.authority = "self-loop"` 放行；心跳/超时/窗口销毁/错误上报的 failover 全链路；重试与降级；`journal/`（可选，逐提交追加、滚动裁剪）；隐藏 WebView2 稳定性测试与参数实验记录；系统休眠/锁屏的降频评估；`games.json.resumeOnLaunch`。

**P3 实现状态**：`self-loop` authority 已放行（ticker 不驱动、提交限流 4 次/秒、`onTick` 不触发）；租约过期先尝试 epoch+1 重建权威，重试预算用尽才失败；稳定运行 60s 后重置重试计数；`games.json.resumeOnLaunch` 已落地（启动 1.5s 后在后台线程逐个恢复上次活动实例，单个失败不影响其余）；提交 journal（NDJSON，只记 revision/epoch/事件类型，512KB/256 行滚动裁剪）已落地；`game_set_background` 后台策略（tickMs×4）已落地；稳定性工具链（`game_runtime_diagnostics`、`@lull/game-sdk/diagnostics`、`scripts/game-stability-report.mjs`、`examples/games/stability-probe`）已就绪；self-loop 默认使用 **1×1 visible 权威窗**（`LULL_GAME_AUTHORITY_HIDDEN=1` 可回到隐藏对照组）。**真机 2h 长跑与多屏目视验收未执行，`self-loop` 保持 experimental**，详见 [隐藏 WebView2 / WebGL 稳定性报告](./game-runtime-webview-stability.md)。

**退出标准**：RFC §16 Phase 3 四条验收全过；形成《隐藏 WebView2/WebGL 稳定性报告》（节流、GPU、上下文丢失、异常恢复四类），不达标则保持 `self-loop` 为 experimental 并默认关闭。

### P4 · 第三方引擎 Adapter（RFC Phase 4）

**目标**：游戏自带 `entry.replica` 的独立副本路径；Canvas2D → Phaser → PixiJS → Three.js 适配器。

**改动**：`src/games/replica/game-replica-host.tsx`、`entry.replica` 校验与服务、`@lull/game-adapter-canvas`、`-phaser`、`-pixi`、`-three`；示例 `examples/games/{canvas-demo,phaser-demo,pixi-demo,three-demo}`；安装体积预算复核（引擎包）。

**退出标准**：RFC §16 Phase 4 四条验收全过；宿主 `cargo tree` 不出现任何引擎依赖；同一游戏包不同入口（authority/replica）可分别使用；引擎生命周期与 LULL 生命周期对齐。

**P4 实现状态**：四个适配器全部落地，都是**零运行时依赖**（结构化类型接收引擎实例，宿主与 `cargo tree` 均不受影响）：

- `@lull/game-adapter-canvas`：dpr/backing store、rAF 节流、暂停/恢复、快照/渲染态（4 项单测 + 与 `LullGameRenderClient` 的编译期契约测试）。
- `@lull/game-adapter-phaser`：`render.viewport` → `scale.resize`，`suspended/stopped/failed` → `game.loop.sleep()`，`destroy` → `game.destroy(true)`（5 项单测）。
- `@lull/game-adapter-pixi`：`Application.init/resize`（`resolution = dpr`）→ ticker 停/起，`destroy` → `app.destroy()`（5 项单测）。
- `@lull/game-adapter-three`：自驱 rAF 并按 `maxFps` 节流、`setPixelRatio(dpr)` + `setSize(w,h,false)`、`destroy` → `renderer.dispose()`，渲染连续抛错时停帧（6 项单测）。

**单包双入口已打通**：`GameView.entryReplicaUrl` / `game_replica_entry`、`GameReplicaHost`（不依赖 Scene）、`display.game` + `wallpaper_set_game` + 壁纸 hash `game=`、游戏包 16/128 MiB/1024 预算、`examples/games/stability-probe` 指标墙迁入 `replica/`；`examples/games/living-world` 1.1.3 也补齐 authority + replica，并修复首份空快照导致 tick 崩溃的问题。

**新增三个引擎示例包**（每个都是"一个 zip = 逻辑 + 渲染"）：`examples/games/{phaser,pixi,three}-demo`，共用同一份 host-tick authority，replica 分别用 Phaser 3.90 / PixiJS 8.22 / Three.js r186 渲染；打包后分别为 1.2 MiB / 568 KiB / 537 KiB，远低于 16 MiB 单文件预算。构建走 `build.mjs` + esbuild（`write: false` 后由 Node 落盘），产物只有 `replica/main.js`，源码目录不留构建垃圾。

**真机冒烟（双屏 mirror）**：两块显示器同时「设为壁纸」后，三个示例各挂 2 个 replica，共享同一 authority revision（host-tick 每秒提交，`replicas: 2`、`lastTickAgeMs < 1s`），Phaser / PixiJS / Three.js 画面均正常，两屏构图一致；截图留在本地 `artifacts/engine-demos/`（gitignored）。

尚未完成：Phaser v4 / WebGPU 渲染路径的矩阵验收；`examples/games/canvas-demo` 仍无独立示例（仅单测与契约测试覆盖）；引擎包在 8 副本 × 多屏下的压测未执行；上述冒烟不替代 T3/T4 的正式验收。

### P5 · 社区游戏生态（RFC Phase 5）

**目标**：安装/卸载/校验/授权/目录/模板/存档迁移的完整链路。

**改动**：在线/离线目录（可选）、摘要与签名 UI、开发者模板、示例项目、存档迁移 hook（`state.migrations`）、官方游戏包、托盘"当前游戏"评估。

**P5 打包基础设施（已提前落地）**：`scripts/build-game-examples.mjs`、`scripts/pack-game.mjs`、`scripts/install-game-examples.mjs` 与 `scripts/lib/game-package.mjs`，生成 `.lull-game.zip` + `release/manifest.json`（sha256/包摘要/体积），并纳入 `pnpm check` 的 `games:samples:check`；CI 见 `.github/workflows/game-examples.yml`。详见 [`examples/games/README.md`](../examples/games/README.md)。

**退出标准**：RFC §16 Phase 5 验收；第三方开发者只依赖 `@lull/game-sdk` 即可从零跑通示例；迁移失败可回滚且不丢存档。

## 20. 验收标准

### 20.1 RFC §18 对照

| 类别 | RFC 验收标准 | 本设计的落点 | 验证方式 |
| --- | --- | --- | --- |
| Authority | 一个 Instance 同时只能有一个有效 Lease | §6.2、`game::lease` | Rust 单测 |
| 状态写入 | 只有当前 Authority 可以提交 | §6.3、§16.3 | 单测 + ACL 审查 |
| Epoch | 旧 Authority 的提交被拒绝 | §6.4 | 单测 |
| Revision | 状态版本严格递增 | §6.5 | 单测 |
| 幂等 | 重复 requestId 不重复执行 | §9.5、§10.2 | 单测 + 前端集成 |
| Replica | 多显示器只消费同一权威状态 | §12 | 真机验收 + 前端测试 |
| 重建 | 壁纸 WebView 重建不重启实例 | §12.5 | 真机验收 |
| 热插拔 | 显示器增删不丢游戏状态 | §12.5 | 真机验收 |
| 恢复 | Authority 崩溃后从最后成功提交恢复 | §6.6、§7.5 | Rust 集成（临时目录 + 假时钟） |
| Widget | 多个 Widget 可连接同一实例 | §14 | 前端测试 + 真机 |
| Scene | Scene 不具备游戏状态写入权限 | §13.4 | 类型层 + 运行时 + ACL |
| 引擎 | 不同引擎通过统一 Game SDK 接入 | §5.3、P4 | P4 验收 |
| 安全 | 第三方代码不能直接调用 Tauri IPC | §16 | ACL 审查 + 真机安全清单 |
| 兼容 | 不支持的 manifest/protocol 版本明确拒绝 | §15.2、§9.1 | 单测 |

### 20.2 项目补充验收

1. 启动两个以上不同游戏（≤3）互不影响；第 4 个返回 `game.instance_limit`。
2. 游戏包卸载默认保留存档；勾选删除后目录确实消失且不可恢复（有确认与测试）。
3. 存档目录不可写时启动失败且不产生半运行实例。
4. 设置页能准确展示 `failed`、`interrupted`、`running` 三种状态与对应操作。
5. 网络未授权的游戏任何外连都被 CSP 拦截，控制台有可诊断错误。
6. 关闭/重启应用后，未运行的实例存档可被再次启动并恢复到同一 revision。
7. 全部错误码都有前端文案或兜底展示，不出现空白错误。

## 21. 风险与待验证项

| # | 风险 | 影响 | 缓解 / 验证 | 阶段 |
| --- | --- | --- | --- | --- |
| R1 | 隐藏 WebView2 的后台节流、GPU 回收、WebGL 上下文丢失 | Authority 不推进/画面丢失 | host-tick 由 Rust 驱动；全局 browser args 已关闭节流；P3 专项稳定性测试与 [稳定性报告](./game-runtime-webview-stability.md)；必要时做"离屏可见 1×1"对照实验 | P3 |
| R2 | 提交频率与磁盘寿命 | 写放大、卡顿 | 合并落盘 1–2s + 停止/退出强制 flush；备份滚动 3 份 | P1 |
| R3 | 快照 JSON 序列化与多副本投递成本 | 大状态多屏卡顿 | 快照合并节流；大小硬上限；P2 真机压测（1 MiB × 8 replica） | P2 |
| R4 | 游戏逻辑不可判定"确定性" | host-tick 下不同步/漂移 | 文档约定：模拟只读宿主 tick 与预置随机源；SDK 提供 seeded RNG；不承诺跨平台逐位一致 | P1 |
| R5 | 崩溃检测只有心跳与窗口销毁 | 渲染进程卡死不退出时恢复慢 | TTL 10s 内触发；错误上报辅助；P3 评估 WebView2 崩溃事件 | P3 |
| R6 | 存档 schema 迁移 | 升级后旧档打不开 | P5 做迁移 hook；P1–P4 明确拒绝并保留文件 | P5 |
| R7 | 包体积/安装预算与引擎体积冲突 | 安装失败 | 游戏单独预算 16/128 MiB/1024 已落地；引擎包超出时再按实测调参 | P4 |
| R8 | WebView2 初始化脚本注入子帧 | 安全边界被误读 | 文档明确 token+ACL+宿主校验是边界；禁止"完全隔离"措辞 | 持续 |
| R9 | 多实例资源占用（≤3 个权威窗） | 内存/GPU 压力 | 默认上限 3；设置页显示占用；超限拒绝 | P1 |
| R10 | 场景绑定自动启动与用户预期冲突 | 意外耗电 | `autoStartWithWallpaper` 可关；设置页提示；hidden 策略降频 | P2 |
| R11 | Observer 重启/拓扑变化导致的窗口风暴 | 反复 attach/detach | attach 幂等、按 label 去重、节流；真机测试 | P2 |
| R12 | 第三方引擎 WebGL 在壁纸窗与权威窗表现不同 | 渲染差异 | replica 只做渲染、逻辑在权威；P4 覆盖四类引擎验收 | P4 |

**待验证项**（P3 前必须回答，写进专项报告）：

1. 隐藏窗口在 30 分钟/2 小时/8 小时后 `requestAnimationFrame`、`setInterval`、`AudioContext`、WebGL 的可观测行为。
2. 全局 browser args 对隐藏窗是否足够；是否需要 `--disable-gpu` 对照。
3. GPU 进程回收后 WebGL 上下文丢失事件（`webglcontextlost`）是否能恢复；恢复策略由 adapter 负责。
4. 多实例隐藏窗同时跑 WebGL 的显存上限与降级策略。

## 22. 明确不做

在 RFC §17 基础上补充本项目边界：

1. 只支持 Windows（与现有宿主一致；Win32 桌面挂载、WebView2 行为都是设计前提）。
2. 不自研游戏引擎，不提供渲染 API。
3. 不为每台显示器启动独立游戏逻辑（`per-monitor` 拒绝）。
4. 不做多 Authority 竞争、选主或迁移。
5. 不做网络联机、实时多人同步、云存档。
6. 不让游戏直接访问 Win32、创建窗口、操作 Widget 或读宿主文件。
7. 不把游戏状态塞进 Widget KV 或 `display.json`。
8. 不要求 WebGPU；不因 WebGPU 缺失拒绝游戏。
9. P1–P3 不做在线游戏目录、自动更新、第三方签名信任链扩展。
10. P1–P4 不做存档自动迁移。
11. 不做壁纸区域的指针/键盘输入：游戏操作只来自 Controller 与设置页（桌面图标层不可交互改造）。
12. 不做逐帧状态经 IPC 传输；渲染插值走 render state，逻辑帧走提交。
13. 不新增数据库；存档沿用 JSON + 原子写，与 Widget 状态存储风格一致。

## 附录 A：错误码

| code | 触发 | 展示建议 |
| --- | --- | --- |
| `game.package_not_found` | 包目录/清单缺失 | 重新安装 |
| `game.package_disabled` | 未启用 | 去扩展中心启用 |
| `game.manifest_invalid` | 清单校验失败 | 展示 detail |
| `game.unsupported_schema` | schemaVersion 不支持 | 升级 Lull |
| `game.unsupported_host_api` | hostApi 过高 | 升级 Lull |
| `game.unsupported_display_policy` | `per-monitor` | 说明首期只支持 shared |
| `game.unsupported_authority_mode` | 宿主尚不认识的 `runtime.authority` | 改用 `host-tick` / `self-loop`；未来 RFC 新模式的兼容错误 |
| `game.instance_not_found` | 实例不存在 | 刷新列表 |
| `game.instance_not_running` | 状态不允许 | 启动/等待就绪 |
| `game.instance_limit` | 运行数超限 | 先停止其它游戏 |
| `game.start_exists` | 同 id 已运行 | 幂等返回现状 |
| `game.state_incompatible` | `state.schemaVersion` 不匹配 | 说明需迁移/删除存档 |
| `authority.not_owner` | authorityId 不匹配 | 内部错误，记日志 |
| `authority.epoch_mismatch` | 旧 epoch 提交 | 内部错误，记日志 |
| `authority.lease_expired` | 租约过期 | 自动 failover |
| `authority.token_invalid` | token 错误/缺失 | 安全事件，记日志 |
| `authority.not_ready` | 启动 10s 未 ready | 重试/查看日志 |

#### `authority.not_ready` 排查

1. **CSP `frame-src` 必须允许 `http://lullgame.localhost lullgame:`**（`tauri.conf.json` 的 `csp` 与 `devCsp`）。漏掉时 iframe 被浏览器直接拦截，页面永远发不出 ready；`src-tauri/src/game/authority.rs` 有回归测试。改完 `tauri.conf.json` 必须重新构建/启动应用。
2. 用 `LULL_GAME_AUTHORITY_VISIBLE=1` 启动，观察隐藏窗口里的 Console：若可见时正常、隐藏时超时，是 WebView2 隐藏/节流问题，记入 P3 稳定性报告。
3. 直接打开 `http://lullgame.localhost/<gameId>/<entry.authority>`（或检查 `lullgame://` 服务）确认入口 200、`main.js` 无语法错误。
4. 确认游戏包 `entry.authority` 指向的文件确实存在，且 manifest `runtime.authority` 是 `host-tick` / `self-loop`。
5. `self-loop` 还会经过前端 `GameAuthorityContext` 校验：`mode` 必须是 `host-tick` 或 `self-loop`；校验失败时宿主壳不会创建 iframe，同样表现为 10s 超时。

| `state.revision_conflict` | baseRevision 不匹配 | 刷新后重试（游戏自行处理） |
| `state.too_large` | 提交超限 | 游戏自己压缩状态 |
| `state.invalid` | simulationTime 回退/超墙钟 | 游戏修正 |
| `state.commit_rate_limited` | 提交过快 | 游戏降频 |
| `event.too_large` | 事件超限 | 拆分事件 |
| `event.undeclared_type` | 未在 manifest.events 声明 | 补清单或改类型 |
| `command.unknown_type` | 未在 manifest.commands 声明 | 补清单 |
| `command.invalid_payload` | payload 非法/超限 | 检查参数 |
| `command.timeout` | 5–8s 未回结果 | 重试（注意幂等） |
| `command.rate_limited` | 命令过快 | 降频 |
| `command.duplicate` | requestId 冲突且结果不可复用 | 换 requestId |
| `game.command_not_allowed` | 命令不在该控制器 scope 内 | 清单 `commands` 放行 |
| `game.command_not_granted` | 游戏未声明/授权 `game.command.receive` | 补能力并重新启用 |
| `game.controller_not_declared` | 游戏没有声明该控制器 | 补 `controllers[]` |
| `game.controller_not_installed` | 载体不可用（Widget 未装 / entry 缺失） | 安装或修包 |
| `game.controller_disabled` | 载体未启用 | 扩展中心启用 |
| `game.controller_unknown` | 声明的控制器 id 不存在 | 检查 `controllerId` |
| `game.controller_not_active` | 游戏未运行 | 先启动游戏 |
| `game.controller_in_use` | 共享 Widget 正被另一游戏使用 | 先关闭另一游戏的控制器 |
| `game.controller_target_mismatch` | 页面传了与 binding 不同的 gameId | 不要传或传正确值 |
| `game.controller_not_targeted` | 手动打开且未指定目标游戏 | 从设置页/托盘打开 |
| `game.controller_read_only` | 只读控制器发送命令 | 清单 `commands` 放行 |
| `permission.denied` | 角色/能力不允许 | 提示授权或拒绝 |
| `permission.revoked` | 运行中授权被撤 | 重启游戏 |
| `protocol.unsupported` | 协议版本不支持 | 升级 |
| `replica.limit_reached` | 副本超限 | 减少启用显示器 |
| `replica.not_attached` | 未注册的 replica | 重新 attach |
| `io.error` | 读写失败 | 查看目录/磁盘 |
| `network.origin_denied` | 清单网络源非法 | 修清单 |

## 附录 B：命令与事件签名（宿主侧视角）

```ts
// ---- 管理（settings / 扩展中心）
games_list(): Promise<GameView[]>;
games_config_get(): Promise<GamesConfig>;
games_config_set(config: GamesConfig): Promise<GamesConfig>;
game_runtime_diagnostics(): Promise<GameRuntimeDiagnostics>;
game_start(gameId: string): Promise<GameInstanceView>;
game_stop(gameId: string): Promise<GameInstanceView>;
game_suspend(gameId: string): Promise<GameInstanceView>;
game_resume(gameId: string): Promise<GameInstanceView>;
game_set_background(gameId: string, enabled: boolean): Promise<GameInstanceView>;
game_flush(gameId: string): Promise<GameInstanceView>;
game_save_delete(gameId: string): Promise<void>;
// 壁纸窗专用（按 games.json.autoStartWithWallpaper）
game_auto_start(gameId: string): Promise<GameInstanceView | null>;
// 壁纸窗专用：包内自带渲染入口（不经过 Scene 目录）
game_replica_entry(gameId: string): Promise<GameReplicaEntry>;

// ---- 控制器窗口（设置页/托盘/Host 控制面）
game_open_controller(gameId: string, controllerId?: string): Promise<void>;
game_close_controller(gameId: string, controllerId?: string): Promise<void>;
// ---- 游戏侧（authority）：只能操作自己声明的控制器
game_controller_request(request: {
  controllerId: string;
  action: "open" | "close";
}): Promise<void>;

// ---- 参与者
game_connect(request?: {
  gameId?: string;
  sceneId?: string;
  render?: GameRenderContext;
}): Promise<GameConnectResult>;   // { context: GameContext | null; replicaId: string | null }
                                 // replica：实例未运行 → context=null（正常态）
                                 // controller：无 binding/未运行 → 抛 game.controller_* 错误

game_snapshot_get(): Promise<GameSnapshot | null>;
game_command_send(request: {
  requestId: string;
  type: string;
  payload: unknown;
  expectedRevision?: number;
}): Promise<GameCommandResult>;

game_state_commit(request: {
  authorityId: string;
  authorityEpoch: number;
  baseRevision: number;
  simulationTimeMs: number;
  state: unknown;
  events?: Array<{ type: string; payload: unknown }>;
  renderState?: unknown;
}): Promise<GameCommitResult>;    // { ok, revision, error? }

game_event_publish(events: Array<{ type: string; payload: unknown }>): Promise<{ accepted: number }>;
game_render_state_publish(request: { revision: number; state: unknown }): Promise<{ revision: number }>;
game_command_result(request: {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}): Promise<void>;
game_ready(): Promise<void>;
game_heartbeat(): Promise<{ expiresAt: number }>;
game_report_error(request: { scope: string; code: string; message: string }): Promise<void>;
game_detach(): Promise<void>;
```

事件：

```ts
// game:snapshot → GameSnapshot
// game:event → GameEvent
// game:render → GameRenderState
// game:lifecycle → { state: "started"|"stopped"|"suspended"|"resumed"|"authority-changed"|"failed";
//                    instanceId; gameId; authorityEpoch; revision; reason?; error? }
// game:command (authority) → { requestId; type; payload; expectedRevision: number | null }
// game:command-result (发起者) → { requestId; ok; result?; error?; revision? }
// game:tick (authority) → { simulationTimeMs; deltaMs; wallClockMs }
// games-changed → ()
```

## 附录 C：RFC 设计与偏差对照

| RFC | 本文 | 关系 |
| --- | --- | --- |
| §3.1 目标架构 | §3、§4、§5 | 保留分层；模块落到 `game/` + `game_package/`；Scene/Widget 桥方式细化 |
| §4.1 Game Instance 与显示器解耦 | §2、§7 | 一致 |
| §4.2 Authority 定义 | §6 | 一致（增加 host-tick/self-loop 二分） |
| §4.3 Host 裁决流程 | §4.3、§6.3 | 一致，补校验顺序与错误码 |
| §4.4 authorityEpoch | §6.4 | 一致，补持久化递增 |
| §4.5 Host-authoritative / Engine-authoritative | §7、§19 P1/P3 | **偏差**：两者统一为"权威执行环境 + 执行模式"；P1 用 host-tick（Rust 驱动 tick、Host 裁决持久化），P3 才开放 self-loop |
| §5.1-5.3 Replica 原则/Snapshot/Event/渲染态分离 | §11、§12 | 一致 |
| §5.4 显示模式 | §12.3、§12.4 | 一致；`per-monitor` 拒绝 |
| §5.5 span 坐标 | §12.3 | 复用 `SceneFrame`，不新增坐标体系 |
| §5.6 Replica 生命周期 | §12.5 | 一致；不新增窗口，寄生壁纸窗 |
| §6 第三方引擎接入 | §5.3、§15.1、§19 P4 | 一致；明确宿主不加载 adapter |
| §6.4 Game SDK API | 《Game SDK》§4、§5、§6、本文 §13/§14 | 增加 `onTick`；补角色矩阵与 Widget 入口 |
| §6.7 引擎能力声明 | §15.2 | 开放字符串；`renderMode` 枚举 |
| §7 Game Package 与 Manifest | §15、《Game SDK》§3 | 一致；路径与包预算落地到本仓库 |
| §7.4 Scene 与 Game 关联 | §13.1 | 一致；**偏差**：scene 必须声明 `wallpaper.script`，且 `game` 绑定属于场景宿主 API 2（P2 提升 `SCENE_HOST_API`） |
| §8 Game Protocol | §9、§10、附录 B | 一致；用显式命令替代单入口 |
| §9 存档与恢复 | §8 | **偏差**：存档根与包根分离；`journal/` 延后 P3 |
| §9.4 离线成长 | §7.6 | 一致 |
| §10 Scene SDK 扩展 | §13 | 一致；协议保持 v1、消息追加 |
| §11 Widget SDK 扩展 | §14 | 一致；新增 3 个 Widget 能力 |
| §12 安全与隔离 | §16 | 一致；补 token 边界与已知限制 |
| §12.3 能力表 | §14.1、§15.3、附录 A | **偏差**：`game.command.send` 归 Widget；新增 `game.render.publish`；宿主保留 5 项 |
| §13 内部模块建议 | §5.1 | 一致；拆成 `game` + `game_package` |
| §14 生命周期 | §7 | 一致；P1 只做启动/停止，pause/hidden 在 P2 |
| §15 版本兼容 | §9.1、§15.7 | 一致 |
| §16 实施阶段 | §19 | 一致；P1 范围略大（含安装/授权）以形成闭环 |
| §17 首期不做 | §22 | 一致；补充 13 条项目边界（Windows-only、无壁纸输入、无逐帧 IPC 等） |
| §18 验收标准 | §20 | 一致；补项目验收 |
| §19 架构决策 | §1 | 一致 |

**偏差汇总（需 RFC 后续修订时同步）**：D5（host-tick/self-loop 重定义）、D8（存档路径分离）、D11（scene 绑定要求 `wallpaper.script`）、D12（Widget 能力集合）、§13 模块拆分、P1 含安装/授权、卸载保留存档、包预算放宽。

---

**相关文档**：[架构与模块边界](./architecture.md) · [Scene SDK](./scene-sdk.md) · [Widget SDK](./widget-sdk.md) · [扩展中心](./extension-center.md) · [内容包格式](./content-format.md) · [Game SDK](./game-sdk.md) · [RFC](./rfc/RFC-Game-Runtime.md)
