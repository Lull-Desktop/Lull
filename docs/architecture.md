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
- 第三方插件窗口 label 为 `widget-<id>`：宿主壳页 `/embed` + `sandbox="allow-scripts"` iframe；`window.chrome` 为 `host` 时宿主绘制顶栏，为 `custom` 时插件自绘拖拽区/按钮（通过 `widget.chrome` 桥调用）。这类窗口共用 `window-widgets.json`（`widget-*` glob），只拿到自身状态命令与窗口操作，没有 `core:default`。
- 壁纸窗口只有一条**只读** capability（`window-wallpaper`：`content_packages` + 事件订阅）：
  场景切换走 `location.hash`（不重载页面），壁纸窗必须自己解析场景 id，因此要读得到用户内容包目录；
  除此之外没有任何窗口/壁纸/插件命令。外部静态场景跑在 `sandbox=""` 的 iframe 里（不执行 JS）；
  声明 `wallpaper.script` 的外部场景跑在 `sandbox="allow-scripts"` 的 opaque-origin iframe 里，
  只通过 `@lull/scene-sdk` 的 postMessage 桥读取参数/几何/相位。

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

前端 `src/core/wallpaper/params.ts` 负责解析与几何换算，`src/scenes/frame.ts` 负责合成本地帧（默认参数、能力与兼容性），`src/scenes/host.tsx` 负责选择内置组件或外部 iframe；`src/scenes/external-scene.tsx` + `scene-bridge.ts` 把帧推给声明 `wallpaper.script` 的外部场景。协议是纯函数，Rust/前端都有回归测试。

## 3. 分层与依赖规则

| 层 | 目录 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| **Core** | `src/core/**`、`src-tauri/src/{config,wallpaper,window_host}` | 平台 API、纯工具 | 依赖 `scenes` / `widgets` / `app` |
| **Extensions** | `src/sdk/**`、`src/scenes/**`、`src/widgets/**`（含 `manifests/`）、`packages/{widget-sdk,scene-sdk}/**`、`examples/widgets/**`、`src-tauri/src/widget_package/**` | Core 的只读类型与窗口 label 协议；`sdk/widget/runtime` 可调用 `core/window` 宿主适配；`widget_package` 可调用 `window_host` | 直接调用 `app` 路由或宿主命令 |
| **Community** | `content/**`、`public/content/**`、`scripts/*-content.mjs`、`src-tauri/src/content_package/**` | 清单格式、静态 HTML/CSS、受限沙箱脚本、用户内容目录读写 | 修改核心 / 创建系统窗口 / 越权访问宿主 |
| **Extension Center** | `src-tauri/src/extension/**`、`src-tauri/src/package_hash.rs`、`src/components/extensions/**`、`src/lib/extensions.ts`、`src/hooks/use-extensions.ts` | `content_package` / `widget_package` 的校验与运行时；共享安装管线 | 拥有包格式 / 直接执行包内代码 |
| **Services** | 设计文档 | — | 成为本地运行前置依赖 |
| **App** | `src/app/**`、`src/components/**`、`src/hooks/**` | 以上全部 | 把业务规则塞回路由壳 |

落地约束：

- `src/sdk/**` 不 import `src/app/**` 或 `src/components/**`。
- `src/scenes/**` 只接收 `SceneProps`，不读配置文件、不调用 Tauri。
- `src/content/catalog.ts` 是内容加载服务，依赖 `sdk/scene`，不反向被 `core` 依赖。
- `window_host` 只暴露窗口 label 前缀 `DYNAMIC_WINDOW_PREFIX`；`widget_package` 依赖 Core，Core 不反向 import 插件模块。
- `src-tauri/src/lib.rs` 只做插件、命令与生命周期接线；新增能力先进对应模块。
- C++ 不依赖 React / Tauri / 内容包；Rust 不依赖 C++ 内部头文件。

### 3.1 前端模块图

```text
app/(wallpaper) ──► scenes/host ──► hooks/use-scene-catalog ──► content/catalog
       │                │                    │
       │                ├──► scenes/registry ─┴──► sdk/scene ──► core/wallpaper
       │                └──► scenes/external-scene ──► scene-bridge ──► postMessage（脚本场景）
       │
app/(control) ──► components/settings ──► widgets/registry ──► widgets/manifests/*.json
       │
app/(widgets) ──► components/{liquid-player,liquid-pomodoro,ether-bubbles}
                         │
                         ├──► sdk/widget/react ──► sdk/widget ──► core/window + hooks
                         │        （theme / fit / state）   （能力 / 状态 / chrome / 音频闸门）
                         └──► components 自身的纯模型（player-model / timer-model / sound-model）

app/(widgets)/embed ──► components/widget-plugin-shell ──► iframe（sandbox）
                                 └──► postMessage 桥 ──► widget_state_*（Rust）
packages/widget-sdk ──► 插件侧客户端 + React/Vue 适配
packages/scene-sdk ──► 场景侧客户端（参数 / 几何 / 同步 / 可见性）
examples/widgets/* ──► 静态插件包样例（TypeScript 源码，esbuild 构建）
examples/content/* ──► 内容包样例（静态 CSS / Scene SDK 脚本场景）
```

### 3.2 Rust 模块图

```text
lib.rs
 ├─ tray.rs ───────────────► window_host + widget_package（菜单项：内置工具 + 已启用扩展）
 ├─ window_host
 │    ├─ mod.rs（窗口工厂 / 上下文注入 / IPC）
 │    ├─ spec.rs（WidgetSpec 结构 + 查询；静态描述由 build.rs 生成）
 │    └─ prefs.rs（全局窗口偏好）
 ├─ content_package
 │    ├─ mod.rs（命令 + content-changed 事件）
 │    ├─ manifest.rs（catalog.json 校验：单场景 / id / entry / license）
 │    ├─ digest.rs（整包 sha256，与 content-digest.mjs 逐字节一致）
 │    ├─ store.rs（扫描 / zip 安装 / 卸载 / 打开目录）
 │    └─ protocol.rs（lullcontent:// 资源协议）
 ├─ resource.rs（safe_join + MIME，插件与内容包共用）
 ├─ package_hash.rs（两类包共用的文件遍历 + 摘要拼装）
 ├─ extension
 │    ├─ mod.rs（门面：列表 / 预览 / 安装 / 卸载 / 启停 / 权限）
 │    ├─ install.rs（共享 staging / zip / 预算 / 原子落地）
 │    ├─ dev.rs（开发模式配置 / 本地目录挂载）
 │    └─ error.rs（稳定错误码）
 ├─ widget_package
 │    ├─ mod.rs（插件窗口 / 命令 / 上下文）
 │    ├─ manifest.rs（widget.json v2 校验）
 │    ├─ digest.rs（旁路 .lull-integrity.json + 整包摘要）
 │    ├─ store.rs（包发现 / 授权记录 / 状态 KV / 安装卸载）
 │    └─ protocol.rs（lullwidget:// 资源协议 + 逐插件 CSP）
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
| `wallpaper_set_display` | `mode?,sync?,scene?` | `()` | `wallpaper::runtime` |
| `wallpaper_set_monitor_scene` | `device,scene` | `()` | `wallpaper::runtime` |
| `content_packages` | — | `ContentPackageInfo[]` | `content_package`（壁纸窗只读） |

所有会写配置的命令遵循同一事务模型：**先改内存 → 写盘 → 失败回滚内存 → 返回错误**。写盘使用临时文件 + 原子替换。

自定义命令同时受 Tauri ACL 约束：`build.rs` 的 app manifest 为每个命令生成 `allow-*` 权限，逐窗口 capability 决定谁能调用（见 4.4）。

### 4.2 事件

| 事件 | 发送方 | 消费方 |
| --- | --- | --- |
| `wallpaper-changed` | Rust（拓扑重建 / 开关 / 场景） | 设置页刷新显示器与场景 |
| `widgets-changed` | Rust / 前端 | 设置页刷新工具窗开关 |
| `window-prefs-changed` | Rust | 所有顶栏重新读取 `isMinimizable` |
| `flow-theme-changed` | 前端（跨窗口） | 设置 / 播放器 / 番茄钟 / 白噪音 |
| `content-changed` | Rust（内容包安装 / 卸载） | 设置页与壁纸窗的场景目录 |
| `extensions-changed` | Rust（安装 / 卸载 / 启用 / 改权限） | 扩展中心、托盘；兼容期同时发 `content-changed` |

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
  - 壁纸窗口 `wallpaper-*`：只有 `core:event` 的 listen/unlisten + `allow-content-packages`（解析场景 id 用），
    没有窗口、壁纸、插件或内容包安装命令；
  - 第三方窗口 `widget-*`：只有 `core:window` 的展示/隐藏/最小化/拖拽权限 + `core:event` 的 listen/unlisten（主题跟随）+ `allow-widget-state-*` + `allow-widget-package-notify` + `allow-widget-set-transparent`，**没有 `core:default`**、**没有 event.emit**，不能调用包管理、壁纸或偏好命令。
- 构建期 `tauri-build` 会校验 capability 引用的权限是否存在；权限名或命令改名漏同步会直接编译失败。
- 已知限制：WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍能看到 `__TAURI_INTERNALS__`。但 ACL 只授予上表里的最小命令，且状态命令按窗口 label 推导插件 id；不要把它当成插件 API，宿主桥仍是唯一受支持入口。

### 4.5 WebView CSP

`tauri.conf.json` 的 `app.security.csp` 已启用（生产），`devCsp` 单独放宽开发服务器：

```text
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
img-src 'self' data: blob:;
media-src 'self' blob: data:;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
frame-src 'self' http://lullwidget.localhost lullwidget:;
object-src 'none';
base-uri 'self';
form-action 'none'
```

- `connect-src` 必须包含 `ipc:` 与 `http://ipc.localhost`，否则所有 Tauri IPC 失效；已通过调试端口实测。
- `tauri-build` 会给 HTML 里的内联脚本与所有 JS 资源追加 `sha256`，运行时补进 `script-src`；`'unsafe-inline'` 只是兜底。
- `devCsp` 额外允许 `http://localhost:3000`、`ws://localhost:3000` 与 `'unsafe-eval'`，避免破坏 Next HMR / React 开发模式。
- `frame-src 'self' http://lullwidget.localhost lullwidget:` 覆盖外部场景 iframe 与第三方插件 iframe；`media-src blob:` 覆盖播放器的本地文件 object URL。

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

第三方插件相关路径：

```text
%APPDATA%\app.lull.desktop\widgets\<id>\widget.json     # 插件包
%APPDATA%\app.lull.desktop\widgets\<id>\...             # 静态资源
%APPDATA%\app.lull.desktop\widgets\.grants.json         # 启用 / 授权记录
%APPDATA%\app.lull.desktop\widgets\.state\<id>.json     # 插件状态 KV
```

`LULL_WIDGETS_DIR` 可覆盖插件根目录（开发/测试）。包格式、能力声明与协议见 [Widget SDK](widget-sdk.md)。

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
pnpm test              前端 38 个测试文件（213 项，含 packages/{widget-sdk,scene-sdk}、场景桥、参数滑条、zip 打包、更新安装与扩展中心）
cargo test             Rust 100 项（配置 / 拓扑 / 协议 / 场景参数与 CSP / 包摘要与安装/更新 / Three.js 示例 / 开发模式 / 扩展管线）
pnpm lint              Biome（含 import 排序）
pnpm content:check     内容目录 + 包摘要 + 目录签名
pnpm content:hash      重算包摘要（--bundle <dir> 处理待分发内容包）/ content:sign 重新签名
pnpm widgets:check     Widget 清单 + 命令表 + 逐窗口 capability 同步
pnpm widgets:sdk       Widget 插件侧 SDK 构建（TS → dist + .d.ts）
pnpm widgets:sdk:check Widget SDK 类型检查
pnpm scenes:sdk        场景侧 SDK 构建（TS → dist + .d.ts）
pnpm scenes:sdk:check  场景 SDK 类型检查
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

## 9. 已知边界与风险

1. **Windows-only**：依赖 `Progman` / `WorkerW` / DWM 行为，没有跨平台回退。
2. **原生挂载不是稳定 API**：Explorer 重启、DPI、任务栏自动隐藏、混合缩放都可能改变桌面拓扑；看门狗与重建是产品能力，不是临时补丁。
3. **WebView2 创建时序**：运行中建窗必须在非主线程；不要把 `WebviewWindowBuilder` 移回同步命令。
4. **外部内容仍是受限运行时**：静态包使用空 `sandbox`，只运行 HTML/CSS；脚本场景使用
   `sandbox="allow-scripts"` 的 opaque-origin iframe，只能通过 `@lull/scene-sdk` 读取帧，
   没有写配置、建窗、原生或任意 IPC 入口；仍不是通用插件系统。
5. **安装包与素材授权**：公开分发前需完成代码签名、字体/图标/声音素材授权复核。
6. **内部代号**：`ether-bubbles`、`liquid-player`、`liquid-pomodoro` 仍是组件目录名，属于实现代号，不构成对外产品名。
7. **内容包安装的边界**：v1 只接受单场景包、必须声明整包摘要、无第三方签名（未签名=未校验）、
   不联网。scene 支持同 id 本地覆盖安装（旧目录备份后替换，壁纸按版本重建 iframe）；
   没有自动更新、版本比较与回滚；安装目录由用户自行维护，卸载即删目录。
8. **第三方隔离的边界**：插件运行在不透明源 iframe 中，存储/IPC/宿主 DOM 都被隔离；但 WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍能看到 `__TAURI_INTERNALS__`。ACL 只给该窗口状态命令与自身窗口操作，且状态按窗口 label 隔离；不要把它当成插件 API。安装器、签名、网络授权 UI 与崩溃隔离仍未完成。
