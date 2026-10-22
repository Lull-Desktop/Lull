# Widget SDK

> 目标：给桌面工具窗口建立稳定的**清单、能力分层、运行时门面与窗口生命周期**契约。
> 当前状态：**内置工具 Host SDK**（本文）与**第三方插件体系 v1**（[Widget 插件包](widget-package.md)）均已落地。
> 内置工具仍由编译期清单注册；第三方插件以静态包安装到用户目录，在宿主壳 + iframe 中运行。

## 1. 当前实现

| 位置 | 职责 |
| --- | --- |
| `src/widgets/manifests/*.json` | 清单唯一事实源：id / 能力 / 窗口尺寸 / 展示顺序 |
| `src/sdk/widget/types.ts` | 契约类型、能力枚举、`WIDGET_HOST_API` |
| `src/sdk/widget/manifest.ts` | 清单与宿主上下文的运行时校验 |
| `src/sdk/widget/runtime.ts` | 能力校验、命名空间状态、窗口 chrome、音频/媒体闸门 |
| `src/sdk/widget/react.ts` | `useWidgetTheme` / `useWidgetFit` / `useWidgetState` |
| `src/widgets/registry.ts` | 解析清单，供设置页与工具列表使用 |
| `src-tauri/build.rs` | 构建期校验清单、生成 Rust 静态窗口描述与 app 命令 ACL |
| `src-tauri/src/window_host/spec.rs` | 生成的 `WidgetSpec` + `find` / `is_managed` |
| `src-tauri/src/window_host/mod.rs` | 创建、复用、隐藏、兜底显示、注入上下文 |
| `src-tauri/tauri.conf.json` | 生产 CSP 与 dev CSP（`csp` / `devCsp`） |
| `packages/widget-sdk` | 第三方插件侧客户端 + React/Vue 适配（见 [Widget 插件包](widget-package.md)） |
| `scripts/gen-widgets.mjs` | 校验清单 / 命令表，生成逐窗口 capability |

## 2. 单一事实源

```text
src/widgets/manifests/<id>.json
   ├─ src-tauri/build.rs ──────► $OUT_DIR/widget_specs.rs ──► WidgetSpec / ALL_WIDGETS
   │                       └───► app ACL manifest（allow-* 权限）
   ├─ scripts/gen-widgets.mjs ─► src-tauri/capabilities/window-<label>.json
   └─ src/widgets/registry.ts ─► 设置页 / 工具列表
```

- 新增或修改工具只改 JSON；Rust 描述在 `cargo build` 时重新生成，校验失败会中断编译。
- `pnpm widgets:check` 校验清单、命令表与逐窗口 capability，已接入 CI 与 `pnpm build` 前置。
- 不再维护第二份手写的 `spec.rs` 或第二份窗口授权表。

`WidgetManifest`：

```ts
type WidgetManifest = {
  schemaVersion: 1;
  type: "widget";
  role: "shell" | "tool";      // shell = 设置窗；tool = 可开关的桌面工具
  id: string;                  // 稳定 id，也是 widget_open 的参数
  name: string;
  version: string;
  description?: string;
  author?: string;
  license: string;
  builtin: boolean;            // 首期只接受 true
  order?: number;              // 设置页 / 托盘展示顺序
  capabilities: WidgetCapability[];
  window: {
    label: string;
    route: string;
    title: string;
    width: number;             // 初始宽度，同时是 chrome 调宽上限
    height: number;
    minWidth: number;
    minHeight: number;
    resizable: boolean;
    transparent: boolean;
  };
};
```

示例（当前播放器）：

```json
{
  "schemaVersion": 1,
  "type": "widget",
  "role": "tool",
  "id": "player",
  "name": "播放器",
  "version": "1.0.0",
  "license": "GPL-3.0-or-later",
  "builtin": true,
  "order": 10,
  "capabilities": [
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.media",
    "widget.chrome"
  ],
  "window": {
    "label": "player",
    "route": "player",
    "title": "Lull 播放器",
    "width": 880,
    "height": 552,
    "minWidth": 500,
    "minHeight": 520,
    "resizable": false,
    "transparent": true
  }
}
```

## 3. 能力分层

| 能力 | 首期 | 运行时行为 | 说明 |
| --- | --- | --- | --- |
| `widget.ui` | ✅ | 始终允许 | WebView 内 UI / CSS / 动画 |
| `widget.theme` | ✅ | 只读；未授权时退回宿主默认主题 | 读取 `--flow-*` 流光令牌，不能改全局主题 |
| `widget.state` | ✅ | `lull:<id>:<key>` 命名空间读写 | 未授权时只更新内存、不落盘 |
| `widget.audio` | ✅ | 创建音频上下文前检查 | 未授权时静音运行 |
| `widget.media` | ✅ | 导入本地媒体前检查 | 在线曲目仍受 CSP / 网络策略约束 |
| `widget.chrome` | ✅ 官方 / 插件自窗口 | 隐藏 / 最小化 / 拖拽 / 缩放 / 调宽；插件版只允许自己的窗口 | 调宽夹在 `[minWidth, width]` |
| `widget.window` | ⚠️ 仅设置外壳 | 宿主代建窗口；只有 settings 的 capability 含 `widget_*` 命令 | 第三方不可申请 |
| `widget.native` | ❌ | 无入口 | Win32 / 原生宿主 |

**声明不等于授权**：能力写在清单里，Rust 建窗时把它注入上下文；前端每个入口都先查上下文。
Tauri 侧还有第二道门：自定义命令由 app ACL manifest 生成 `allow-*` 权限，逐窗口 capability 决定谁能调用（见 4.5）。
能力校验目前防的是内置工具的误用，不是不可信代码的沙箱；第三方插件走独立的 iframe + Rust KV 边界，见 [Widget 插件包](widget-package.md)。

## 4. 运行时契约

### 4.1 宿主注入

Rust 在窗口创建时通过初始化脚本注入（先于页面 JS 执行）：

```js
window.__LULL_WIDGET__ = {
  schemaVersion: 1,
  hostApi: 1,
  id: "player",
  capabilities: ["widget.ui", "widget.theme", "widget.state", "widget.audio", "widget.media", "widget.chrome"],
  window: { label: "player", width: 880, minWidth: 500, /* … */ }
};
```

### 4.2 内置工具可用的 API

| 入口 | 内容 |
| --- | --- |
| `@/sdk/widget` | `getWidgetContext` / `hasWidgetCapability` / `requireWidgetCapability`、`readWidgetStorage` / `writeWidgetStorage` / `widgetStorageKey`、`isWidgetAudioAvailable` / `isWidgetMediaAvailable`、`widgetHideWindow` / `widgetMinimizeWindow` / `widgetIsMinimizable` / `onWidgetPrefsChanged` / `widgetSetResizable` / `widgetStartWindowDrag` / `widgetResizeWidth` / `widgetAlignPlayer` |
| `@/sdk/widget/react` | `useWidgetTheme` / `useWidgetFit` / `useWidgetState` |

- 浏览器预览与单元测试没有注入上下文：按开发环境放行。
- **Tauri 里缺少上下文时失败关闭**：能力查询返回 false，窗口操作与存储写入被忽略并只记一条告警。
- 内置工具不得再直接 import `src/core/window/controls` 或直接读 `localStorage`；`window-topbar` 属于宿主外壳，不在此列。

### 4.3 状态命名空间

- 键格式固定为 `lull:<id>:<key>`，`id` 必须与当前上下文一致，否则抛错。
- 现有键：`lull:player:v1`、`lull:pomodoro:v1`、`lull:noise:startup`。
- 宿主键（`lull:window:locked`、`lull:flow-theme`）不属于工具状态，工具不能通过 SDK 写入。

### 4.4 窗口 chrome

- 隐藏即关闭（`hide`），应用继续驻留托盘。
- 透明浮窗固定尺寸；只有声明 `widget.chrome` 的工具才能调宽或换边。
- 调宽请求按清单夹取，工具无法把自己撑出设计画布。

### 4.5 命令 ACL（逐窗口 capability）

- `build.rs` 的 `AppManifest::new().commands(APP_COMMANDS)` 为全部自定义命令生成 `allow-<command>` 权限。
- `lib.rs` 的 `generate_handler!` 与 `APP_COMMANDS` 必须一致；`pnpm widgets:check` 在 CI 里比对两份清单。
- 每个窗口一份 `src-tauri/capabilities/window-<label>.json`：
  - `settings`：全部自定义命令（宿主控制面）；
  - `player` / `pomodoro` / `noise`：只有 `allow-window-set-frame`，不能开关其他窗口或改壁纸；
  - 壁纸窗口没有 capability，任何 Tauri 命令都会被拒绝。
- `tauri-build` 在编译期校验 capability 引用的权限存在，命令改名漏同步会直接编译失败。

### 4.6 WebView CSP

`tauri.conf.json` 的生产 `csp`：

```text
default-src 'self'; connect-src 'self' ipc: http://ipc.localhost;
img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:;
style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';
worker-src 'self' blob:; frame-src 'self'; object-src 'none';
base-uri 'self'; form-action 'none'
```

- `connect-src` 必须含 `ipc:` 与 `http://ipc.localhost`，否则 Tauri IPC 全部失效。
- `tauri-build` 会为内联脚本和 JS 资源追加 `sha256`；`'unsafe-inline'` 只作兜底。
- `devCsp` 额外允许 Next 开发服务器的 `http://localhost:3000`、`ws://localhost:3000` 与 `'unsafe-eval'`。
- `media-src blob:` 覆盖本地音频的 object URL；`frame-src 'self'` 覆盖内容场景的 iframe。

## 5. 窗口生命周期

1. 创建时 `visible(false)`、无边框、`shadow(false)`；前端 `useWidgetFit` 贴合内容后再显示。
2. 已存在窗口再次 `widget_open` 只做 `show + unminimize + focus`，不重建 WebView。
3. 所有工具窗关闭 = `hide`；托盘「退出」才结束进程。
4. 透明浮窗（播放器 / 番茄钟 / 白噪音）固定尺寸、不可缩放，避免 Aero Snap 改变窗口。
5. 设置窗保留缩放；顶栏锁定按钮可动态关闭缩放。
6. 全局偏好关闭时，所有窗口不进任务栏、不可最小化；顶栏据此隐藏最小化按钮。
7. 前端贴合失败时，Rust 侧轮询兜底显示，避免窗口永远隐藏。
8. 托盘工具菜单由 `ALL_WIDGETS` 生成，新增工具不再改 `tray.rs`。

### 5.1 为什么第三方不能直接建窗

- 系统窗口是宿主能力，涉及 Z 序、焦点、任务栏、DPI 与桌面层；
- 窗口 label 也是 Tauri capability 的授权键，任意创建会扩大攻击面；
- 插件没有签名、权限声明与崩溃隔离。

v1 的开放路径是：插件清单声明尺寸/透明/chrome → 宿主创建受限窗口 → 只暴露白名单桥 API，而不是把 `WebviewWindowBuilder` 交给第三方。

## 6. 新增一个内置工具

1. 新增 `src/widgets/manifests/<id>.json`（role = tool，写清能力与窗口尺寸）。
2. 新增 `src/app/(widgets)/<route>/page.tsx`，只负责挂载组件。
3. 组件只通过 `@/sdk/widget` 与 `@/sdk/widget/react` 使用宿主能力。
4. 运行 `pnpm widgets:gen` 生成逐窗口 capability；`cargo build` 会重新生成 Rust 描述。
5. 补测试：清单校验、能力使用、窗口尺寸与透明策略。
6. 跑 `pnpm test`、`pnpm lint`、`pnpm widgets:check`、`cargo test`。
7. 真机检查：打开 / 关闭 / 托盘唤醒 / 锁定 / 任务栏偏好 / 多屏。

> 不要改 `spec.rs` 或 `capabilities/window-*.json`：前者由构建脚本生成，后者由 `pnpm widgets:gen` 生成。
> 新增或改名自定义命令时，`lib.rs` 与 `build.rs` 的 `APP_COMMANDS` 必须同时更新，`pnpm widgets:check` 会拦截漏项。

## 7. 状态与存储

- 工具状态统一走 SDK 门面，禁止直接 `localStorage`。
- 内置工具仍落在同源 `localStorage`（与宿主同信任级）；第三方插件走 Rust 侧 per-widget 状态文件（`.state/<id>.json`），带配额与原子写。
- 宿主配置（`display.json`、窗口偏好、主题）不对工具/插件开放写接口。

## 8. 第三方插件 v1 的边界

插件包格式、宿主壳、iframe 桥、Rust 状态 KV、逐窗口 ACL 与授权 UI 已落地（见 [Widget 插件包](widget-package.md)）。
仍缺：

1. **安装器/签名/更新**：目前手动复制目录；没有来源校验与在线更新。
2. **网络授权 UI**：`network` 目前随启用一起授予，没有逐源同意与运行时撤销提示。
3. **硬 IPC 隔离**：WebView2 会把 Tauri 初始化脚本应用到子帧，iframe 里仍能看到 `__TAURI_INTERNALS__`；ACL 只授予该窗口的最小命令，状态按窗口 label 隔离，但不能宣称“完全看不到 IPC”。
4. **故障隔离**：iframe 崩溃/卡死时宿主壳可重载，但没有 ErrorBoundary 指标与 per-plugin 日志面板。
5. **状态迁移 DSL**：撤销即清空；没有插件自定义迁移。
6. **插件市场**：不在首期范围。

> 内置工具 Host SDK 的 4.5（ACL）与 4.6（CSP）仍是插件体系的基础设施。

## 9. 非目标

- 不把内部 Tauri 命令直接暴露为公共插件 API；
- 不允许内容包执行任意 Rust 命令；
- 不允许内容包访问壁纸窗口或原生宿主；
- 不在首版实现工具市场、安装器或在线更新。

## 10. 许可

- `src/sdk/widget/**`、`packages/widget-sdk/**`：**Apache-2.0**（见 [SDK License](../SDK-LICENSE.md)）；
- 内置工具实现、窗口工厂与构建脚本：**GPL-3.0-or-later**；
- 第三方插件自身代码由其作者选择许可；官方样例为 MIT。插件安装器/签名仍未实现。
