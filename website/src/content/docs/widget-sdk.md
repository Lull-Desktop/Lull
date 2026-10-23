---
title: Widget SDK
description: 内置工具的能力分层、清单事实源、命令 ACL 与窗口生命周期，以及插件侧 SDK 的边界。
order: 4
group: 扩展开发
source: docs/widget-sdk.md
---

## 两套契约，不要混着用

| 契约 | 谁在用 | 清单 | 运行时 |
| --- | --- | --- | --- |
| **内置工具 Host SDK**（本页） | 播放器、番茄钟、白噪音、设置 | `src/widgets/manifests/<id>.json`，编译期注册 | 同源页面，`@/sdk/widget` 门面 |
| **第三方插件包** | 外部作者 | `widget.json`（schemaVersion 2） | 宿主壳 + iframe + Rust 状态 KV |

两者共享能力词汇、主题与宿主建窗逻辑，但清单、SDK、状态后端与信任模型都不同。
写插件请看[Widget 插件包](../widget-package/)，不要照抄内置工具的做法。

## 单一事实源

```text
src/widgets/manifests/<id>.json
   ├─ src-tauri/build.rs ──────► $OUT_DIR/widget_specs.rs ──► WidgetSpec / ALL_WIDGETS
   │                       └───► app ACL manifest（allow-* 权限）
   ├─ scripts/gen-widgets.mjs ─► src-tauri/capabilities/window-<label>.json
   └─ src/widgets/registry.ts ─► 设置页 / 工具列表
```

新增工具只改 JSON，Rust 描述在 `cargo build` 时重新生成，校验失败会中断编译。
`spec.rs` 与 `capabilities/window-*.json` 都是生成物，手改会在下次构建被覆盖。

## 能力分层

| 能力 | 首期 | 运行时行为 |
| --- | --- | --- |
| `widget.ui` | ✅ | 始终允许；WebView 内 UI / CSS / 动画 |
| `widget.theme` | ✅ | 只读流光令牌，不能改全局主题 |
| `widget.state` | ✅ | `lull:<id>:<key>` 命名空间读写 |
| `widget.audio` | ✅ | 创建音频上下文前检查；未授权静音运行 |
| `widget.media` | ✅ | 导入本地媒体前检查 |
| `widget.chrome` | ✅ | 隐藏 / 最小化 / 拖拽 / 缩放 / 调宽 |
| `widget.window` | ⚠️ 仅设置外壳 | 宿主代建窗口，第三方不可申请 |
| `widget.native` | ❌ | Win32 / 原生宿主，无入口 |

**声明不等于授权**：能力写在清单里，Rust 建窗时注入上下文，前端每个入口先查上下文；
Tauri 侧还有第二道门，由逐窗口 capability 决定谁能调用哪个命令。

## 运行时契约

宿主在页面脚本之前注入上下文：

```js
window.__LULL_WIDGET__ = {
  schemaVersion: 1,
  hostApi: 1,
  id: "player",
  capabilities: ["widget.ui", "widget.theme", "widget.state", "widget.audio", "widget.media", "widget.chrome"],
  window: { label: "player", width: 880, minWidth: 500 },
};
```

- 状态键固定 `lull:<id>:<key>`，`id` 与上下文不一致直接抛错；`lull:window:locked` 这类宿主键工具不能写。
- 浏览器预览与单测没有注入上下文，按开发环境放行；Tauri 里缺上下文则**失败关闭**（能力查询返回 false，写入被忽略并记一条告警）。
- 内置工具不得直接 import `src/core/window/controls` 或读 `localStorage`。

## 命令 ACL 与 CSP

- `build.rs` 用 `AppManifest.commands(APP_COMMANDS)` 为全部自定义命令生成 `allow-<command>`，`lib.rs` 的 `generate_handler!` 必须与之一致，`pnpm widgets:check` 在 CI 里比对。
- 每个窗口一份 `capabilities/window-<label>.json`：`settings` 拿全部命令；`player` / `pomodoro` / `noise` 只有 `allow-window-set-frame`；壁纸窗口 `wallpaper-*` 只有只读的 `allow-content-packages` 与事件订阅。
- 生产 CSP 里 `connect-src` 必须含 `ipc:` 与 `http://ipc.localhost`，否则 Tauri IPC 全部失效；`media-src blob:` 覆盖本地音频的 object URL。

## 窗口生命周期

1. 建窗时 `visible(false)`、无边框、`shadow(false)`；前端 `useWidgetFit` 贴合内容后再显示。
2. 已存在窗口再次打开只 `show + unminimize + focus`，不重建 WebView。
3. 关闭 = `hide`，进程继续驻留托盘；托盘「退出」才结束。
4. 透明浮窗固定尺寸、不可缩放，避免 Aero Snap 改变窗口。
5. 全局偏好关闭时窗口不进任务栏、不可最小化，顶栏据此隐藏最小化按钮。
6. 贴合失败时 Rust 侧轮询兜底显示，避免窗口永远隐藏。

## 插件侧 SDK 包（`@lull/widget-sdk`）

第三方插件只能用 `packages/widget-sdk`：TypeScript 源码 → `dist/*.js` + `dist/*.d.ts`，
入口 `.` / `./react` / `./vue` / `./testing`；`WidgetBridgeMethods` 一张表驱动 `request()` 的类型推导，
`createMemoryTransport()` 让插件作者不启动宿主就能写单测。改线上桥格式必须同时改 `client.test.ts` 的契约断言。

## 新增一个内置工具

1. 新增 `src/widgets/manifests/<id>.json`（`role: "tool"`，写清能力与窗口尺寸）。
2. 新增 `src/app/(widgets)/<route>/page.tsx`，只负责挂载组件。
3. 组件只通过 `@/sdk/widget` 与 `@/sdk/widget/react` 使用宿主能力。
4. `pnpm widgets:gen` 生成 capability，`cargo build` 重新生成 Rust 描述。
5. 补测试并跑 `pnpm test`、`pnpm lint`、`pnpm widgets:check`、`cargo test`；真机检查开关、托盘唤醒、锁定与多屏。

## 许可

`src/sdk/widget/**` 与 `packages/widget-sdk/**` 是 Apache-2.0；内置工具实现、窗口工厂与构建脚本是 GPL-3.0-or-later。

字段级契约（`WidgetManifest` 全字段、ACL 细节、CSP 完整串）见仓库
[Widget SDK](https://github.com/Lull-Desktop/Lull/blob/main/docs/widget-sdk.md)。
