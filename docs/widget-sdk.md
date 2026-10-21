# Widget SDK

> 目标：给桌面工具窗口建立稳定的元数据、能力分层与窗口生命周期契约。
> 首版范围：**官方内置工具**（播放器 / 番茄钟 / 白噪音）。第三方窗口创建与原生调用不开放。

## 1. 当前实现

| 位置 | 职责 |
| --- | --- |
| `src/sdk/widget/types.ts` | Widget Manifest、窗口描述、能力枚举 |
| `src/widgets/registry.ts` | 设置页消费的内置工具元数据 |
| `src-tauri/src/window_host/spec.rs` | 窗口创建参数的唯一权威（尺寸/透明/缩放/能力） |
| `src-tauri/src/window_host/mod.rs` | 创建、复用、隐藏、兜底显示、IPC |
| `src-tauri/src/window_host/prefs.rs` | 全局「任务栏 + 最小化」偏好 |

两份清单（TS / Rust）目前有意保留：Rust 决定真实窗口行为，TS 决定设置页展示。新增工具时必须同时更新，并由两侧测试守护唯一性、能力白名单与尺寸约束。

## 2. Widget Manifest

```ts
type WidgetManifest = {
  schemaVersion: 1;
  type: "widget";
  id: string;                // 稳定 id，也是 widget_open 的参数
  name: string;              // 设置页显示名
  version: string;
  description?: string;
  author?: string;
  license: string;
  capabilities: WidgetCapability[];
  window: {
    label: string;           // Tauri 窗口 label
    route: string;           // 静态导出路由（不带前导斜杠）
    title: string;
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    resizable: boolean;
    transparent: boolean;
  };
  builtin: boolean;
};
```

示例（当前播放器）：

```json
{
  "schemaVersion": 1,
  "type": "widget",
  "id": "player",
  "name": "播放器",
  "version": "1.0.0",
  "license": "MIT",
  "capabilities": ["widget.ui", "widget.theme", "widget.state", "widget.audio", "widget.media"],
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
  },
  "builtin": true
}
```

## 3. 能力分层

| 能力 | 首期 | 说明 |
| --- | --- | --- |
| `widget.ui` | ✅ 内置 | WebView 内 UI / CSS / 动画 |
| `widget.theme` | ✅ 内置 | 读取全局主题流光变量 |
| `widget.state` | ✅ 内置 | 工具自己的 localStorage 命名空间 |
| `widget.audio` | ✅ 内置 | 播放环境声 / 媒体 |
| `widget.media` | ✅ 内置 | 在线曲目与本地媒体选择 |
| `widget.window` | ⚠️ 仅官方 | 创建 / 显示 / 隐藏系统窗口 |
| `widget.native` | ❌ | 调用 Win32 / 原生宿主 |

Rust `WidgetSpec.capabilities` 与 TS 清单保持同一枚举；`widget_states` 会返回每个工具的版本与能力，供未来设置页做兼容提示。

## 4. 窗口生命周期

1. 创建时 `visible(false)`、无边框、`shadow(false)`；前端 `useWindowFit` 贴合内容后再显示。
2. 已存在窗口再次 `widget_open` 只做 `show + unminimize + focus`，不重建 WebView。
3. 所有工具窗关闭 = `hide`；托盘「退出」才结束进程。
4. 透明浮窗（播放器 / 番茄钟 / 白噪音）固定尺寸、不可缩放，避免 Aero Snap 改变窗口。
5. 设置窗保留缩放；顶栏锁定按钮可动态关闭缩放。
6. 全局偏好关闭时，所有窗口不进任务栏、不可最小化；顶栏据此隐藏最小化按钮。
7. 前端贴合失败时，Rust 侧轮询兜底显示，避免窗口永远隐藏。

### 4.1 为什么第三方不能直接建窗

- 系统窗口是宿主能力，涉及 Z 序、焦点、任务栏、DPI 与桌面层；
- 窗口 label 也是 Tauri capability 的授权键，任意创建会扩大攻击面；
- 首版没有插件签名、权限声明与崩溃隔离。

未来的开放路径：内容包声明 `widget.window` 能力 → 宿主审核并代建受限窗口 → 只暴露白名单 API，而不是把 `WebviewWindowBuilder` 交给第三方。

## 5. 新增一个内置工具

清单：

1. `src/app/(widgets)/<route>/page.tsx` 增加路由。
2. `src/widgets/registry.ts` 增加 manifest（id/name/route/window/capabilities）。
3. `src-tauri/src/window_host/spec.rs` 增加 `WidgetSpec` 并加入 `ALL_WIDGETS`。
4. `src/app/(widgets)/layout.tsx` 确认透明/纸色外壳策略。
5. `src-tauri/capabilities/default.json` 的 `windows` 增加 label。
6. 托盘菜单 / 设置页是否展示（默认由 registry 自动展示）。
7. 跑 `pnpm test`、`cargo test`、`pnpm lint`。
8. 真机检查：打开 / 关闭 / 托盘唤醒 / 锁定 / 任务栏偏好 / 多屏。

> 不要只改其中一份清单。Rust 测试会校验 label/route 唯一性与能力白名单；TS 测试会校验尺寸与透明策略。

## 6. 状态与存储

- 工具状态使用 `lull:<tool>:*` 命名空间，禁止写宿主配置。
- 播放器：`lull:player:v1`
- 番茄钟：`lull:pomodoro:v1`
- 白噪音：`lull:noise:startup`
- 窗口锁定：`lull:window:locked`
- 主题流光：`lull:flow-theme`

未来的受限状态 API 应先做命名空间隔离与配额，再开放给内容包。

## 7. 非目标

- 不把内部 Tauri 命令直接暴露为公共插件 API；
- 不允许内容包执行任意 Rust 命令；
- 不允许内容包访问壁纸窗口或原生宿主；
- 不在首版实现工具市场、安装器或在线更新。
