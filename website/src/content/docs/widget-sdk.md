---
title: Widget SDK(Beta)
description: 这里介绍如何用 Widget SDK 写一个工具窗口组件。
order: 4
group: 扩展开发
source: docs/widget-sdk.md
---

>当前仍处于 **Beta 测试阶段**，我们会尽力保持各版本之间的向后兼容性，如有重大变更会提前在社区公告。

Widget 插件 = 一个 Web 包 + 一份清单。装到用户目录后，宿主为它创建一个独立窗口。  

## 包结构

```text
widgets/<id>/
  widget.json      # 清单，必需
  index.html       # 入口，必需
  assets/          # 构建产物，全部相对路径
```

宿主提供：窗口与顶栏（或交给插件自绘）、主题令牌、状态 KV、透明背景。插件本身不碰 Tauri IPC。

## 清单字段

`widget.json` 放在包根，描述插件的身份、窗口与能力：

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "community-pomodoro",
  "name": "番茄钟",
  "version": "1.0.0",
  "license": "MIT",
  "builtin": false,
  "hostApi": 1,
  "entry": "index.html",
  "capabilities": ["widget.theme", "widget.state", "widget.audio", "widget.chrome"],
  "window": {
    "width": 560,
    "height": 680,
    "resizable": false,
    "transparent": true,
    "chrome": "custom"
  },
  "network": []
}
```

要点：

- `id` 与目录名一致（`^[a-z][a-z0-9-]{1,31}$`）；
- `entry` 是包内相对 `.html`；
- 窗口 320×240 – 1600×1200，`resizable` 首期固定 `false`；
- `chrome: "custom"` 表示插件自绘拖拽区与按钮，必须同时申请 `widget.chrome`。

## 版本与兼容约定

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 固定 `2`；不是 `2` 的清单直接拒绝，不做旧格式迁移 |
| `version` | `MAJOR.MINOR.PATCH` 语义化版本，格式不对即拒绝；同 id 的新版本不能直接覆盖安装 |
| `hostApi` | 当前宿主只接受 `1`；`0` 或高于宿主支持值的清单直接拒绝 |
| `builtin` | 用户包必须 `false`；`true` 只留给编译期注册的内置工具 |
| `id` | 与目录名一致，发布后不改名；改名等于另一个插件，授权与状态不会跟过去 |

清单校验在文件落地前执行，任一不满足则拒绝安装（`manifest.field-invalid`），不留半成品目录  
同 id 重复安装报 `manifest.id-conflict`，需先卸载（卸载会清除授权与状态 KV，升级等同重装，无数据迁移机制）

宿主扫描插件目录的容错规则：
- 清单非法：「扩展」页标记 `invalid`（附原因），不建窗
- 安装后文件被篡改：标记 `tampered` 并跳过
- 手动拷入、无摘要记录：标记「未校验」
- `.staging-*`/`.replaced-*` 等点号目录、缺 `widget.json` 的目录：不参与扫描


## 能力词汇

| 能力 | 说明 |
| --- | --- |
| `widget.ui` | iframe 内 UI / CSS / 动画 |
| `widget.theme` | 只读流光令牌，不能改全局主题 |
| `widget.state` | Rust 侧 KV，按窗口隔离 |
| `widget.audio` | 未授权时静音运行 |
| `widget.media` | 导入本地媒体前检查 |
| `widget.network` | 只放行清单 `network` 里声明的 `https://` 源 |
| `widget.chrome` | 拖动 / 最小化 / 关闭 / 切换透明**自己的**窗口 |

> `sandbox="allow-scripts"` 可以控制插件页面跑在窗口内的透明模式。   
> 通过`@lull/widget-sdk`，所有宿主能力都走`postMessage`桥，由宿主校验后转发。

## 与内置工具的关系

内置工具（播放器 / 番茄钟 / 白噪音 / 设置）走的是另一套编译期契约。  
状态后端与信任模型都不同。写插件按本文来，不要照抄内置工具的做法。

## 接入 SDK

`@lull/widget-sdk` 有四个入口：`.`、`./react`、`./vue`、`./testing`。

```js
import { connectLullWidget } from "@lull/widget-sdk";

const lull = await connectLullWidget();

const prefs = await lull.getState("prefs", { focusMinutes: 25 }); // 宿主 KV
await lull.setState("prefs", { ...prefs, focusMinutes: 50 });

lull.onTheme(applyTheme);
lull.onViewport(({ width, height }) => layout(width, height));

if (lull.has("widget.audio") && (await lull.requestAudio())) { /* … */ }

await lull.setTransparent(false, "#0b1014"); // 切换窗口背景
```

React 用 :  
`<LullProvider client>` + `useLullState` / `useLullTheme`  
Vue 3 用:  
`app.use(createLullPlugin(client))` + `useLullState` / `useLullTheme`



## 开发工具

```powershell
pnpm widgets:sdk              # 构建 @lull/widget-sdk（dist + 类型声明）
pnpm widgets:samples:build    # 构建 examples/widgets/*/dist
pnpm widgets:samples:install  # 装到本地用户目录
pnpm widget:pack <dir>        # 打成 .lull-widget.zip
```

用户侧在设置 → 扩展拖入 zip 或点「从文件安装」：安装只解包并校验清单，**不执行插件代码**；
启用时才按清单声明能力授权。开发时开启「开发模式」并指向含 `widget.json` 的项目根目录，
不复制文件，改完点「重载」。

## 安全边界与限制

### 运行环境

iframe 是不透明源，拿不到宿主 DOM、`localStorage` / `sessionStorage` /
IndexedDB / Cookie，也没有 Service Worker，不能通过 `window.parent` 访问宿主。插件里可能仍能看到
`__TAURI_INTERNALS__`，但它不是受支持的 API。

### 产物

单入口 HTML，资源全部相对路径；路由用 hash；不加载远程脚本 / 字体 / 样式
（外部 API 要写进 `network`）；不 import `@tauri-apps/api`；不依赖运行时 `eval`
（Vue 请用 render 函数）；内联脚本可用，`onclick=` 这类内联事件处理器不可用；单包建议 < 5 MB。

### 状态

键 1–64 字符（字母数字与 `.` `_` `-`），单值 ≤ 32 KiB，单插件总量 ≤ 256 KiB；
撤销授权或卸载即清空，停用保留，没有迁移机制。

### 窗口

尺寸由清单与宿主决定，`resize.request` 只探测不改尺寸；关闭 = 隐藏，进程驻留托盘；
透明只影响背景色，Windows 下没有原生阴影。

> 透明窗口不要给 `:root` / `html` 设置 `color-scheme: dark`，否则 WebView2 会把 iframe 画成不透明深色。

### 授权

声明不等于授权，启用后用户可逐项撤销；撤销 `widget.chrome` 会回退到宿主顶栏。
音频 / 媒体是产品策略而非安全沙箱；网络授权是整体开关，撤销后需重开插件才收紧 CSP。

### 已知限制

没有签名、在线目录与自动更新（手动放目录只会标记为“未校验”）；
不能创建或控制其他窗口；没有崩溃隔离（可重载）；Next.js / Nuxt 与需要 SSR 的方案不适用。

## 参考

- 可直接安装的示例：`examples/widgets/pomodoro-js`（原生）、`pomodoro-react`（React）、
  `pomodoro-vue`（Vue 3）。
- 字段级规范：[Widget SDK](https://github.com/Lull-Desktop/Lull/blob/master/docs/widget-sdk.md) ·
  [`@lull/widget-sdk` 说明](https://github.com/Lull-Desktop/Lull/blob/master/packages/widget-sdk/README.md)。
