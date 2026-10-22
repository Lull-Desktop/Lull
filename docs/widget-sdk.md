# Widget SDK

> 目标：给桌面工具窗口建立稳定的**清单、能力分层、运行时门面与窗口生命周期**契约。
> 当前状态：清单单源、运行时能力校验与逐窗口命令 ACL 已落地；**首期仍只注册官方工具**，第三方窗口创建与原生调用不开放。

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
| `widget.chrome` | ✅ 官方 | 隐藏 / 最小化 / 拖拽 / 缩放 / 调宽 | 调宽夹在 `[minWidth, width]` |
| `widget.window` | ⚠️ 仅设置外壳 | 宿主代建窗口；只有 settings 的 capability 含 `widget_*` 命令 | 第三方不可申请 |
| `widget.native` | ❌ | 无入口 | Win32 / 原生宿主 |

**声明不等于授权**：能力写在清单里，Rust 建窗时把它注入上下文；前端每个入口都先查上下文。
Tauri 侧还有第二道门：自定义命令由 app ACL manifest 生成 `allow-*` 权限，逐窗口 capability 决定谁能调用（见 4.5）。
能力校验目前防的是内置工具的误用，不是不可信代码的沙箱——第三方开放前必须补第 8 节的边界。

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
- 首期没有插件签名、权限声明与崩溃隔离。

未来的开放路径：内容包声明窗口与能力 → 宿主审核并代建受限窗口 → 只暴露白名单 API，而不是把 `WebviewWindowBuilder` 交给第三方。

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
- 首期仍落在同源 `localStorage`（内置工具可信）；第三方开放前会改为 Rust 侧 per-widget 状态文件，带配额、版本迁移与原子写。
- 宿主配置（`display.json`、窗口偏好、主题）不对工具开放写接口。

## 8. 第三方开放前还缺什么

1. **包格式与加载**：`ContentManifest` 尚无 `widget` 类型；需要 `content/widgets/<id>/index.html` + 清单 + 校验器。
2. **隔离宿主**：第三方 UI 必须跑在独立源的 iframe（`sandbox="allow-scripts"`，不带 `allow-same-origin`）里，通过 postMessage 桥访问受限 API。
3. **CSP**：`tauri.conf.json` 的 `csp` 仍为 `null`，第三方 JS 进场前必须配置。
4. **权限模型**：清单 `requested` 与宿主 `granted` 分离，设置页展示授权与撤销，撤销时清理状态。
5. **宿主代建窗口**：第三方只声明尺寸策略，窗口与 caption 由宿主创建和夹取；capability 按 `widget:<id>` label 单独生成。
6. **状态 KV**：把第三方状态从同源 `localStorage` 移到 Rust 侧 per-widget 文件，带配额、版本迁移与原子写。
7. **故障隔离**：ErrorBoundary、per-widget 日志、崩溃后重载。
8. **签名与安装**：安装器、更新、来源校验。

> 自定义命令的 ACL 收口已在 4.5 完成；剩余项是第三方代码真正进场前的门槛。

## 9. 非目标

- 不把内部 Tauri 命令直接暴露为公共插件 API；
- 不允许内容包执行任意 Rust 命令；
- 不允许内容包访问壁纸窗口或原生宿主；
- 不在首版实现工具市场、安装器或在线更新。

## 10. 许可

- `src/sdk/widget/**`：**Apache-2.0**（见 [SDK License](../SDK-LICENSE.md)）；
- 内置工具实现、窗口工厂与构建脚本：**GPL-3.0-or-later**；
- 第三方工具目前不开放；未来开放时需先确定插件许可与权限边界。
