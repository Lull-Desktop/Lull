# Widget SDK

> 面向第三方 Widget（工具窗口）插件作者：包结构 → 清单 → SDK 接入 → 能力边界。
> 插件是**静态 Web 包**，装到用户目录后由宿主创建独立窗口，运行在 `sandbox="allow-scripts"` 的
> 不透明源 iframe 里；所有宿主能力都通过 `@lull/widget-sdk` 走 postMessage 桥，由宿主校验后转发。
> 内置工具（资料库 / 设置）走另一套编译期契约；官方播放器/白噪音走标准 Widget 包；番茄钟已迁为 `examples/widgets/liquid-pomodoro` 普通扩展。见[与内置工具的关系](#与内置工具的关系)。

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
| `widget.media` | 硬约束 | 经宿主壳调用 Media Service；必须配合下列 Noise capability 与 bridge token |
| `widget.network` | 硬约束 | 只有清单声明的 `https://` 源会进 CSP |
| `widget.chrome` | 硬约束 | 拖动 / 最小化 / 关闭 / 切换透明**自己的**窗口；`chrome: "custom"` 时必须声明 |
| `media.noise.library.read` | 硬约束 | Noise 素材/分类/标签/收藏读取 |
| `media.noise.session.read` | 硬约束 | Session/State/snapshot/事件读取 |
| `media.noise.session.control` | 硬约束 | Session 创建/播放/暂停/停止/睡眠 |
| `media.noise.tracks.read` | 硬约束 | Track 事件读取 |
| `media.noise.tracks.write` | 硬约束 | 增删轨道、enabled/loop/排序 |
| `media.noise.volume.write` | 硬约束 | Session/Track 音量与静音 |
| `media.noise.presets.read` | 硬约束 | Preset 列表/详情 |
| `media.noise.presets.write` | 硬约束 | 保存/加载/删除/映射/收藏 Preset |
| `media.player.read` | 硬约束 | 播放器状态、进度、音量与快照 |
| `media.player.control` | 硬约束 | 播放/暂停/恢复/停止/跳转/切歌/播放模式 |
| `media.player.volume.write` | 硬约束 | 播放器音量与静音 |
| `media.queue.read` | 硬约束 | 队列快照与 `queue.changed` |
| `media.queue.write` | 硬约束 | 加入/移除/清空/排序队列与 `playAt` |
| `media.library.read` | 硬约束 | 曲目/艺术家/专辑查询与封面 URL |
| `media.library.directory.read` | 硬约束 | 单层目录浏览 `library.listDirectory`（相对路径，不含根路径） |
| `media.library.favorites.write` | 硬约束 | 喜欢/取消喜欢曲目 |
| `media.library.sources.write` | 硬约束 | 打开文件夹/单曲选择器，添加目录或导入单曲并触发扫描 |
| `game.state.read` | 硬约束 | 读取游戏快照、订阅游戏事件（经宿主壳转发） |
| `game.command.send` | 硬约束 | 向游戏 Authority 发送命令；不能写权威状态 |
| `game.event.read` | 硬约束 | 订阅游戏事件流 |

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

> 官方工具（播放器、白噪音）正在迁移为**随应用分发的官方扩展**：迁移完成后它们也使用
> 本文件的包格式、SDK 与 iframe 沙箱，由宿主按来源标记为官方（默认启用、不可卸载）。
> 迁移期间两套契约并存；迁移完成前，内置工具仍按上表走编译期契约。见
> [官方扩展](./official-extensions.md)。

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
| `provides` | 可选；v1 最多一条 `{ slot, version: 1 }`，声明为功能槽位 Provider |
| `capabilities` | 只能申请上表的 23 个 |
| `window.width/height` | 320×240 – 1600×1200；`minWidth/minHeight` 不得大于初始值 |
| `window.resizable` | 首期固定 `false`，窗口尺寸由宿主决定 |
| `window.transparent` | 初始是否透明（默认 `true`），运行时可用 `setTransparent` 切换 |
| `window.chrome` | `host`（默认，宿主绘制顶栏）或 `custom`（插件自绘）；`custom` 必须同时申请 `widget.chrome` |
| `window.fit` | `none`（默认）或 `content`（允许按内容高度调整窗口）；`content` 必须同时申请 `widget.chrome` |
| `network` | 允许的 `https://` 源；非空时必须同时申请 `widget.network` |

#### 功能槽位 Provider

声明 `provides` 的 Widget 会参与宿主的功能槽位互斥：

```json
"provides": [{ "slot": "music-player", "version": 1 }],
"capabilities": [
  "widget.ui",
  "widget.media",
  "media.player.read",
  "media.player.control",
  "media.player.volume.write",
  "media.queue.read",
  "media.library.read"
]
```

- v1 只支持 `music-player`、`noise-controller`；未知 Slot 安装时警告，不注册为 Provider。
- `music-player` 需要 `widget.media`、`media.player.read`、`media.player.control`；
  `noise-controller` 需要 `widget.media`、`media.noise.session.read`、
  `media.noise.session.control`。
- 同一 Slot 同一时间只运行一个 Provider；选择、切换、关闭、卸载由宿主管理，插件不能
  自己切换 Slot 或停止其他扩展。
- Provider 必须通过 `connectLullWidget()` 握手；SDK 收到宿主 `init` 后会补发一次 `ready`，
  Slot 只认 SDK ready，不把 iframe load 当作可用。
- 声明媒体能力但**不**声明 `provides` 的 Widget 是伴侣/遥控器，可与当前 Provider 同时
  运行，不占 Slot。
- v1 一个扩展最多声明一个 Provider（固定 `widget-<id>` 只能承载一个窗口）。
- 完整契约见 [扩展槽位与 Provider](./extension-slots.md)。

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

// 主题、语言与视口：订阅会立刻回放当前值
lull.onTheme((theme) => applyTheme(theme)); // theme.tokens 是宿主 CSS 变量白名单
lull.onLocale((locale) => setLocale(locale));
lull.onViewport(({ width, height }) => layout(width, height));

// window.fit = "content" 时按内容高度请求贴高；宽度受清单 [minWidth, width] 限制
await lull.requestResize({ height: document.body.scrollHeight });

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

### 媒体（Noise）桥

声明 `widget.media` 与需要的最小 Noise capability。宿主 init 里的 `bridgeToken` 由 Rust 生成并只注入顶层壳页；插件 iframe 拿不到 Tauri IPC 或 token。

```ts
import { connectLullWidget } from "@lull/widget-sdk";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";

const lull = await connectLullWidget();
const media = createWidgetMediaClient({
  request: (method, params) => lull.request(method as never, params as never),
  onMediaEvent: lull.onMediaEvent,
});

await media.connect({ topics: ["noise.session.changed", "noise.track.updated"] });
await media.noise.session.play();
await media.noise.tracks.setVolume("track-id", 0.4);
```

- `media.call` / `media.connect` / `media.disconnect` 由宿主壳代发，并附带 bridge token；Rust 还会按窗口 label 查 `.grants.json`，未授权方法返回 `capability.denied`。
- Tauri 侧 `window-widgets` capability 放开上述三个命令，以及 `widget_open` / `widget_close` / `widget_visibility`（插件壳经 `window.open` / `window.close` / `window.isOpen` 桥方法转发）；真正的权限仍由 Rust 的 bridge token 与能力清单校验（Noise 8 项 + Player/Queue/Library 9 项）。
- Widget snapshot 按读能力裁剪：`output`/`noise`/`noiseSession` 始终存在；`player` 需 `media.player.read`，`queue` 需 `media.queue.read`。
- 可订阅 topic 受 read capability 限制；`player.*` / `queue.changed` / `library.changed` 在对应读能力授权后才下发。
- `noise.presets.importPreset` / `exportPreset`、Asset 导入/编辑/删除/缺失检查不向 Widget 开放。
- `useNoiseSession` / `useNoiseTracks` / `useNoiseLibrary` / `useNoisePresets` / `usePlayerSession` 可配合 `@lull/media-sdk/react` 使用；它们共享 MediaSessionHub，订阅归零也不主动断开。

### 游戏控制器（P1）

声明 `game.state.read` 与 `game.command.send`（需要事件流时再加 `game.event.read`）。宿主壳新增四个桥方法：`game.connect` / `game.snapshot` / `game.command` / `game.disconnect`，并把 Tauri 的 `game:snapshot` / `game:event` / `game:lifecycle` 转发成同名 `game.*` 宿主消息。宿主壳按当前 Widget 窗口 label 定向订阅这些事件，多个游戏的控制器同时打开时不会互相串台。

```ts
import { connectLullWidget } from "@lull/widget-sdk";
import { connectLullGameWidget } from "@lull/game-sdk/widget";

const lull = await connectLullWidget();
const game = await connectLullGameWidget(lull, { gameId: "community.living-world" });

const snapshot = await game.getSnapshot(); // 未运行时为 null
await game.command("plant.seed", { seedId: "seed-1" });
```

- 控制器只能读状态、发命令；写状态、启停实例、删除存档属于 Authority / 设置页（宿主控制面），Widget 拿不到。
- 未运行时 `context.instanceId` 为 `null`，`command` 返回 `game.instance_not_running`；控制器应按"未运行"展示，而不是弹错误。
- 完整 API 与能力语义见 [Game SDK](./game-sdk.md) §6；示例游戏现统一使用包内控制器，`widgetId` 载体保留给需要复用独立 Widget UI 的第三方游戏。

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

常用成员：`getState` / `setState` / `removeState`、`theme` / `onTheme`、`locale` / `onLocale`、
`viewport` / `onViewport`、`onVisibility`、`onMediaEvent`、`has(cap)`、`requestAudio()`、
`requestResize({ width?, height?, anchor? })`、`alignPlayer({ currentSide, nextSide, width, playerAnchor })`、
`startDrag()` / `minimize()` / `setTransparent()` / `close()`、`openWindow({ kind, tab? })` /
`closeWindow({ kind })` / `isWindowOpen(kind)` / `onWindowState(fn)`、`log()`、`destroy()`。React 另提供
`useWidgetFit` 与 `useLullLocale`。
错误统一抛 `LullWidgetError`，按 `code` 分支，不要匹配文案。

`openWindow` 需要 `widget.chrome` 能力：打开（或唤醒）宿主工具窗口，`kind` 由宿主壳白名单
校验（当前仅 `"library"`），`tab` 可指定工具窗口打开后停留的页签（由工具窗口自行校验合法性）。
官方播放器用它从「队列 / 收藏」页签跳到音乐库窗口的对应页签。

`closeWindow` 隐藏同一个工具窗口（保留挂载，不销毁 WebView），权限与白名单同上；`isWindowOpen`
拉一次真实可见性，`onWindowState` 订阅变化。用户在工具窗口里点关闭、或从托盘 / 设置页隐藏时，
宿主会主动推送 `{ kind, visible }`；工具窗口自己切换页签时还会带上 `tab`。所以「打开 / 关闭」
一个按钮的插件不必自己猜状态，也能据此区分「再点一次是关闭，还是切到另一个页签」。
官方播放器的「状态监控」泡与抽屉页签右侧的齿轮按钮都用这套组合：点一次打开音乐库窗口对应页签，
再点一次收起，按钮高亮（以及关闭判定所依据的页签）始终跟随真实窗口。

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

五个示例覆盖原生 / React / Vue、完整 Liquid 计时 UI 与最小第三方播放器，直接对照着改最快：

| 示例 | 技术栈 | 位置 |
| --- | --- | --- |
| `pomodoro-js` | 原生 TypeScript | `examples/widgets/pomodoro-js` |
| `pomodoro-react` | React | `examples/widgets/pomodoro-react` |
| `pomodoro-vue` | Vue 3 | `examples/widgets/pomodoro-vue` |
| `liquid-pomodoro` | React + Widget SDK（原内置番茄钟迁移） | `examples/widgets/liquid-pomodoro` |
| `mini-player` | 原生 TypeScript + Media SDK，声明 `music-player` Provider | `examples/widgets/mini-player` |

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

- 宽度请求夹在清单 `[minWidth, width]`；高度只在 `window.fit: "content"` 时生效，并受
  最小高度、1200px 与屏幕工作区限制。`requestResize` 返回宿主实际应用的尺寸；
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
