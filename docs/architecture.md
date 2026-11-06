# Lull 架构与模块边界

> 状态：v0.1.0 重构基线。本文描述**当前代码实际边界**与下一步演进方向，不代表已经拆成多仓库。

## 1. 结论先行

Lull 采用 **模块化单体（Modular Monolith）+ 可版本化扩展协议**：

- 仍然是一个 Git 仓库、一个桌面应用、一套发布流程；
- 内部按 A/B/C/D 四层组织：Core / Extensions / Community / Services；
- 扩展边界：静态场景包持续开放；第三方 Widget 插件（静态包 + iframe 桥）作为 v1 Extensions 能力开放；工具窗口与原生能力仍由宿主代码创建/授权；
- 不提前拆 Rust crate 或多仓库，避免 Win32 宿主、IPC、配置在多个版本间来回同步。

## 2. 运行模型

```text
┌──────────────────────────────────────────────────────────────┐
│ lull.exe（Tauri / Rust）                                     │
│  ├─ 托盘 + 设置窗 + 音乐库 / 壁纸素材库 / 白噪音库窗口       │
│  ├─ wallpaper runtime：每屏一个无边框 WebView 窗口            │
│  └─ config：display.json（版本迁移 + 原子写盘）               │
│                                                              │
│  非主线程创建 WebView2 → 主线程只跑事件循环                   │
└───────────────┬──────────────────────────────────────────────┘
                │ C ABI（libloading）
┌───────────────▼──────────────────────────────────────────────┐
│ lull_native.dll（C++ / Win32）                                │
│  ├─ 显示器枚举、拓扑指纹、DPI                                 │
│  ├─ Progman / WorkerW 桌面层挂载、Z 序、尺寸修复              │
│  └─ 状态查询、显示/隐藏、DWM 视觉硬化、强制重绘               │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 窗口与进程

- 单进程、多窗口；所有窗口关闭都只隐藏，托盘「退出」才结束进程。
- 壁纸窗口 label 为 `wallpaper-<native-index>`，不进入任务栏、不参与窗口偏好。
- 内置库窗口 label 为 `settings` / `library` / `backdrop` / `noise-library`，每个窗口有独立的 capability 文件（`src-tauri/capabilities/window-<label>.json`，由清单生成）。`backdrop` 与 `noise-library` 沿用音乐库的 1080×760 / min 900×600 尺寸与标题 + 横向页签布局：`backdrop` 只承载「素材管理」（壁纸本身的设置在设置窗「壁纸」页签，因此没有页签导航），`noise-library` 为「噪音素材库 / 噪音预设 / 噪音测试」三页签；壁纸素材库不用 `wallpaper-*` 前缀，避免被壁纸渲染窗口的 capability glob 与媒体 token 前缀校验误识别。播放器与白噪音已迁为官方 Widget 包，窗口 label 分别为 `widget-player`、`widget-noise`；番茄钟已迁为 `examples/widgets/liquid-pomodoro` 普通扩展，窗口 label 为 `widget-pomodoro`。
- 第三方/官方插件窗口 label 为 `widget-<id>`：宿主壳页 `/embed` + `sandbox="allow-scripts"` iframe；`window.chrome` 为 `host` 时宿主绘制顶栏，为 `custom` 时插件自绘拖拽区/按钮（通过 `widget.chrome` 桥调用）。这类窗口共用 `window-widgets.json`（`widget-*` glob），只拿到自身状态命令与窗口操作，没有 `core:default`。
- 壁纸窗口只有一条**只读** capability 基础（`window-wallpaper`：`content_packages` +
  事件订阅 + 视频会话命令）：
  场景切换走 `location.hash`（不重载页面），壁纸窗必须自己解析场景 id，因此要读得到官方
  与用户内容包目录；
  媒体命令只够顶层页面打开/绑定视频会话，且必须带 Rust 注入的 per-window token；
  外部静态场景跑在 `sandbox=""` 的 iframe 里（不执行 JS）；
  声明 `wallpaper.script` 的外部/官方场景跑在 `sandbox="allow-scripts"` 的 opaque-origin
  iframe 里，只通过 `@lull/scene-sdk` 的 postMessage 桥读取参数/几何/相位，不能读取父页面
  媒体 token。

### 2.2 壁纸画面协议

Rust 通过 URL 哈希把画面参数传给 WebView：

```text
/#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=0,0,1920,1080&params=%7B%22mist%22%3A%220.5%22%7D
```

| 字段 | 含义 |
| --- | --- |
| `mode` | `mirror` / `independent` / `span` |
| `sync` | `1` 时按绝对时间对齐动画相位 |
| `scene` | 场景 id（内置媒体 `lull.video`、官方竹影 `lull.bamboo`、外部 `community.*`） |
| `canvas` | 跨屏共享画布（物理像素桌面坐标，可为负） |
| `view` | 当前窗口对应的桌面矩形 |
| `params` | JSON 后再 URI 编码的场景参数（字符串键值）；为空时省略 |

前端 `src/core/wallpaper/params.ts` 负责解析与几何换算，`src/scenes/frame.ts` 负责合成本地帧（默认参数、能力与兼容性），`src/scenes/host.tsx` 负责选择内置组件或外部 iframe；`src/scenes/external-scene.tsx` + `scene-bridge.ts` 把帧推给声明 `wallpaper.script` 的外部场景。协议是纯函数，Rust/前端都有回归测试。

## 3. 分层与依赖规则

| 层 | 目录 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| **Core** | `src/core/**`、`src-tauri/src/{config,media,wallpaper,window_host}` | 平台 API、纯工具 | 依赖 `scenes` / `widgets` / `app` |
| **Extensions** | `src/sdk/**`、`src/scenes/**`、`src/widgets/**`（含 `manifests/`）、`packages/{widget-sdk,scene-sdk}/**`、`examples/widgets/**`、`extensions/official/**`、`src-tauri/src/widget_package/**` | Core 的只读类型与窗口 label 协议；`sdk/widget/runtime` 可调用 `core/window` 宿主适配；`widget_package` 可调用 `window_host` | 直接调用 `app` 路由或宿主命令 |
| **Community** | `content/**`、`public/content/**`、`scripts/*-content.mjs`、`src-tauri/src/content_package/**` | 清单格式、静态 HTML/CSS、受限沙箱脚本、用户内容目录读写 | 修改核心 / 创建系统窗口 / 越权访问宿主 |
| **Extension Center** | `src-tauri/src/extension/**`、`src-tauri/src/package_hash.rs`、`src/components/extensions/**`、`src/lib/extensions.ts`、`src/hooks/use-extensions.ts` | `content_package` / `widget_package` 的校验与运行时；共享安装管线 | 拥有包格式 / 直接执行包内代码 |
| **Services** | 设计文档 | — | 成为本地运行前置依赖 |
| **App** | `src/app/**`、`src/components/**`、`src/hooks/**` | 以上全部 | 把业务规则塞回路由壳 |

落地约束：

- `src/sdk/**` 不 import `src/app/**` 或 `src/components/**`。
- `src/scenes/**` 只接收 `SceneProps`，不读配置文件、不调用 Tauri；当前只保留媒体场景。
- 官方壁纸/脚本场景在 `extensions/official/<id>/`，通过 Vite 构建为内容包，不进入 `src/`。
- `src/content/catalog.ts` 是内容加载服务，依赖 `sdk/scene`，不反向被 `core` 依赖。
- `window_host` 只暴露窗口 label 前缀 `DYNAMIC_WINDOW_PREFIX`；`widget_package` 依赖 Core，Core 不反向 import 插件模块。
- `src-tauri/src/lib.rs` 只做插件、命令与生命周期接线；新增能力先进对应模块。
- C++ 不依赖 React / Tauri / 内容包；Rust 不依赖 C++ 内部头文件。

### 3.1 前端模块图

```text
app/(wallpaper) ──► scenes/host ──► hooks/use-scene-catalog ──► content/catalog
       │                │                    │
       │                ├──► scenes/registry ─┴──► sdk/scene ──► core/wallpaper
       │                ├──► scenes/media-surface ──► core/media（会话/配置/asset URL）
       │                └──► scenes/external-scene ──► scene-bridge ──► postMessage（脚本场景）
       │
app/(control) ──► components/settings ──► widgets/registry ──► widgets/manifests/*.json
       │                └──► components/settings/media-panel ──► core/media
       │
app/(widgets) ──► components/library
                         │
                         ├──► sdk/widget/react ──► sdk/widget ──► core/window + hooks
                         │        （theme / fit / state）   （能力 / 状态 / chrome / 音频闸门）
                         └──► 纯模型

官方工具 ──► extensions/official/{player,noise} ──► @lull/widget-sdk + @lull/media-sdk
官方壁纸 ──► extensions/official/bamboo ──► @lull/scene-sdk（构建为 lull.bamboo 场景包）
示例包   ──► examples/widgets/liquid-pomodoro ──► @lull/widget-sdk + 全局 CSS

app/(widgets)/embed ──► components/widget-plugin-shell ──► iframe（sandbox）
                                 └──► postMessage 桥 ──► widget_state_*（Rust）
packages/widget-sdk ──► 插件侧客户端 + React/Vue 适配
packages/scene-sdk ──► 场景侧客户端（参数 / 几何 / 同步 / 可见性）
examples/widgets/* ──► 静态插件包样例（TypeScript 源码，esbuild 构建）
examples/scenes/* ──► 内容包样例（静态 CSS / Scene SDK 脚本场景）
```

### 3.2 Rust 模块图

```text
lib.rs
 ├─ tray.rs ───────────────► window_host + widget_package + extension（设置子菜单含各内置窗口 / 游戏控制器 / 除游戏外的扩展）
 ├─ window_host
 │    ├─ mod.rs（窗口工厂 / 上下文注入 / IPC）
 │    ├─ spec.rs（WidgetSpec 结构 + 查询；静态描述由 build.rs 生成）
 │    └─ prefs.rs（全局窗口偏好）
 ├─ content_package
 │    ├─ mod.rs（命令 + content-changed 事件）
 │    ├─ manifest.rs（catalog.json 校验：单场景 / id / entry / license）
 │    ├─ digest.rs（整包 sha256，与 content-digest.mjs 逐字节一致）
 │    ├─ store.rs（官方随包场景 + 用户内容扫描 / zip 安装 / 卸载 / 官方优先解析）
 │    └─ protocol.rs（lullcontent:// 资源协议）
 ├─ resource.rs（safe_join + MIME，插件与内容包共用）
 ├─ package_hash.rs（两类包共用的文件遍历 + 摘要拼装）
 ├─ extension
 │    ├─ mod.rs（门面：列表 / 预览 / 安装 / 卸载 / 启停 / 权限 / Slot 命令）
 │    ├─ install.rs（共享 staging / zip / 预算 / 原子落地）
 │    ├─ dev.rs（开发模式配置 / 本地目录挂载）
 │    ├─ error.rs（稳定错误码）
 │    └─ slots（功能槽位：defs 静态定义 / selection `.slots.json` / mod 选择与运行事务）
 ├─ widget_package
 │    ├─ mod.rs（插件窗口 / 命令 / 上下文）
 │    ├─ manifest.rs（widget.json v2 校验 + provides）
 │    ├─ digest.rs（旁路 .lull-integrity.json + 整包摘要）
 │    ├─ store.rs（包发现 / 授权记录 / 状态 KV / 安装卸载）
 │    ├─ runtime.rs（宿主壳页 ready 握手 / 窗口关闭等待）
 │    └─ protocol.rs（lullwidget:// 资源协议 + 逐插件 CSP）
 ├─ game_package（游戏包：清单 / 摘要 / 授权账本 / lullgame:// 资源协议）
 │    ├─ manifest.rs（game.json v1 校验 + capabilities/commands/events）
 │    ├─ digest.rs（旁路 .lull-integrity.json + 整包摘要）
 │    ├─ store.rs（包发现 / 授权 / 安装卸载 / 运行前检查）
 │    └─ protocol.rs（lullgame:// + 逐包 CSP / nonce）
 ├─ game（Game Runtime P1–P3：实例 / 权威 / 状态 / 存档 / 命令 / 副本注册）
 │    ├─ manager.rs（实例表 / 参与者 / ticker / 事件分发 / 命令去重）
 │    ├─ lifecycle.rs（启动 / 停止 / 立即保存 / failover）
 │    ├─ authority.rs（隐藏 game-authority-* 窗口与上下文注入）
 │    ├─ lease.rs（authorityEpoch / token / 心跳）
 │    ├─ state.rs（提交校验：revision / 配额 / 事件构造）
 │    ├─ repository.rs（game-data/<id>/<instance>/ 原子写 / 备份 / 恢复）
 │    ├─ api.rs（16 条 game_* / games_* 命令）
 │    └─ permissions.rs（窗口角色 / 顶层帧 token / Widget 授权）
 ├─ build.rs（校验 widgets/manifests，生成 $OUT_DIR/widget_specs.rs）
 ├─ window_frame.rs（原子 SetWindowPos）
 ├─ config（display.json 模型 / 迁移 / 原子写盘；含 display.media）
 ├─ media（Lull Media 平台；音乐资料库与视频壁纸运行时分开）
 │    ├─ video（原视频壁纸 Media Runtime）
 │    │    ├─ engine.rs（SessionKey → Session、Surface 映射；默认 HTML，可切 native）
 │    │    ├─ backends/media_pp.rs（可选 `native-media`：media-pp 管线 / Tee / 按 LUID 建 Device）
 │    │    ├─ assets.rs（media.json 素材库 + asset protocol URL）
 │    │    ├─ commands.rs / events.rs（IPC / media-changed）
 │    │    ├─ lifecycle.rs（窗口/拓扑/显隐/token）
 │    │    ├─ diagnostics.rs（Session/Surface/统计 DTO）
 │    │    ├─ native_bridge.rs（可选 `native-media`：lull_native.dll 的 lull_media_* FFI）
 │    │    └─ config.rs（MediaConfig 归一化）
 │    ├─ api（`media_call`、MediaRequest/Response、DTO/错误码、组合快照）
 │    ├─ engine（隐藏 `media-engine` 窗口、engine protocol v2、命令/事件）
 │    ├─ events（`media:event` 订阅、revision/eventId）
 │    ├─ output（Music + Noise 共享的全局输出音量）
 │    ├─ library（音乐资料库门面、lofty 元数据、扫描进度/取消、封面/歌词资产、revision 事件）
 │    ├─ noise（Noise Session/Track、内置 procedural Asset、本地素材导入/分类/标签/收藏、旧 5 层兼容门面）
 │    ├─ playback（Music 播放/队列、智能随机 Profile/Strategy/Engine、隐藏音频引擎）
 │    ├─ repository（SQLx：music.db 迁移、来源/曲目/艺术家/专辑查询）
 │    └─ mod.rs（init/shutdown；初始化视频运行时、引擎与音乐资料库）
 ├─ wallpaper
 │    ├─ runtime.rs（状态 + 命令 + autostart）
 │    ├─ windows.rs（创建 / 销毁 / 重建 / 热更新）
 │    ├─ watchdog.rs（ensure / 拓扑 / WorkerW）
 │    ├─ protocol.rs（URL 哈希）
 │    ├─ topology.rs（显示器解析 / 几何）
 │    └─ ffi.rs（DLL 加载 / C ABI / 日志）
```

依赖方向：`runtime → windows → protocol/topology → ffi`；`watchdog → ffi + windows`；`config` 不依赖任何壁纸模块；`media::video` 只通过 `wallpaper::runtime` 的配置/目标快照与 `windows` 生命周期钩子交互，不直接操作窗口。`media::library` 只依赖 `media::repository` 与 `media::api`，不依赖 `video`；`media::playback` 依赖 `repository`/`api`、`media::engine`、`media::events` 与 `media::output`，不依赖 `video`；`media::engine`/`media::events` 不依赖视频或 Noise 业务。

## 4. IPC 合约

类型以 Rust `serde` 输出为准；扩展类型集中在 `src/lib/extensions.ts`，场景/内容类型在
`src/content/user-content.ts` 与 SDK 中声明；字段变更必须同时改两侧与测试。

### 4.1 命令

| 命令 | 参数 | 返回 | 归属 |
| --- | --- | --- | --- |
| `window_set_frame` | `x,y,width,height` | `()` | `window_frame.rs` |
| `widget_open` | `kind` | `()` | `window_host` |
| `widget_states` | — | `{kind,visible,version,capabilities}[]` | `window_host` |
| `widget_close` | `kind` | `()` | `window_host` |
| `extensions_list` | — | `ExtensionInfo[]` | `extension` |
| `extensions_slots` | — | `SlotInfo[]` | `extension::slots` |
| `extensions_slot_use` | `slot,id` | `SlotInfo` | `extension::slots` |
| `extensions_slot_activate` | `slot` | `SlotInfo` | `extension::slots` |
| `extensions_slot_deactivate` | `slot` | `SlotInfo` | `extension::slots` |
| `extensions_inspect` | `path` | `ExtensionPreview` | `extension` |
| `extensions_pick` | — | `{path,preview} \| null` | `extension`（系统文件对话框） |
| `extensions_install` | `path,sourceDigest?` | `ExtensionInfo` | `extension` |
| `extensions_remove` | `kind,id` | `()` | `extension` |
| `extensions_set_enabled` | `id,enabled` | `ExtensionInfo` | `extension` |
| `extensions_set_capability` | `id,capability,granted` | `ExtensionInfo` | `extension` |
| `extensions_open` | `kind,id` | `()` | `extension` |
| `extensions_close` | `id` | `()` | `extension` |
| `extensions_stop` | `id` | `()` | `extension` |
| `extensions_open_dir` | `kind` | `string` | `extension` |
| `extensions_dev_state` | — | `DevState` | `extension::dev` |
| `extensions_dev_set_enabled` | `enabled` | `DevState` | `extension::dev` |
| `extensions_dev_pick_and_add` | — | `ExtensionInfo \| null` | `extension::dev`（目录选择器） |
| `extensions_dev_remove` | `id` | `()` | `extension::dev` |
| `extensions_dev_reload` | `id` | `()` | `extension::dev` |
| `widget_package_notify` | — | `()` | `widget_package`（仅插件窗口） |
| `widget_package_ready` | — | `()` | `widget_package::runtime`（仅插件窗口；Slot 切换等待此信号） |
| `widget_state_get` | `key` | `Value \| null` | `widget_package` |
| `widget_state_set` | `key,value` | `()` | `widget_package` |
| `widget_state_remove` | `key` | `()` | `widget_package` |
| `widget_set_transparent` | `transparent,color?` | `()` | `widget_package` |
| `window_prefs_get` | — | `{taskbarAndMinimize}` | `window_host::prefs` |
| `window_prefs_set` | `taskbarAndMinimize` | `{taskbarAndMinimize}` | `window_host::prefs` |
| `wallpaper_status` | — | `string` | `wallpaper::runtime` |
| `wallpaper_detach` | — | `string` | `wallpaper::runtime` |
| `wallpaper_set_visible` | `visible` | `bool` | `wallpaper::runtime` |
| `wallpaper_get_visible` | — | `bool` | `wallpaper::runtime` |
| `wallpaper_monitors` | — | `MonitorView[]` | `wallpaper::runtime` |
| `wallpaper_set_monitor_visible` | `device,visible` | `()` | `wallpaper::runtime` |
| `wallpaper_display_get` | — | `DisplayConfig` | `wallpaper::runtime` |
| `wallpaper_set_display` | `mode?,sync?,scene?` | `()` | `wallpaper::runtime`（显式选场景会清空 `display.game`；切到 independent 且带全局游戏时，主屏保留游戏、其它屏回退 `display.scene`） |
| `wallpaper_set_game` | `gameId: string \| null` | `()` | `wallpaper::runtime`（全局游戏；同步覆盖逐屏游戏，`null` 清空全部游戏） |
| `wallpaper_set_monitor_scene` | `device,scene` | `()` | `wallpaper::runtime`（仅 independent；同时清掉该屏游戏覆盖） |
| `wallpaper_set_monitor_game` | `device,gameId` | `()` | `wallpaper::runtime`（仅 independent；每屏独立选择游戏） |
| `media_capabilities` | — | `MediaCapabilities` | `media::video::commands` |
| `media_assets` / `media_asset_pick` / `media_asset_pick_many` / `media_asset_remove` | `id` | `MediaAsset[]` / `MediaAsset \| null` / `MediaAssetImportResult` / `()` | `media::video`（settings/backdrop） |
| `media_asset_url` / `media_asset_rename` / `media_asset_prune` | `id` / `id,name` | `string \| null` / `MediaAsset` / `number` | `media::video`（settings/backdrop） |
| `media_config_get` / `media_config_set` / `media_activate` | `config` / `assetId` | `MediaConfigView` | `media::video`（读配置时 settings/backdrop 免 token） |
| `media_open` / `media_attach` / `media_detach` / `media_degrade` | `sceneId,sessionId,origin` | `MediaOpenResult` / `MediaAttachResult` | `media::video`（壁纸需顶层 token） |
| `media_play` / `media_pause` / `media_seek` / `media_set_loop` | `sessionId,...` | `()` | `media::video`（settings） |
| `media_status` / `media_stats` | — | `MediaSessionView[]` / `MediaStats` | `media::video`（settings） |
| `media_call` | `request: {protocol,requestId,namespace,method,args}` | `{ok,result?,error?,revision}` | `media::api`（settings/player/noise/library） |
| `media_connect` / `media_disconnect` | `request: {topics?,progressMs?,levels?}` | `PlaybackSnapshot` / `()` | `media::playback`（player/noise/settings/library） |
| `media_engine_ready` / `media_engine_event` | `event: EngineEvent` | `()` | `media::playback`（仅 media-engine） |
| `content_packages` | — | `ContentPackageInfo[]`（含 `origin: bundled/user`） | `content_package`（壁纸窗只读） |
| `games_list` / `games_config_get` / `games_config_set` / `game_runtime_diagnostics` / `game_start` / `game_stop` / `game_suspend` / `game_resume` / `game_set_background` / `game_flush` / `game_save_delete` | `gameId` 等 | `GameView[]` / `GamesConfig` / `GameRuntimeDiagnostics` / `GameInstanceView` / `()` | `game::api`（settings；启停用走扩展中心命令） |
| `game_auto_start` | `gameId` | `GameInstanceView \| null` | `game::api`（壁纸窗专用，按 `games.json.autoStartWithWallpaper`） |
| `game_replica_entry` | `gameId` | `GameReplicaEntry` | `game::api`（壁纸窗专用：包内 `entry.replica` URL，无需令牌） |
| `game_connect` / `game_snapshot_get` / `game_command_send` / `game_state_commit` / `game_event_publish` / `game_render_state_publish` / `game_command_result` / `game_ready` / `game_heartbeat` / `game_report_error` / `game_detach` | 见 [Game Runtime](game-runtime.md) 附录 B | 同上 | `game::api`（authority / wallpaper / widget 按窗口 ACL + token 校验） |

所有会写配置的命令遵循同一事务模型：**先改内存 → 写盘 → 失败回滚内存 → 返回错误**。写盘使用临时文件 + 原子替换。

自定义命令同时受 Tauri ACL 约束：`build.rs` 的 app manifest 为每个命令生成 `allow-*` 权限，逐窗口 capability 决定谁能调用（见 4.4）。

### 4.2 事件

| 事件 | 发送方 | 消费方 |
| --- | --- | --- |
| `wallpaper-changed` | Rust（拓扑重建 / 开关 / 场景） | 设置窗壁纸页签刷新显示器与场景 |
| `widgets-changed` | Rust / 前端 | 设置页刷新库窗口 / 工具窗开关 |
| `window-prefs-changed` | Rust | 所有顶栏重新读取 `isMinimizable` |
| `flow-theme-changed` | 前端（跨窗口） | 设置 / 播放器 / 番茄钟 / 白噪音 |
| `content-changed` | Rust（内容包安装 / 卸载） | 设置页、扩展中心与壁纸窗的场景目录 |
| `extensions-changed` | Rust（安装 / 卸载 / 启用 / 改权限） | 扩展中心、托盘；兼容期同时发 `content-changed` |
| `slots-changed` | Rust（选择 / 激活 / 停用 / 窗口销毁 / 失败回滚） | 扩展中心、设置页窗口列表 |
| `media-changed` / `media-config-changed` | Rust（会话/配置/素材库） | 壁纸素材库窗口（素材列表订阅 `media-changed`）；设置窗壁纸页签的媒体壁纸面板订阅 `media-config-changed` |
| `media-master-visible` | Rust（全局壁纸显隐） | 壁纸 MediaSurface 暂停/恢复 HTML video |
| `media-degraded` | Rust（原生路径失败） | 壁纸 MediaSurface 切换 HTML 回退 |
| `media:event` | Rust（资料库 revision、扫描进度、歌单/收藏/历史、播放/队列、Noise Session/Track/Library、输出音量） | 音乐库窗口、白噪音库窗口、已订阅的播放器/白噪音窗口 |
| `media-engine-command` | Rust（`media::engine`） | 隐藏 `media-engine` 窗口 |
| `games-changed` | Rust（安装 / 启停 / 失败 / 授权变化） | 设置页「游戏」页签、扩展中心 |
| `game:snapshot` / `game:event` / `game:render` | Rust（`game::manager`） | 游戏 authority / replica / controller 窗口（定向投递） |
| `game:lifecycle` / `game:command` / `game:command-result` / `game:tick` | Rust（`game::manager`） | authority、replica、controller（按窗口角色定向） |

游戏事件由 Rust `emit_to(label)` 定向投递；前端监听必须带同一窗口 target
（项目封装为 `listenGameEvent`），否则 Tauri 默认的 `Any` 监听会收到所有游戏的
定向事件。详见 [Game Runtime §10.1.1](game-runtime.md)。

### 4.3 Widget 上下文注入

窗口创建时 Rust 通过 `initialization_script` 注入 `window.__LULL_WIDGET__`：

```json
{
  "schemaVersion": 1,
  "hostApi": 1,
  "id": "library",
  "capabilities": ["widget.ui", "widget.theme", "widget.state", "widget.chrome"],
  "window": { "label": "library", "width": 1080, "minWidth": 900, "minHeight": 600 }
}
```

能力清单直接来自 `widget_specs.rs`（manifest 生成），前端 SDK 的每个入口都先校验；
浏览器预览没有注入时按开发环境放行，Tauri 里缺上下文则失败关闭。见 [Widget SDK](widget-sdk.md)。

### 4.4 命令 ACL 与逐窗口 capability

- `build.rs` 用 `tauri_build::AppManifest::new().commands(APP_COMMANDS)` 为全部自定义命令生成 `allow-<command>` 权限；`lib.rs` 的 `generate_handler!` 与 `APP_COMMANDS` 必须完全一致（`pnpm widgets:check` 会比对）。
- `scripts/gen-widgets.mjs` 为每个窗口生成一份 `src-tauri/capabilities/window-<label>.json`：
  - `settings`：`core` 窗口权限 + 全部自定义命令（宿主控制面）；
  - `library`：`core` 窗口权限 + `allow-window-set-frame` + `allow-media-call/connect/disconnect`，可管理歌单/收藏/历史/队列，但不读来源根路径、不能扫描；
  - 官方 `widget-player` / `widget-noise` 通过 `window-widgets` 与 Widget 能力清单获得媒体权限，不拿引擎命令；
  - `media-engine`：仅 `core:event:allow-listen/unlisten` + `allow-media-engine-ready/event`，不能打开窗口、读资料库或调用 `media_call`；
  - 壁纸窗口 `wallpaper-*`：`core:event` 的 listen/unlisten + `allow-content-packages`（解析场景 id 用）
    + `allow-media-capabilities/config-get/open/attach/detach/degrade` + 游戏只读命令
    `allow-game-connect/snapshot-get/ready/report-error/detach`；媒体命令还必须带 Rust
    在建窗时注入顶层帧的 `__LULL_MEDIA_TOKEN__`，游戏命令带同一层注入的 `__LULL_GAME_TOKEN__`；
    没有窗口、壁纸、插件或内容包安装命令；
  - 游戏权威窗口 `game-authority-*`（隐藏）：只拿 `core:event` listen/unlisten +
    `allow-game-connect/snapshot-get/state-commit/event-publish/render-state-publish/command-result/ready/heartbeat/report-error/detach`；
    没有窗口、文件、包管理命令；authority token 只在宿主壳里，游戏 iframe 拿不到；
  - 包内控制器窗口 `game-controller-*`：`core:event` listen/unlisten + 拖拽/显示/销毁窗口帧权限 + `allow-game-connect/snapshot-get/command-send/report-error/detach`（能力由宿主 binding + 清单 scope 二次校验），**没有** `core:default`、包管理与壁纸命令。
  - 第三方窗口 `widget-*`：只有 `core:window` 的展示/隐藏/最小化/拖拽权限 + `core:event` 的 listen/unlisten（主题跟随）+ `allow-widget-state-*` + `allow-widget-package-notify` + `allow-widget-package-ready` + `allow-widget-set-transparent` + `allow-game-connect/snapshot-get/command-send/report-error/detach`（控制器桥，能力由授权账本二次校验），**没有 `core:default`**、**没有 event.emit**，不能调用包管理、壁纸或偏好命令。
- 构建期 `tauri-build` 会校验 capability 引用的权限是否存在；权限名或命令改名漏同步会直接编译失败。
- `media-engine` 是隐藏的受信 WebView，不是 Widget；它只拿到引擎命令事件与上报命令，不能反向读曲库或控制窗口。
- 所有 WebView 共用 `src-tauri/src/webview.rs` 的 Chromium 参数（自动播放、后台节流、occluded/backgrounding），否则隐藏引擎会被暂停；所有窗口必须复用同一份参数，避免 WebView2 environment options 不一致。
- 已知限制：WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍能看到 `__TAURI_INTERNALS__`。壁纸媒体命令靠**顶层帧 token** 兜底：注入脚本只在 `window.top === window` 时写 token，sandbox iframe 读不到父 DOM；不要把它当成插件 API，宿主桥仍是唯一受支持入口。

### 4.5 WebView CSP

`tauri.conf.json` 的 `app.security.csp` 已启用（生产），`devCsp` 单独放宽开发服务器：

```text
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
img-src 'self' data: blob:;
media-src 'self' blob: data: asset: http://asset.localhost https://asset.localhost;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
frame-src 'self' http://lullwidget.localhost lullwidget: http://lullcontent.localhost lullcontent: http://lullgame.localhost lullgame:;
object-src 'none';
base-uri 'self';
form-action 'none'
```

- `connect-src` 必须包含 `ipc:` 与 `http://ipc.localhost`，否则所有 Tauri IPC 失效；已通过调试端口实测。
- `tauri-build` 会给 HTML 里的内联脚本与所有 JS 资源追加 `sha256`，运行时补进 `script-src`；`'unsafe-inline'` 只是兜底。
- `devCsp` 额外允许 `http://localhost:3000`、`ws://localhost:3000` 与 `'unsafe-eval'`，避免破坏 Next HMR / React 开发模式。
- `frame-src 'self' http://lullwidget.localhost lullwidget: http://lullcontent.localhost lullcontent: http://lullgame.localhost lullgame:` 覆盖外部场景、第三方插件与游戏权威/副本 iframe；漏掉 `lullgame` 会让 Authority 一直等不到 ready（`game.authority_not_ready`），`src-tauri/src/game/authority.rs` 有回归测试。`media-src blob:` 保留给 UI 临时音频；`media-src asset: http://asset.localhost` 同时覆盖视频壁纸 HTML 回退与隐藏音频引擎的本地曲目（Tauri asset protocol 支持 Range）。

## 5. 配置模型

路径：`%APPDATA%\app.lull.desktop\display.json`（只读取 `display.json`；旧版 `wallpaper.json` 不再读取或迁移）。

```json
{
  "version": 2,
  "master_visible": true,
  "display": {
    "mode": "mirror",
    "sync": true,
    "scene": "lull.video",
    "media": {
      "assetId": "m_7f3a...",
      "loop": true,
      "muted": true,
      "rate": 1.0,
      "fit": "cover",
      "position": "center",
      "preferredFps": 30,
      "hardwareDecode": "auto",
      "share": "auto"
    }
  },
  "monitors": {
    "\\\\.\\DISPLAY1": { "enabled": true, "scene": "lull.bamboo" }
  }
}
```

版本必须等于 `2`；不兼容版本回退默认值并记录警告，不覆盖原文件。旧版 `wallpaper.json` 不读取、不迁移。`display.media` 默认值不落盘，旧配置无需迁移；视频素材库单独存 `%APPDATA%\app.lull.desktop\media.json`，只登记路径，不复制大文件。详见 [Media Runtime](media-runtime.md)。

音乐资料库独立于显示配置：`%APPDATA%\app.lull.desktop\music\music.db`（SQLite，WAL），`LULL_MUSIC_DIR` 可覆盖；封面/歌词资产按内容寻址保存在同级 `music/assets/`。它只登记本地音频路径与元数据，不复制、不改写用户文件；曲库、播放器、队列与白噪音已统一走 Media Service，播放源只在隐藏引擎内解析。详见 [Media Service](media-service.md)。

第三方插件相关路径：

```text
%APPDATA%\app.lull.desktop\widgets\<id>\widget.json     # 插件包
%APPDATA%\app.lull.desktop\widgets\<id>\...             # 静态资源
%APPDATA%\app.lull.desktop\widgets\.grants.json         # 启用 / 授权记录
%APPDATA%\app.lull.desktop\widgets\.slots.json          # 功能槽位当前选择（Selected）
%APPDATA%\app.lull.desktop\widgets\.state\<id>.json     # 插件状态 KV
```

`LULL_WIDGETS_DIR` 可覆盖插件根目录（开发/测试）。包格式、能力声明与协议见 [Widget SDK](widget-sdk.md)。

Game Runtime（P1–P3）路径：

```text
%APPDATA%\app.lull.desktop\games\<gameId>\game.json      # 游戏包
%APPDATA%\app.lull.desktop\games\.grants.json            # 启用 / 能力授权
%APPDATA%\app.lull.desktop\games.json                    # 运行偏好（autoStart / maxRunning / offlineMaxMs）
%APPDATA%\app.lull.desktop\game-data\<gameId>\<instanceId>\state.json
%APPDATA%\app.lull.desktop\game-data\<gameId>\<instanceId>\metadata.json
%APPDATA%\app.lull.desktop\game-data\<gameId>\<instanceId>\journal.ndjson  # 诊断用提交日志
%APPDATA%\app.lull.desktop\game-data\<gameId>\<instanceId>\backups\
```

`LULL_GAMES_DIR` / `LULL_GAME_DATA_DIR` 可覆盖。存档与包目录分离：卸载包默认保留存档。
每个游戏的状态都在自己的 `<gameId>/<instanceId>/` 下，不同 gameId 不会互相读取；
即使实例 id 相同，路径里的 gameId 仍保证隔离。
协议、命令与 P1–P3 边界见 [Game Runtime](game-runtime.md)。

## 6. 原生 C ABI

`lull_native.dll` 导出 13 个函数，Rust 绑定其中 11 个：

| 导出 | 用途 |
| --- | --- |
| `lull_native_attach(hwnd, monitor_index)` | 挂载到桌面层；`-1` = 整个宿主客户区 |
| `lull_native_detach(hwnd)` | 卸载并还原窗口状态 |
| `lull_native_ensure(hwnd)` | 样式 / 层序 / 矩形 / WebView 覆盖修复，返回位掩码 |
| `lull_native_status(hwnd, buf, cap)` | 单行 k=v 状态 |
| `lull_native_set_visible(hwnd, visible)` | ShowWindow，不抢焦点 |
| `lull_native_get_visible(hwnd)` | 当前可见性 |
| `lull_native_monitor_count()` | 显示器数量 |
| `lull_native_monitor_info(index, buf, cap)` | 单台显示器 k=v |
| `lull_native_topology_hash()` | 拓扑指纹 |
| `lull_native_ensure_host()` | WorkerW 缺失时补建 |
| `lull_native_disable_dwm_frame(hwnd)` | 关闭 DWM 非客户区渲染 |
| `lull_native_force_repaint(hwnd)` | 强制全窗重绘 |
| `lull_native_is_elevated()` | 进程是否提升（诊断用，Rust 暂未绑定） |

错误码与细节见 [原生宿主](native-host.md)。

媒体桥（`lull_media_probe/stream_create/submit_*`）已编入同一 `lull_native.dll`；Rust 侧仅在 `native-media` feature 下加载。默认构建走 HTML 回退。本轮目标机器 WebView2 `CreateTextureStream` 返回 `0x80070032`，因此即使启用 feature 也会在运行时回退；契约与实测见 [Media Runtime](media-runtime.md)。

## 7. 构建与测试

```text
pnpm test              前端 64 个测试文件（345 项，含 packages/{widget-sdk,scene-sdk,media-sdk}、音乐库筛选/扫描/歌单/收藏、共享音频增益、资料库窗口、Noise 素材库/分类标签/Preset 面板、Widget 媒体桥与 React hooks、队列解析、seek 整数化、懒加载分页、单层目录浏览、P4 元数据/标签/标签管理 CRUD 与标签曲目关联/智能歌单/音乐库窗口曲库整理页签、壁纸素材库窗口、设置窗壁纸页签、白噪音库窗口、封面预览、场景桥、参数滑条、媒体表面、zip 打包、更新安装与扩展中心、智能随机 Profile/设置面板/API 能力面板）
cargo test             Rust 279 项（配置 / 拓扑 / 协议 / 场景参数与 CSP / 包摘要与安装/更新 / Three.js 示例 / 开发模式 / 扩展管线 / 视频媒体会话 / 视频素材批量导入、重命名与失效清理、壁纸素材库配置读取鉴权 / 音乐库迁移、扫描/取消、资产、筛选、歌单/收藏/历史、默认曲库移除 / Noise 迁移、catalog 与 Session、素材导入/hash/查询、分类标签 CRUD、Preset FK/CRUD、Widget token/权限矩阵 / P4 标签/智能歌单/扫描保护 / P6 备份、歌词 sidecar / 设置窗最大高度 / 播放状态、睡眠到点暂停、窗口权限、订阅/快照、自动续播列表、智能随机 Profile/Strategy/Engine 与模拟校准、引擎协议）
pnpm lint              Biome（含 import 排序）
pnpm content:check     内容目录 + 包摘要 + 目录签名
pnpm content:hash      重算包摘要（--bundle <dir> 处理待分发内容包）/ content:sign 重新签名
pnpm widgets:check     Widget 清单 + 命令表 + 逐窗口 capability 同步
pnpm widgets:sdk       Widget 插件侧 SDK 构建（TS → dist + .d.ts）
pnpm widgets:sdk:check Widget SDK 类型检查
pnpm scenes:sdk        场景侧 SDK 构建（TS → dist + .d.ts）
pnpm scenes:sdk:check  场景 SDK 类型检查
pnpm game:sdk          Game SDK 构建（TS → dist + .d.ts）
pnpm game:sdk:check    Game SDK 类型检查
pnpm media:sdk         Media SDK 构建（TS → dist + .d.ts）
pnpm media:sdk:check   Media SDK 类型检查
pnpm build:next        Next 静态导出（离线字体）
pnpm test-mode         Windows 真机：层序 + 命中 + 动画差分 + 桌面还原
pnpm build             prebuild → DLL → 静态导出 → Tauri 安装包
```

对原生桌面挂载，纯单元测试不够；`pnpm test-mode` 的真机验收仍是发布门槛。

## 8. A/B/C/D 演进路线

| 阶段 | 目标 | 当前状态 | 退出条件 |
| --- | --- | --- | --- |
| **A · Core** | 模块边界、配置/协议版本、命名清理、测试基线 | 已完成第一轮 | 目录与命名重构后功能/测试/安装包不退化 |
| **B · Extensions** | Scene SDK、Widget SDK、内置工具与外置插件验证 | Scene SDK 已落地：静态包 + `wallpaper.script` 沙箱场景，`@lull/scene-sdk` 提供参数/几何/同步/可见性桥与契约测试；内置 Widget SDK、逐窗口 ACL、CSP、插件包/iframe 桥/状态 KV 已落地；插件 ZIP 安装、旁路摘要锁、扩展中心、逐能力授权、清单漂移复核、开发模式与托盘入口已落地；仍缺 npm 发布与签名 | 外部示例场景无需改核心即可运行 |
| **C · Community** | 内容包格式、示例、包摘要、目录签名、用户内容目录与安装器 | 格式 + 示例 + 摘要 + 签名 + 统一安装入口（scene/widget 共用 staging）已落地；仍缺在线索引、第三方签名信任链与 scene 卸载自动回退 | 外部开发者可独立构建、安装并分享内容包 |
| **D · Services** | 内容索引、可选同步、创作者发布 | 仅设计 | 服务带来明确价值，且断网不影响本地 |
| **E · Game Runtime** | 游戏实例管理、权威状态、多屏 Render Replica、第三方引擎接入 | **P1–P3 部分 + P4 Canvas Adapter 落地**：[Game Runtime](game-runtime.md) / [Game SDK](game-sdk.md)（单实例、`host-tick`/`self-loop`、存档与 journal、命令/事件、Widget 控制器、Scene 只读 Replica、暂停/恢复、`games.json` 偏好、租约 failover 硬化、Canvas2D Adapter）；`entry.replica`、其余引擎 Adapter 与 WebView 稳定性报告仍为设计 | P4 接 `entry.replica` 与 Phaser/Pixi/Three Adapter，P5 做生态与目录 |

## 9. 已知边界与风险

1. **Windows-only**：依赖 `Progman` / `WorkerW` / DWM 行为，没有跨平台回退。
2. **原生挂载不是稳定 API**：Explorer 重启、DPI、任务栏自动隐藏、混合缩放都可能改变桌面拓扑；看门狗与重建是产品能力，不是临时补丁。
3. **WebView2 创建时序**：运行中建窗必须在非主线程；不要把 `WebviewWindowBuilder` 移回同步命令。
4. **外部内容仍是受限运行时**：静态包使用空 `sandbox`，只运行 HTML/CSS；脚本场景使用
   `sandbox="allow-scripts"` 的 opaque-origin iframe，只能通过 `@lull/scene-sdk` 读取帧，
   没有写配置、建窗、原生或任意 IPC 入口；仍不是通用插件系统。
5. **安装包与素材授权**：公开分发前需完成代码签名、字体/图标/声音素材授权复核。
6. **内部代号**：`ether-bubbles`、`liquid-player` 是已迁移组件的实现代号；`liquid-pomodoro` 现在是 `examples/widgets/liquid-pomodoro` 的示例目录名。
7. **内容包安装的边界**：v1 只接受单场景包、必须声明整包摘要、无第三方签名（未签名=未校验）、
   不联网。scene 支持同 id 本地覆盖安装（旧目录备份后替换，壁纸按版本重建 iframe）；
   没有自动更新、版本比较与回滚；安装目录由用户自行维护，卸载即删目录。
8. **第三方隔离的边界**：插件运行在不透明源 iframe 中，存储/IPC/宿主 DOM 都被隔离；但 WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍能看到 `__TAURI_INTERNALS__`。ACL 只给该窗口状态命令与自身窗口操作，且状态按窗口 label 隔离；不要把它当成插件 API。安装器、签名、网络授权 UI 与崩溃隔离仍未完成。
9. **视频壁纸的边界**：默认构建走 HTML `<video>` 回退，每个 WebView 自行解码；原生 media-pp/FFmpeg/WebView2 TextureStream 共享解码在可选 `native-media` feature 下实现，但本轮目标机器 WebView2 `CreateTextureStream` 返回 `0x80070032`，运行时自动回退。能力探测、构建依赖与验收门见 [Media Runtime](media-runtime.md)。不要把 HTML 回退描述成“单解码器”，也不要把“feature 已实现”描述成“原生已交付”。
10. **音乐资料库/播放的边界**：P2 已把播放、队列、白噪音迁到 Rust Media Service，音频由隐藏 `media-engine` WebView 输出；N1 进一步把 Music/Noise 收进同一个 `AudioGraph`（musicBus/noiseBus/master/limiter），并补上全局输出音量、订阅总线与组合快照。P3 已补歌单/喜欢/历史、M3U 导入导出与独立 `library` 资料库窗口（含队列视图）；N2 已把 Noise 从 `playback` 迁到独立 `media::noise`，引入 Asset/Track/Session 与旧 5 层兼容门面，Session/Track 不持久化；N3 已补 Noise 本地文件导入（受管复制 + SHA-256 + 缺失检测）、分类/标签/收藏/搜索与白噪音库窗口功能页签，文件轨道通过 `<audio>` 接入 `noiseBus`；N3.5 补分类/标签独立 CRUD（内置只读、层级循环保护、删除分类不删素材）；N4 补 Preset 保存/加载/导入导出、收藏与缺失轨道映射，加载替换 Session 但不自动播放；N5/P5 补 Widget 媒体桥、Rust bridge token、8 个 Noise capability、redacted snapshot、React hooks、`noise-mixer` 示例；N6 把白噪音窗口迁到 `NoiseSession` 动态轨道，支持内置泡泡 + 本地轨列表、Preset 选择/加载、播放/暂停，关闭窗口不停止 Session；P4 补元数据编辑与重扫保护、标签实体/多标签、艺术家/专辑合并拆分、智能歌单；P6 补 `.lrc/.txt/.srt` sidecar 歌词与组织数据备份/恢复，在线元数据、文件监听、缩略图未开始；随机播放已拆成 `playback::shuffle` 的 Profile / Strategy / Engine 三层：内置与用户配置可保存/切换，Strategy 用硬近期窗口 + softmax/均匀混合，Engine 管轮次袋与上一首历史；播放器只读写 Profile。详见 [Smart Shuffle](smart-shuffle.md)。`media_call` 对 `settings/player/noise/library/noise-library` 与带 token 的 `widget-*` 开放，`media_connect` 返回快照并通过 `media:event` 推送。多设备输出仍未接入。`media::video` 与本服务是两套独立运行时，不要混用。详见 [Media Service](media-service.md)、[Widget SDK](widget-sdk.md) 与 [Noise RFC](Lull%20Noise%20Service%20技术设计%20RFC.md)。
11. **Game Runtime 已到 P3 部分 + P4 单包双入口与四类渲染适配器**：[Game Runtime 设计](game-runtime.md) 与 [Game SDK](game-sdk.md) 的 P1–P3 及 `@lull/game-adapter-{canvas,phaser,pixi,three}` 已实现：`game-authority-*` 隐藏窗口、27 条命令、`lullgame://`、`games/` 与 `game-data/` 目录、`game.json` 包格式（`controllers[]`：包内页面或 Widget，1–8 个；仅运行中实例可打开/连接）、Widget 控制器桥与示例、**`/game-controller` 宿主壳 + `@lull/game-sdk/controller` 包内控制器**、**设置页运行中实例操作区开关 + 托盘「设置 ▸ 游戏控制器」列出全部运行中游戏（壁纸激活排前）**、Scene 只读 Replica（`game` 绑定 + `game.*` 桥）、**游戏包自带 `entry.replica` 直接作为壁纸（`GameReplicaHost` + `display.game` + `wallpaper_set_game`）**、暂停/恢复与 hidden/background、`games.json` 偏好（自动启动/启动恢复/上限/控制器跟随）、`self-loop` authority（experimental）、租约 failover 硬化、提交 journal、稳定性诊断命令/探针，以及 `examples/games/{phaser,pixi,three}-demo` 三个"一个 zip = 逻辑 + 渲染"的引擎示例。**尚未完成**：游戏开发挂载（`.lull-dev.json` 对游戏包）、扩展中心的游戏详情/逐能力开关、引擎矩阵的真机长跑与 WebView 稳定性报告，不要按设计文档假设这些能力已可调用；实现边界见设计文档 §19。
