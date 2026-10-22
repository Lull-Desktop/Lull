# Lull 架构与模块边界

> 状态：v0.1.0 重构基线。本文描述**当前代码实际边界**与下一步演进方向，不代表已经拆成多仓库。

## 1. 结论先行

Lull 采用 **模块化单体（Modular Monolith）+ 可版本化扩展协议**：

- 仍然是一个 Git 仓库、一个桌面应用、一套发布流程；
- 内部按 A/B/C/D 四层组织：Core / Extensions / Community / Services；
- 首版只把**静态场景包**开放给外部；工具窗口和原生能力仍由官方代码注册；
- 不提前拆 Rust crate 或多仓库，避免 Win32 宿主、IPC、配置在多个版本间来回同步。

## 2. 运行模型

```text
┌──────────────────────────────────────────────────────────────┐
│ lull.exe（Tauri / Rust）                                     │
│  ├─ 托盘 + 设置窗 + 播放器 / 番茄钟 / 白噪音浮窗              │
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
- 工具窗口 label 固定为 `settings` / `player` / `pomodoro` / `noise`，每个窗口有独立的 capability 文件（`src-tauri/capabilities/window-<label>.json`，由清单生成）。
- 壁纸窗口**不在** `capabilities/default.json` 的授权列表里：场景页面无法调用 Tauri IPC。

### 2.2 壁纸画面协议

Rust 通过 URL 哈希把画面参数传给 WebView：

```text
/#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=0,0,1920,1080&params=%7B%22mist%22%3A%220.5%22%7D
```

| 字段 | 含义 |
| --- | --- |
| `mode` | `mirror` / `independent` / `span` |
| `sync` | `1` 时按绝对时间对齐动画相位 |
| `scene` | 场景 id（内置 `lull.*`，外部 `community.*`） |
| `canvas` | 跨屏共享画布（物理像素桌面坐标，可为负） |
| `view` | 当前窗口对应的桌面矩形 |
| `params` | JSON 后再 URI 编码的场景参数（字符串键值）；为空时省略 |

前端 `src/core/wallpaper/params.ts` 负责解析与几何换算，`src/scenes/frame.ts` 负责合成本地帧（默认参数、能力与兼容性），`src/scenes/host.tsx` 负责选择内置组件或外部 iframe。协议是纯函数，Rust/前端都有回归测试。

## 3. 分层与依赖规则

| 层 | 目录 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| **Core** | `src/core/**`、`src-tauri/src/{config,wallpaper,window_host}` | 平台 API、纯工具 | 依赖 `scenes` / `widgets` / `app` |
| **Extensions** | `src/sdk/**`、`src/scenes/**`、`src/widgets/**`（含 `manifests/`） | Core 的只读类型；`sdk/widget/runtime` 可调用 `core/window` 宿主适配 | 直接调用 `app` 路由或宿主命令 |
| **Community** | `content/**`、`public/content/**`、`scripts/validate-content.mjs` | 清单格式、静态 HTML/CSS | 修改核心 / 创建系统窗口 |
| **Services** | 设计文档 | — | 成为本地运行前置依赖 |
| **App** | `src/app/**`、`src/components/**`、`src/hooks/**` | 以上全部 | 把业务规则塞回路由壳 |

落地约束：

- `src/sdk/**` 不 import `src/app/**` 或 `src/components/**`。
- `src/scenes/**` 只接收 `SceneProps`，不读配置文件、不调用 Tauri。
- `src/content/catalog.ts` 是内容加载服务，依赖 `sdk/scene`，不反向被 `core` 依赖。
- `src-tauri/src/lib.rs` 只做插件、命令与生命周期接线；新增能力先进对应模块。
- C++ 不依赖 React / Tauri / 内容包；Rust 不依赖 C++ 内部头文件。

### 3.1 前端模块图

```text
app/(wallpaper) ──► scenes/host ──► hooks/use-scene-catalog ──► content/catalog
       │                │                    │
       │                └──► scenes/registry ─┴──► sdk/scene ──► core/wallpaper
       │
app/(control) ──► components/settings ──► widgets/registry ──► widgets/manifests/*.json
       │
app/(widgets) ──► components/{liquid-player,liquid-pomodoro,ether-bubbles}
                         │
                         ├──► sdk/widget/react ──► sdk/widget ──► core/window + hooks
                         │        （theme / fit / state）   （能力 / 状态 / chrome / 音频闸门）
                         └──► components 自身的纯模型（player-model / timer-model / sound-model）
```

### 3.2 Rust 模块图

```text
lib.rs
 ├─ tray.rs ───────────────► window_host（菜单项由 ALL_WIDGETS 生成）
 ├─ window_host
 │    ├─ mod.rs（窗口工厂 / 上下文注入 / IPC）
 │    ├─ spec.rs（WidgetSpec 结构 + 查询；静态描述由 build.rs 生成）
 │    └─ prefs.rs（全局窗口偏好）
 ├─ build.rs（校验 widgets/manifests，生成 $OUT_DIR/widget_specs.rs）
 ├─ window_frame.rs（原子 SetWindowPos）
 ├─ config（display.json 模型 / 迁移 / 原子写盘）
 └─ wallpaper
      ├─ runtime.rs（状态 + 命令 + autostart）
      ├─ windows.rs（创建 / 销毁 / 重建 / 热更新）
      ├─ watchdog.rs（ensure / 拓扑 / WorkerW）
      ├─ protocol.rs（URL 哈希）
      ├─ topology.rs（显示器解析 / 几何）
      └─ ffi.rs（DLL 加载 / C ABI / 日志）
```

依赖方向：`runtime → windows → protocol/topology → ffi`；`watchdog → ffi + windows`；`config` 不依赖任何壁纸模块。

## 4. IPC 合约

类型以 Rust `serde` 输出为准；前端 TypeScript 类型在设置页内声明，字段变更必须同时改两侧与测试。

### 4.1 命令

| 命令 | 参数 | 返回 | 归属 |
| --- | --- | --- | --- |
| `window_set_frame` | `x,y,width,height` | `()` | `window_frame.rs` |
| `widget_open` | `kind` | `()` | `window_host` |
| `widget_states` | — | `{kind,visible,version,capabilities}[]` | `window_host` |
| `widget_close` | `kind` | `()` | `window_host` |
| `window_prefs_get` | — | `{taskbarAndMinimize}` | `window_host::prefs` |
| `window_prefs_set` | `taskbarAndMinimize` | `{taskbarAndMinimize}` | `window_host::prefs` |
| `wallpaper_status` | — | `string` | `wallpaper::runtime` |
| `wallpaper_detach` | — | `string` | `wallpaper::runtime` |
| `wallpaper_set_visible` | `visible` | `bool` | `wallpaper::runtime` |
| `wallpaper_get_visible` | — | `bool` | `wallpaper::runtime` |
| `wallpaper_monitors` | — | `MonitorView[]` | `wallpaper::runtime` |
| `wallpaper_set_monitor_visible` | `device,visible` | `()` | `wallpaper::runtime` |
| `wallpaper_display_get` | — | `DisplayConfig` | `wallpaper::runtime` |
| `wallpaper_set_display` | `mode?,sync?,scene?` | `()` | `wallpaper::runtime` |
| `wallpaper_set_monitor_scene` | `device,scene` | `()` | `wallpaper::runtime` |

所有会写配置的命令遵循同一事务模型：**先改内存 → 写盘 → 失败回滚内存 → 返回错误**。写盘使用临时文件 + 原子替换。

自定义命令同时受 Tauri ACL 约束：`build.rs` 的 app manifest 为每个命令生成 `allow-*` 权限，逐窗口 capability 决定谁能调用（见 4.4）。

### 4.2 事件

| 事件 | 发送方 | 消费方 |
| --- | --- | --- |
| `wallpaper-changed` | Rust（拓扑重建 / 开关 / 场景） | 设置页刷新显示器与场景 |
| `widgets-changed` | Rust / 前端 | 设置页刷新工具窗开关 |
| `window-prefs-changed` | Rust | 所有顶栏重新读取 `isMinimizable` |
| `flow-theme-changed` | 前端（跨窗口） | 设置 / 播放器 / 番茄钟 / 白噪音 |

### 4.3 Widget 上下文注入

窗口创建时 Rust 通过 `initialization_script` 注入 `window.__LULL_WIDGET__`：

```json
{
  "schemaVersion": 1,
  "hostApi": 1,
  "id": "player",
  "capabilities": ["widget.ui", "widget.theme", "widget.state", "widget.audio", "widget.media", "widget.chrome"],
  "window": { "label": "player", "width": 880, "minWidth": 500, "minHeight": 520 }
}
```

能力清单直接来自 `widget_specs.rs`（manifest 生成），前端 SDK 的每个入口都先校验；
浏览器预览没有注入时按开发环境放行，Tauri 里缺上下文则失败关闭。见 [Widget SDK](widget-sdk.md)。

### 4.4 命令 ACL 与逐窗口 capability

- `build.rs` 用 `tauri_build::AppManifest::new().commands(APP_COMMANDS)` 为全部自定义命令生成 `allow-<command>` 权限；`lib.rs` 的 `generate_handler!` 与 `APP_COMMANDS` 必须完全一致（`pnpm widgets:check` 会比对）。
- `scripts/gen-widgets.mjs` 为每个窗口生成一份 `src-tauri/capabilities/window-<label>.json`：
  - `settings`：`core` 窗口权限 + 全部自定义命令（宿主控制面）；
  - `player` / `pomodoro` / `noise`：`core` 窗口权限 + `allow-window-set-frame`（只能调整自己的窗口帧）；
  - 壁纸窗口：**没有 capability**，因此无法调用任何 Tauri 命令。
- 构建期 `tauri-build` 会校验 capability 引用的权限是否存在；权限名或命令改名漏同步会直接编译失败。

## 5. 配置模型

路径：`%APPDATA%\app.lull.desktop\display.json`（只读取 `display.json`；旧版 `wallpaper.json` 不再读取或迁移）。

```json
{
  "version": 2,
  "master_visible": true,
  "display": {
    "mode": "mirror",
    "sync": true,
    "scene": "lull.bamboo"
  },
  "monitors": {
    "\\\\.\\DISPLAY1": { "enabled": true, "scene": "lull.aurora" }
  }
}
```

版本必须等于 `2`；不兼容版本回退默认值并记录警告，不覆盖原文件。旧版 `wallpaper.json` 不读取、不迁移。

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

## 7. 构建与测试

```text
pnpm test              前端 23 个测试文件（131 项）
cargo test             Rust 44 项（display 配置 / 拓扑 / 协议 / 场景参数 / Widget 清单与上下文）
pnpm lint              Biome（含 import 排序）
pnpm content:check     内容目录 + entry 存在性
pnpm widgets:check     Widget 清单 + 命令表 + 逐窗口 capability 同步
pnpm build:next        Next 静态导出（离线字体）
pnpm test-mode         Windows 真机：层序 + 命中 + 动画差分 + 桌面还原
pnpm build             prebuild → DLL → 静态导出 → Tauri 安装包
```

对原生桌面挂载，纯单元测试不够；`pnpm test-mode` 的真机验收仍是发布门槛。

## 8. A/B/C/D 演进路线

| 阶段 | 目标 | 当前状态 | 退出条件 |
| --- | --- | --- | --- |
| **A · Core** | 模块边界、配置/协议版本、命名清理、测试基线 | 已完成第一轮 | 目录与命名重构后功能/测试/安装包不退化 |
| **B · Extensions** | Scene SDK、Widget SDK、内置工具验证 | Scene SDK 已落地；Widget 完成清单单源、运行时能力门面与命令 ACL 收口，第三方仍未开放 | 外部示例场景无需改核心即可运行 |
| **C · Community** | 内容包格式、示例、校验、贡献流程 | 格式 + 示例 + 校验已落地 | 外部开发者可独立构建并分享内容包 |
| **D · Services** | 内容索引、可选同步、创作者发布 | 仅设计 | 服务带来明确价值，且断网不影响本地 |

## 9. 已知边界与风险

1. **Windows-only**：依赖 `Progman` / `WorkerW` / DWM 行为，没有跨平台回退。
2. **原生挂载不是稳定 API**：Explorer 重启、DPI、任务栏自动隐藏、混合缩放都可能改变桌面拓扑；看门狗与重建是产品能力，不是临时补丁。
3. **WebView2 创建时序**：运行中建窗必须在非主线程；不要把 `WebviewWindowBuilder` 移回同步命令。
4. **外部内容不等于安全插件系统**：首版 iframe 使用空 `sandbox`，只运行静态 HTML/CSS，不执行 JavaScript；若未来开放宿主 API，必须另做权限、来源校验、IPC 白名单与故障隔离。
5. **安装包与素材授权**：公开分发前需完成代码签名、字体/图标/声音素材授权复核。
6. **内部代号**：`ether-bubbles`、`liquid-player`、`liquid-pomodoro` 仍是组件目录名，属于实现代号，不构成对外产品名。
7. **第三方隔离仍未完成**：自定义命令已通过 app ACL manifest 按窗口授权（壁纸窗口没有 capability），但第三方 JS 进场前还需要 CSP、独立源 iframe、宿主代建窗口与 Rust 侧状态 KV，见 [Widget SDK](widget-sdk.md) 第 8 节。
