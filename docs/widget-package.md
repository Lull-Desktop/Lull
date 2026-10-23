# Widget 插件包格式与宿主桥协议

> 状态：v1 已落地。用户插件以**静态 Web 包**安装到
> `%APPDATA%\app.lull.desktop\widgets\<id>\`，由宿主创建独立窗口，
> 在 `sandbox="allow-scripts"` 的不透明源 iframe 中运行。
>
> 安装器、扩展中心与包完整性已落地基础版本：见 [扩展中心设计](./extension-center.md)。
> 包完整性使用旁路 `.lull-integrity.json`；本文的包结构、清单与权限模型保持不变。
>
> 首期不官方支持 Next.js / Nuxt（产物依赖内联脚本与绝对路径），
> 播放器继续作为内置工具，不做插件化。

## 0. 与官方内置 Widget Host SDK 的关系

这是**两套并行的契约**，不是“第三方插件自动满足内置 Host SDK”或反过来：

| 维度 | 官方内置工具（Host SDK） | 第三方插件（本文件） |
| --- | --- | --- |
| 信任级 | 与宿主同信任 | 不可信静态代码 |
| 注册 | 编译期 `src/widgets/manifests/*.json`（schema 1） | 用户目录静态包（schema 2） |
| UI 运行时 | 同源 `(widgets)` 路由 | 不透明源 iframe |
| SDK | `src/sdk/widget` | `packages/widget-sdk` |
| 状态 | `localStorage` | Rust KV（`.state/<id>.json`） |
| 窗口 | 宿主创建，`core:default` | 宿主创建，无 `core:default` |
| Chrome | 自绘 + `widget.chrome` 可调宽/换边 | 自绘（`chrome:custom`）或宿主顶栏（`host`）；不能调宽/换边 |
| 原生能力 | 受 capability 门禁的宿主命令 | 只能走 iframe 白名单桥 |

共享的只有**能力词汇、主题令牌、宿主建窗、关闭即隐藏**这些概念；清单格式、SDK API、状态后端和信任模型都不同。

结论：

- **官方已有的内置 Widget 仍按 Host SDK 运行**；本次修复 `__LULL_WIDGET__` 注入后，关闭、音频、媒体能力恢复正常。
- **第三方插件标准不是 Host SDK 的子集**，而是一个受限的并行契约；不能把内置组件原样丢进插件包，也不能用插件 SDK 替代 `src/sdk/widget`。
- 同名能力 `widget.chrome` 在两套契约里操作范围不同：内置可调宽/换边，插件只允许自己的拖拽/最小化/关闭/透明。
- 如果要求“所有 Widget 必须符合同一套开发标准”，当前实现**尚未统一**；需要先定义共享的 Widget Contract profile，再把两套实现都映射进去。

## 1. 包结构

```text
widgets/<id>/
  widget.json            # 清单，必需
  .lull-integrity.json   # 可选：本地摘要锁（安装/首次启用时生成）
  index.html             # entry 指向的入口，必需
  main.js                # 构建产物（文件名任意，相对引用）
  style.css              # 可选
  assets/                # 可选；全部相对路径
```

约束：

- `id` 必须与目录名一致，格式 `^[a-z][a-z0-9-]{1,31}$`；
- `entry` 必须是包内相对 `.html` 路径，禁止 `..`、反斜杠、百分号编码与绝对路径；
- 所有资源使用相对路径（`base: './'`），不能依赖站根路径；
- 不加载远程脚本/字体/样式；需要外部 API 时在清单里声明 `network`；
- 单包建议 < 5 MB；状态总量上限 256 KiB。

安装：在设置 → 扩展里点「从文件安装」选择 `.zip`（或拖入设置窗），
安装器校验清单、包结构、摘要与许可后写入上述路径；也可以手动复制目录后点「刷新」。
示例安装命令：

```powershell
pnpm widgets:samples:build
pnpm widgets:samples:install
```

## 2. 清单 v2

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
  "capabilities": [
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.chrome"
  ],
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
| `schemaVersion` | 固定 `2`；不兼容直接拒绝 |
| `type` | 固定 `widget` |
| `id` | 与目录名一致；小写字母/数字/连字符 |
| `version` | `MAJOR.MINOR.PATCH` |
| `builtin` | 用户包必须为 `false`；`true` 只允许官方编译期清单 |
| `hostApi` | `1`–`1`（当前宿主）；超出范围拒绝 |
| `entry` | 包内相对 `.html` |
| `icon` | 可选；包内 `.png` / `.jpg` / `.jpeg` / `.webp`，≤ 128 字符路径 |
| `lifecycle` | `background`（默认，关闭只隐藏）或 `suspend`（关闭即销毁窗口） |
| `capabilities` | 只能申请 `widget.ui` / `theme` / `state` / `audio` / `media` / `network` / `chrome` |
| `window.width/height` | 320×240 – 1600×1200；`minWidth/minHeight` 不得大于初始值 |
| `window.resizable` | 首期固定 `false`（窗口尺寸由宿主决定） |
| `window.transparent` | 初始是否透明（默认 `true`）；运行时可用 `setTransparent` 切换 |
| `window.chrome` | `host`（默认，宿主绘制顶栏）或 `custom`（插件自绘拖拽区/按钮）；`custom` 必须同时申请 `widget.chrome` |
| `network` | 允许的 `https://` 源；非空时必须同时申请 `widget.network` |

`window` / `native` **不可申请**：插件不能创建或控制其他窗口。
`widget.chrome` 只覆盖当前插件窗口的拖动、最小化、关闭，不允许创建窗口或调整其他窗口。

## 3. 能力与授权

| 能力 | 执行方式 | 说明 |
| --- | --- | --- |
| `widget.ui` | 声明 | iframe 内 UI/CSS/动画 |
| `widget.theme` | 软约束 | 宿主通过 `theme` 消息下发令牌；插件可以忽略 |
| `widget.state` | 硬隔离 | Rust KV；按窗口 label 推导 id，消息里的 id 不被信任 |
| `widget.audio` | 软约束 | 宿主只返回同意结果；iframe 仍可自行创建 AudioContext |
| `widget.media` | 软约束 | 文件选择由浏览器处理；需要持久化时用状态 KV 或后续 `media.pick` |
| `widget.network` | 硬约束 | 只有实际授予时才把清单声明的源放进 `connect-src` |
| `widget.chrome` | 硬约束（宿主壳） | 允许 iframe 请求拖动/最小化/关闭/切换透明**自己的**窗口；撤销后回退宿主顶栏；不能创建或控制其他窗口 |

启用 = 按清单声明授权，之后可逐项撤销；停用 = 销毁窗口、保留文件与状态；
卸载 = 删除文件、授权和状态。音频/媒体是**产品策略**，不是安全沙箱：
CSP 与 sandbox 都无法阻止 iframe 自己发声或选择文件。

## 4. 运行时模型

```text
window label = widget-<id>
  ├─ 宿主壳页 /embed           # React，拥有 Tauri IPC
  │    ├─ chrome=host：顶栏：拖拽 / 最小化 / 关闭（宿主绘制）
  │    ├─ chrome=custom：不渲染顶栏，由插件自绘拖拽区与按钮
  │    └─ <iframe sandbox="allow-scripts" src="http://lullwidget.localhost/<id>/<entry>">
  │           └─ 插件页面 + @lull/widget-sdk
  └─ capability: window-widgets.json（widget-*）
       └─ core 窗口权限 + allow-widget-state-get/set/remove
```

- iframe **不带 `allow-same-origin`**：拿不到宿主 DOM、localStorage、Cookie、IndexedDB；
  Tauri internals 虽会被 WebView2 注入子帧，但 ACL 只授予该窗口的最小命令（见 6.3）；
- 宿主壳页只根据清单与授权调用 `widget_state_*`，绝不 eval 插件消息；
- `chrome: "custom"` 时插件通过 `window.startDrag` / `window.minimize` / `window.setTransparent` / `close` 控制自己的窗口；
  拖拽区的位置、形状、悬停样式全部由插件 CSS 决定，宿主不注入固定 topbar；
- 关闭窗口 = 隐藏；Alt+F4 同样只隐藏；custom chrome 下仍可用托盘退出；
- 窗口尺寸固定，插件通过 `viewport` 消息适配内容。

### 4.1 透明背景

插件窗口始终以透明 WebView 创建，`window.transparent` 只决定**初始**背景：

- `true`：初始全透明；
- `false`：初始为宿主纸张色 `#f6f3ec`。

运行时通过 `window.setTransparent`（SDK：`lull.setTransparent`）切换，不会重建窗口或刷新插件：

```js
await lull.setTransparent(false, "#0b1014"); // 不透明，指定背景色
await lull.setTransparent(true);             // 回到透明
```

宿主壳会同步设置窗口/壳背景；SDK 还会给 `html/body` 设置同色背景，保证 iframe 的透明区域也一起变成不透明。
直接用 postMessage 的插件需要自己处理 iframe 文档背景，否则只能看到宿主壳背景。
`color` 支持 `#rrggbb` / `#rrggbbaa`，缺省为 `#f6f3ec`。

> **透明窗口不要给 `:root` / `html` 设置 `color-scheme: dark`。**
> WebView2 会把 iframe 的默认 canvas 画成不透明深色，即使 `background: transparent` 也看不穿桌面。
> 需要深色表单控件时，把 `color-scheme: dark` 放到局部容器，或保持 `color-scheme: normal`。

## 5. postMessage 协议 v1

所有消息都是普通对象，`v: 1`。宿主只接受 `event.source === iframe.contentWindow` 的消息；
不透明源的 `event.origin` 是 `"null"`，不能依赖 origin 校验。

### 5.1 握手

```text
iframe 加载 → plugin: { v:1, type:"ready", protocol:1 }
host         → plugin: { v:1, type:"init", ..., token }
```

`init` 载荷：

```json
{
  "v": 1,
  "type": "init",
  "protocol": 1,
  "hostApi": 1,
  "id": "community-pomodoro",
  "name": "番茄钟",
  "version": "1.0.0",
  "granted": ["widget.theme", "widget.state", "widget.audio", "widget.chrome"],
  "requested": ["widget.theme", "widget.state", "widget.audio", "widget.chrome"],
  "theme": { "id": "amber", "colors": { "a": "#ffd179", "accentDark": "#ffd179" } },
  "viewport": { "width": 560, "height": 640, "dpr": 1.25 },
  "minimizable": true,
  "window": {
    "chrome": "custom",
    "transparent": true
  },
  "token": "per-session-random"
}
```

插件必须在后续每个请求里回传 `token`。宿主对不匹配的请求直接丢弃。

### 5.2 宿主 → 插件

| 消息 | 载荷 | 时机 |
| --- | --- | --- |
| `theme` | `{ theme }` | 全局主题变化 |
| `viewport` | `{ viewport: { width, height, dpr } }` | iframe 尺寸变化 |
| `visibility` | `{ visible: boolean }` | 窗口显示/隐藏 |
| `response` | `{ id, ok, result?, error? }` | 请求响应 |

### 5.3 插件 → 宿主

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `state.get` | `{ key }` | `{ value }`（不存在为 `null`） |
| `state.set` | `{ key, value }` | `{ saved: true }` |
| `state.remove` | `{ key }` | `{ removed: true }` |
| `audio.request` | `{}` | `{ granted: boolean }` |
| `window.startDrag` | `{}` | `{ dragging: true }`；需要 `widget.chrome` |
| `window.minimize` | `{}` | `{ minimized: true }`；需要 `widget.chrome` |
| `window.setTransparent` | `{ transparent, color? }` | `{ transparent }`；需要 `widget.chrome`；`color` 为 `#rrggbb`/`#rrggbbaa` |
| `close` | `{}` | `{ closed: true }` |
| `resize.request` | `{ width, height }` | 当前视口；首期固定尺寸，`applied: false` |
| `log` | `{ level, message }` | `{ logged: true }` |

错误码：`denied` / `unsupported` / `invalid` / `quota` / `internal`；宿主返回的 `error` 是可直接展示的字符串。

### 5.4 状态规则

- 键：1–64 字符，允许字母、数字、`.`、`_`、`-`；
- 单值 ≤ 32 KiB，总体 ≤ 256 KiB（UTF-8 JSON）；
- 存储路径 `%APPDATA%\app.lull.desktop\widgets\.state\<id>.json`，原子写；
- 撤销或卸载时清空；禁用时保留。

## 6. CSP / CORS / 路径规则

插件资源由 Rust 自定义协议 `lullwidget` 提供：

- Windows: `http://lullwidget.localhost/<id>/<entry>`
- 其他平台: `lullwidget://localhost/<id>/<entry>`

### 6.1 路径

- 只允许包内相对路径；`..`、`.`、空段、反斜杠、`%`、NUL 直接 400；
- 规范化路径必须仍在包目录内，防符号链接逃逸；
- 目录/空路径回退到 `entry`。

### 6.2 响应头

```text
Content-Security-Policy: default-src http://lullwidget.localhost;
  script-src http://lullwidget.localhost 'nonce-<random>';
  style-src http://lullwidget.localhost 'unsafe-inline';
  img-src http://lullwidget.localhost data: blob:;
  media-src http://lullwidget.localhost blob: data:;
  font-src http://lullwidget.localhost data:;
  connect-src http://lullwidget.localhost [network 白名单];
  worker-src http://lullwidget.localhost blob:;
  frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

- HTML 内的 `<script>` 会被注入 nonce 后再返回；**内联脚本允许，内联事件处理器（`onclick=`）不允许**；
- iframe 是不透明源，ES module / fetch 按 CORS 处理，因此资源响应必须带 `Access-Control-Allow-Origin`；
- `connect-src` 默认只允许包自身；外部 API 必须写进 `network` 并由用户授权；
- 主窗口 CSP 的 `frame-src` 需要允许插件协议（已配置 `http://lullwidget.localhost`）。

### 6.3 已知限制：子帧里的 Tauri internals

WebView2 会把 Tauri 的初始化脚本应用到子帧，因此插件 iframe 里仍然能看到
`window.__TAURI_INTERNALS__` 和 `isTauri`。当前的处理：

- 插件窗口（`widget-*`）的 capability **不包含 `core:default`**，只允许自身状态命令与
  show/hide/minimize/focus/start-dragging；
- 状态命令按窗口 label 推导插件 id，插件无法读写其他插件或宿主配置；
- 子帧里的 `invoke` 没有注册回调，调用会挂起而不是返回结果（不要依赖它）；
- **受支持的插件 API 仍然只有 postMessage 桥**，直接调用 internals 属于未定义行为。

后续可评估的方向：在主帧与子帧之间引入一次性 session token，让状态命令只接受宿主壳的调用。

## 7. 框架支持

| 框架 | 预期 | 说明 |
| --- | --- | --- |
| 原生 JS / Web Components | ✅ | 最稳，示例 `pomodoro-js`（自绘 chrome + 透明切换） |
| React | ✅ | 示例 `pomodoro-react`（自绘 chrome + 透明切换）；通过 `@lull/widget-sdk/react` |
| Vue 3 | ✅ | 示例 `pomodoro-vue`（自绘 chrome + 透明切换）；使用 render 函数，不用运行时模板（`eval` 被 CSP 禁止） |
| Svelte / Solid / Preact | ✅ | 任意静态 SPA 产物，按同一契约即可 |
| Next.js | ⚠️ 非首期官方支持 | 静态导出含内联 bootstrap、`/_next` 绝对路径；需要宿主重写资源前缀与 CSP 后才能评估 |
| Nuxt | ⚠️ 非首期 | 运行时配置内联脚本 + 路径假设 |
| SSR / 需要服务端 | ❌ | iframe 只有静态资源 |

框架无关的产物约定：

1. 单入口 HTML，所有资源相对路径；
2. 不使用 `localStorage` / `sessionStorage` / IndexedDB / Cookie / Service Worker（不透明源不可用）；
3. 路由用 hash；不要操作 `window.top`；
4. 不 import `@tauri-apps/api`，所有宿主能力走 SDK；
5. 构建产物不要依赖运行时 `eval`（Vue 运行时模板、部分热重载运行时会失败）；
6. 字体/图标/图片全部本地。

## 8. 插件 SDK

包名：`@lull/widget-sdk`（本仓库 `packages/widget-sdk`）。

TypeScript 源码 + `tsc` 产物：`dist/*.js` 与 `dist/*.d.ts`（类型声明随包发布，不手写）。
四个入口：`.`（客户端）、`./react`、`./vue`、`./testing`（内存传输，只给测试用）。
安装、完整 API 表与兼容矩阵见 [`packages/widget-sdk/README.md`](../packages/widget-sdk/README.md)。

```js
import { connectLullWidget } from "@lull/widget-sdk";

const lull = await connectLullWidget();
const prefs = await lull.getState("prefs", { focusMinutes: 25 });
lull.onTheme((theme) => applyTheme(theme));
lull.onViewport(({ width, height }) => layout(width, height));
await lull.setState("prefs", next);
await lull.requestAudio();

// chrome: "custom"：在 pointerdown 里触发，位置/样式完全由插件 CSS 决定
document.querySelector(".my-drag-region")?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  void lull.startDrag();
});
document.querySelector(".my-minimize")?.addEventListener("click", () => void lull.minimize());
document.querySelector(".my-close")?.addEventListener("click", () => void lull.close());
await lull.setTransparent(false, "#0b1014"); // 不透明，指定背景色
await lull.setTransparent(true);             // 透明
```

React：

```jsx
<LullProvider client={client}>
  <Timer />
</LullProvider>
const [prefs, setPrefs] = useLullState("prefs", defaults);
const theme = useLullTheme();
```

Vue：

```js
app.use(createLullPlugin(client));
const prefs = useLullState("prefs", defaults);
const theme = useLullTheme();
```

SDK 只做协议封装，不做权限判断；权限永远由宿主桥校验。
`setTransparent` 会同时更新宿主壳与插件文档背景；`transparent` 状态也可从 `client.transparent` 读取。

## 9. 构建与校验

示例源码为 TypeScript（`src/main.ts` / `src/main.tsx`），由 esbuild 打包为单文件 ESM：

```powershell
pnpm widgets:sdk               # 先构建 SDK（dist + 类型声明）
pnpm widgets:samples:build     # 构建 examples/widgets/*/dist（内部会先跑 widgets:sdk）
pnpm widgets:samples:install   # 复制到 %APPDATA%\app.lull.desktop\widgets
pnpm widgets:sdk:check         # 只做类型检查（CI）
```

示例按包名 `@lull/widget-sdk[/react|/vue]` 导入；`scripts/build-widget-examples.mjs` 的解析插件
优先取 `dist/`，未构建时回落到 TS 源码，保证示例写法与第三方消费方式一致。
示例源码同时在根 `pnpm typecheck` 的覆盖范围内（`tsconfig.json` 为 SDK 配了 paths 映射），
所以示例与 SDK 的类型契约漂移会在 CI 直接暴露。

插件作者侧建议（后续提供 CLI）：

1. 任意静态构建工具产出 `dist/`；
2. 生成/校验 `widget.json`；
3. 检查产物：entry 存在、无绝对路径、无远程 URL、无 `localStorage`/`@tauri-apps/api`；
4. 打包 zip（安装器已支持；签名与自动更新待做）。

## 10. 已知边界

- 本地安装器已落地（扩展中心：选择 zip / 拖拽 / 预览确认）；没有签名、在线目录与自动更新；
  手动复制目录仍可用，但只会标记为“未校验”，首次启用时生成本地摘要锁；
- 网络授权是整体开关，不支持按源逐个授权；撤销后需停止并重开，当前页面才会收紧 CSP；
- 音频/媒体不是硬权限；
- 状态没有迁移 DSL；卸载即清空，停用保留；
- 插件窗口固定尺寸，不能创建其他窗口；`chrome: "custom"` 允许自绘拖拽区与窗口按钮；
- 透明是 WebView 背景色，不改变窗口尺寸/阴影；Windows 下透明窗口无原生阴影；
- 最多 256 KiB 状态与单值 32 KiB 上限；
- 未做崩溃隔离（iframe 崩溃时宿主壳保留，可重载）；
- 子帧仍能看到 Tauri internals（见 6.3），ACL 已将权限压到最小。

## 11. 验收清单

- [ ] 包目录 id 与清单一致，entry 可加载；
- [ ] 未声明的能力调用被宿主拒绝；
- [ ] 状态在关闭/重开/重启后保留，撤销后清空；
- [ ] 主题切换实时同步；
- [ ] `chrome: "custom"` 时插件能拖动窗口、最小化、关闭，且宿主不渲染固定 topbar；
- [ ] `setTransparent(false, color)` / `setTransparent(true)` 能实时切换窗口背景；
- [ ] 窗口隐藏/显示时收到 visibility；
- [ ] 外部网络未声明时被 CSP 拦截；
- [ ] iframe 无法读取宿主 localStorage，也无法通过 `window.parent` 访问宿主；
- [ ] iframe 里的 Tauri internals 只能命中自身窗口的最小权限（状态命令按 label 隔离）；
- [ ] 路径穿越（`..`、`%2e%2e`、符号链接）被拒绝；
- [ ] 卸载目录后设置页刷新即消失，状态文件被清理。
