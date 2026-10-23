# Widget SDK

> 面向第三方 Widget（工具窗口）插件作者：包结构 → 清单 → SDK 接入 → 能力边界。
> 插件是**静态 Web 包**，装到用户目录后由宿主创建独立窗口，运行在 `sandbox="allow-scripts"` 的
> 不透明源 iframe 里；所有宿主能力都通过 `@lull/widget-sdk` 走 postMessage 桥，由宿主校验后转发。
> 内置工具（播放器 / 番茄钟 / 白噪音 / 设置）走另一套编译期契约，见[与内置工具的关系](#与内置工具的关系)。

## 这是什么

一个 Widget 插件 = 一个静态站点 + 一份清单。宿主负责窗口、顶栏（或交给插件自绘）、主题令牌、
状态持久化与透明背景；插件只负责自己的 UI 与逻辑，不碰 Tauri IPC。

```text
widgets/<id>/
  widget.json      # 清单，必需
  index.html       # entry 指向的入口，必需
  assets/          # 构建产物，全部相对路径
```

运行模型：

```text
window label = widget-<id>
  └─ 宿主壳页                      # 拥有 Tauri IPC，只按清单与授权调命令
       ├─ chrome: "host"           # 宿主绘制顶栏：拖拽 / 最小化 / 关闭
       ├─ chrome: "custom"         # 不渲染顶栏，由插件自绘拖拽区与按钮
       └─ iframe（不透明源）        # 插件页面 + @lull/widget-sdk
```

### 能力词汇

清单里声明、宿主授权后生效：

| 能力 | 执行方式 | 说明 |
| --- | --- | --- |
| `widget.ui` | 声明 | iframe 内 UI / CSS / 动画 |
| `widget.theme` | 软约束 | 宿主下发流光令牌；插件可以忽略 |
| `widget.state` | 硬隔离 | Rust 侧 KV；按窗口 label 推导插件 id，消息里的 id 不被信任 |
| `widget.audio` | 软约束 | 宿主只返回是否同意；未授权时静音运行 |
| `widget.media` | 软约束 | 导入本地媒体前检查 |
| `widget.network` | 硬约束 | 只有清单声明的 `https://` 源会进 CSP |
| `widget.chrome` | 硬约束 | 拖动 / 最小化 / 关闭 / 切换透明**自己的**窗口；`chrome: "custom"` 时必须声明 |

`widget.window`（创建或控制其他窗口）与 `widget.native`（Win32 / 原生宿主）**不可申请**。

### 与内置工具的关系

这是两套并行契约，不是子集关系：

| 维度 | 内置工具（Host SDK） | 第三方插件（本文） |
| --- | --- | --- |
| 信任级 | 与宿主同级 | 不可信静态代码 |
| 清单 | `src/widgets/manifests/*.json`，编译期注册 | 包内 `widget.json`（schemaVersion 2） |
| SDK | `src/sdk/widget` | `@lull/widget-sdk` |
| 状态 | 同源 `localStorage` | Rust KV（`.state/<id>.json`） |
| 窗口 | 宿主创建，可调宽 / 换边 | 宿主创建，只能操作自己的窗口，不能调宽 / 换边 |

共享的只有**能力词汇、主题令牌、宿主建窗、关闭即隐藏**这几个概念。写插件按本文来，
不要照抄内置工具的做法，也不要把内置组件原样丢进插件包。

## 如何使用

### 1. 写清单

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "community-pomodoro",
  "name": "番茄钟",
  "version": "1.0.0",
  "description": "专注计时",
  "author": "Lull",
  "license": "MIT",
  "builtin": false,
  "hostApi": 1,
  "entry": "index.html",
  "icon": "assets/icon.png",
  "lifecycle": "background",
  "capabilities": ["widget.theme", "widget.state", "widget.audio", "widget.chrome"],
  "window": {
    "width": 560,
    "height": 680,
    "minWidth": 520,
    "minHeight": 620,
    "resizable": false,
    "transparent": true,
    "chrome": "custom"
  },
  "network": []
}
```

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 固定 `2`，不兼容直接拒绝 |
| `type` | 固定 `widget` |
| `id` | 与目录名一致，格式 `^[a-z][a-z0-9-]{1,31}$` |
| `version` | `MAJOR.MINOR.PATCH` |
| `builtin` | 用户包必须 `false` |
| `hostApi` | 当前宿主只接受 `1` |
| `entry` | 包内相对 `.html`；禁止 `..`、反斜杠、百分号编码与绝对路径 |
| `icon` | 可选，包内 `.png` / `.jpg` / `.jpeg` / `.webp` |
| `lifecycle` | `background`（默认，关闭只隐藏）或 `suspend`（关闭即销毁窗口） |
| `capabilities` | 只能申请上表的 7 个 |
| `window.width/height` | 320×240 – 1600×1200；`minWidth/minHeight` 不得大于初始值 |
| `window.resizable` | 首期固定 `false`，窗口尺寸由宿主决定 |
| `window.transparent` | 初始是否透明（默认 `true`），运行时可用 `setTransparent` 切换 |
| `window.chrome` | `host`（默认，宿主绘制顶栏）或 `custom`（插件自绘）；`custom` 必须同时申请 `widget.chrome` |
| `network` | 允许的 `https://` 源；非空时必须同时申请 `widget.network` |

### 2. 接入 SDK

`@lull/widget-sdk` 是插件侧唯一受支持的宿主入口，提供四个入口：
`.`（无框架依赖）、`./react`、`./vue`、`./testing`（内存传输，只给单测用）。
完整 API、桥方法与错误码见 [`packages/widget-sdk/README.md`](../packages/widget-sdk/README.md)。

原生：

```js
import { connectLullWidget } from "@lull/widget-sdk";

const lull = await connectLullWidget();

// 宿主 KV：关闭窗口、重启应用后仍在
const prefs = await lull.getState("prefs", { focusMinutes: 25 });
await lull.setState("prefs", { ...prefs, focusMinutes: 50 });

// 主题与视口：订阅会立刻回放当前值
lull.onTheme((theme) => applyTheme(theme));
lull.onViewport(({ width, height }) => layout(width, height));

if (lull.has("widget.audio") && (await lull.requestAudio())) {
  // 可以创建音频上下文
}

// chrome: "custom" 时自绘窗口按钮，拖拽区位置与样式完全由插件 CSS 决定
document.querySelector(".my-drag-region")?.addEventListener("pointerdown", (event) => {
  if (event.button === 0) void lull.startDrag();
});
document.querySelector(".my-minimize")?.addEventListener("click", () => void lull.minimize());
document.querySelector(".my-close")?.addEventListener("click", () => void lull.close());

await lull.setTransparent(false, "#0b1014"); // 不透明并指定背景色
```

React：

```tsx
import { connectLullWidget } from "@lull/widget-sdk";
import { LullProvider, useLullState, useLullTheme } from "@lull/widget-sdk/react";

const client = await connectLullWidget();

function Timer() {
  const [prefs, setPrefs] = useLullState("prefs", { focusMinutes: 25 });
  const theme = useLullTheme();
  return <button onClick={() => setPrefs({ ...prefs, focusMinutes: 50 })}>{prefs.focusMinutes}</button>;
}

createRoot(root).render(
  <LullProvider client={client}>
    <Timer />
  </LullProvider>,
);
```

Vue 3：

```js
import { createLullPlugin, useLullState } from "@lull/widget-sdk/vue";

app.use(createLullPlugin(client));
const prefs = useLullState("prefs", defaults);
```

常用成员：`getState` / `setState` / `removeState`、`theme` / `onTheme`、`viewport` / `onViewport`、
`onVisibility`、`has(cap)`、`requestAudio()`、`startDrag()` / `minimize()` / `setTransparent()` / `close()`、
`log()`、`destroy()`。错误统一抛 `LullWidgetError`，按 `code` 分支，不要匹配文案。

### 3. 构建与安装

```powershell
pnpm widgets:sdk              # 构建 @lull/widget-sdk（dist + 类型声明）
pnpm widgets:samples:build    # 构建 examples/widgets/*/dist
pnpm widgets:samples:install  # 复制到 %APPDATA%\app.lull.desktop\widgets
pnpm widget:pack <dir>        # 把构建好的目录打成 .lull-widget.zip
```

用户侧：设置 → 扩展，把 `.zip` 拖进窗口或点「从文件安装」。安装只解包并校验清单，
**不执行插件代码**；启用时才按清单声明的能力授权。

开发时：在设置 → 扩展底部开启「开发模式」，选择含 `widget.json` 的项目根目录。
不复制文件、不锁摘要，改完点卡片上的「重载」即可。

### 4. 示例工程

三个示例覆盖三套技术栈，直接对照着改最快：

| 示例 | 技术栈 | 位置 |
| --- | --- | --- |
| `pomodoro-js` | 原生 TypeScript | `examples/widgets/pomodoro-js` |
| `pomodoro-react` | React | `examples/widgets/pomodoro-react` |
| `pomodoro-vue` | Vue 3 | `examples/widgets/pomodoro-vue` |

## 需要注意

### 运行环境

iframe 不带 `allow-same-origin`，是一个**不透明源**：

- 拿不到宿主 DOM、`localStorage` / `sessionStorage` / IndexedDB / Cookie，也没有 Service Worker；
- 不能通过 `window.parent` 访问宿主壳页；
- 所有宿主能力只能走 SDK 封装的 postMessage 桥。WebView2 会把 Tauri 初始化脚本注入子帧，
  插件里仍可能看到 `__TAURI_INTERNALS__`，但**它不是受支持的 API**，直接调用属于未定义行为；
- 不透明源的 `event.origin` 是 `"null"`，不要依赖 origin 做校验。

### 产物约定

1. 单入口 HTML，所有资源使用相对路径（`base: './'`），不能依赖站根路径；
2. 路由用 hash，不要操作 `window.top`；
3. 不加载远程脚本 / 字体 / 样式，需要外部 API 时在清单 `network` 里声明 `https://` 源；
4. 不 import `@tauri-apps/api`；
5. 不要依赖运行时 `eval`（Vue 运行时模板、部分热重载运行时会失败）；
6. 内联脚本会被宿主注入 nonce 后放行，**内联事件处理器（`onclick=`）不可用**，请用 `addEventListener`；
7. 单包建议 < 5 MB。

### 状态

- 键：1–64 字符，允许字母、数字、`.`、`_`、`-`；
- 单值 ≤ 32 KiB，单插件总量 ≤ 256 KiB（UTF-8 JSON）；
- 撤销授权或卸载时清空，停用保留，没有迁移机制。

### 窗口与透明

- 窗口尺寸由清单与宿主决定，`resize.request` 只是探测，不会真的改尺寸；
- 关闭窗口 = 隐藏（Alt+F4 同样只隐藏），进程继续驻留托盘；
- `window.transparent` 只决定**初始**背景，运行时用 `lull.setTransparent` 切换，不会重建窗口或刷新插件；
- 透明是 WebView 背景色，不改变窗口尺寸或阴影，Windows 下透明窗口没有原生阴影；
- **透明窗口不要给 `:root` / `html` 设置 `color-scheme: dark`**：WebView2 会把 iframe 的默认画布
  画成不透明深色，`background: transparent` 也看不穿桌面。需要深色控件时把它放到局部容器。

### 能力边界

- 声明不等于授权：启用时按清单授权，之后用户可逐项撤销；撤销 `widget.chrome` 会回退到宿主顶栏；
- 音频 / 媒体是产品策略，不是安全沙箱——CSP 无法阻止 iframe 自己发声或选择文件；
- 网络授权是整体开关，不支持按源逐个授权；撤销后需停止并重开插件，当前页面才会收紧 CSP。

### 已知限制

- 没有发布者签名、在线目录与自动更新；手动复制目录仍可用，但只会标记为“未校验”，
  首次启用时生成本地摘要锁；
- 插件窗口固定尺寸，不能创建或控制其他窗口；
- 没有崩溃隔离（iframe 崩溃时宿主壳保留，可重载）；
- Next.js / Nuxt 非官方支持（产物含内联 bootstrap 与绝对路径），需要 SSR 或服务端的不适用。
