# Scene SDK

> 目标：让创作者**不修改 Lull 核心代码**就能开发、测试并分发壁纸场景。
> 首版范围：内置媒体壁纸 + 随包官方场景（竹影）+ 外部内容包（静态 HTML/CSS 或声明
> `wallpaper.script` 的沙箱脚本场景）。脚本场景通过 `@lull/scene-sdk` 的 postMessage 桥
> 读取参数、画布几何、同步相位与鼠标位置。

## 1. 场景分类

| 类型 | 注册方式 | 运行位置 | 首版 |
| --- | --- | --- | --- |
| 内置媒体场景 | `src/scenes/registry.ts`（`lull.video`） | 宿主 MediaSurface（HTML `<video>` 回退，后续接原生纹理） | ✅ |
| 官方随包场景 | `extensions/official/bamboo` → `extensions/dist/lull.bamboo` | `sandbox="allow-scripts"` iframe + Scene SDK 桥 | ✅ |
| 外部静态场景 | `catalog.json`（随包或用户内容目录） | `sandbox=""` iframe（仅 HTML/CSS） | ✅ |
| 外部脚本场景 | `catalog.json` + `wallpaper.script` | `sandbox="allow-scripts"` iframe + Scene SDK 桥 | ✅ |
| 任意代码插件（可访问宿主 DOM/原生） | 未定义 | — | ❌ |

宿主内嵌只保留媒体壁纸：竹影已迁为官方场景包，极光 / 暮色已移除。
外部场景与官方场景都不进入 `src/`、不参与 Rust 编译。壁纸窗口本身只拿到一条只读
capability（列出已安装内容包），用于把 `scene` id 解析成入口 URL；静态场景 iframe 仍是
`sandbox=""`，脚本场景 iframe 不带 `allow-same-origin`，这条权限不对外部内容开放。
WebView2 可能把 Tauri 初始化脚本注入子帧；壁纸窗口的 ACL 只允许只读
`content_packages` 与事件订阅，不构成受支持的场景 API（见 §4.5）。

## 2. Scene Manifest

```json
{
  "schemaVersion": 1,
  "type": "scene",
  "id": "demo.fireflies",
  "name": "流萤（测试包）",
  "version": "1.0.0",
  "description": "深林夜幕里的流萤。用于验证内容包安装：纯静态 HTML/CSS，无脚本、无外部资源。",
  "author": "Lull Demo",
  "license": "CC-BY-4.0",
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas"
  ],
  "entry": "scenes/demo-fireflies/index.html",
  "theme": {
    "background": "#04120f",
    "accent": "#f2c98a"
  },
  "performance": {
    "tier": "low",
    "targetFps": 30
  },
  "compatibility": {
    "hostApi": 1,
    "platforms": ["windows"]
  },
  "integrity": {
    "algorithm": "sha256",
    "scope": "package",
    "digest": "eb5191cae4175bf40e582e86352cdd5844ce1c9c7114a5eca5fc6cca88a59647"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 当前固定 `1`；不支持的版本拒绝加载 |
| `type` | ✅ | 固定 `"scene"` |
| `id` | ✅ | 小写、全局唯一，建议 `作者.场景`；`^[a-z0-9][a-z0-9._-]{2,63}$` |
| `name` | ✅ | 设置页显示名 |
| `version` | ✅ | 语义化版本 |
| `license` | ✅ | SPDX 标识或许可证名；内容包必填 |
| `capabilities` | ✅ | 非空、去重；见下表 |
| `entry` | 外部场景必填 | 相对内容包根目录的 `.html` 路径；禁止 `..` / 绝对路径 / 反斜杠 |
| `description` | — | 设置页场景说明 |
| `author` | — | 创作者署名 |
| `theme.background` | — | 首帧防闪背景色（`#RRGGBB`） |
| `theme.accent` | — | 目录/设置页强调色 |
| `params` | — | 可选参数声明；每项含 `key/type/label/default`，number 可带 `min/max/step`，enum 必须带 `options`。声明参数时必须同时声明 `wallpaper.params`；内置场景经 `SceneProps` 读取，外部脚本场景经 `@lull/scene-sdk` 读取，外部静态包必须省略 |
| `performance` | — | 性能提示：`tier` 为 `low/medium/high`，可选 `targetFps`（1-240） |
| `compatibility` | — | 宿主兼容范围：`hostApi` 必填，可选 `maxHostApi` 与 `platforms` |
| `game` | — | 只读游戏绑定：`{ id, role: "replica" }`；声明时必须同时声明 `wallpaper.script`，且 `compatibility.hostApi >= 2` |
| `integrity` | 官方目录必填 | 整个包目录的 sha256 摘要；由 `pnpm content:hash` 维护，格式 `{algorithm:"sha256", scope:"package", digest}` |

未知字段会被拒绝。JSON Schema：[`content/schema/scene.schema.json`](../content/schema/scene.schema.json)。

### 2.1 capabilities 与运行时行为

| 能力 | 含义 | 宿主行为 |
| --- | --- | --- |
| `wallpaper.viewport` | 场景可铺满单屏视口 | mirror/independent 必需；缺失且无法使用画布时该场景不可运行 |
| `wallpaper.canvas` | 场景支持跨屏共享画布坐标 | span 下缺失时自动降级为 viewport |
| `wallpaper.sync` | 场景支持按绝对时间对齐动画相位 | 缺失时 `sync.enabled` 恒为 `false`；外部场景必须同时声明 `wallpaper.script` 才能收到相位 |
| `wallpaper.params` | 场景接受 Manifest 声明的参数 | 声明 `params` 时必填；外部场景还必须同时声明 `wallpaper.script`；Setting 只对声明该能力的场景渲染参数控件 |
| `wallpaper.script` | 外部场景在 `sandbox="allow-scripts"` 的 iframe 内执行 JS，并通过 Scene SDK 桥读取帧 | 只对内容包有效；没有该能力的外部包仍按静态包加载（空 sandbox） |
| `wallpaper.pointer` | 场景接受宿主动态下发的鼠标移动位置（`x/y/inside/moving`，无点击/按键） | 必须同时声明 `wallpaper.script` 与 `compatibility.hostApi >= 3`；宿主只在光标位于桌面层时下发 |

`compatibility.hostApi` 超出当前宿主 API 或不支持当前平台的场景会在目录层被过滤，不会出现在设置页。当前宿主为 **`SCENE_HOST_API = 3`**；声明 `game` 绑定的场景必须声明 `compatibility.hostApi: 2`（或更高），声明 `wallpaper.pointer` 的场景必须声明 `compatibility.hostApi: 3`（老宿主会把该场景当作不兼容跳过）。

## 3. 内置媒体场景接口

```ts
type SceneFrame = {
  mode: "mirror" | "independent" | "span";
  layout: "viewport" | "canvas";
  sync: { enabled: boolean; epochMs: number };
  viewport: { w: number; h: number; dpr: number }; // CSS 像素
  canvas: Rect | null; // 共享画布（物理像素），仅 span 非 null
  view: Rect | null;   // 当前显示器矩形（物理像素）
  dpr: number;
  params: Record<string, string | number | boolean>;
  reducedMotion: boolean;
  performance: { tier: "low" | "medium" | "high"; targetFps?: number } | null;
};

export type SceneProps = SceneFrame;
export type SceneComponent = (props: SceneProps) => ReactNode;
```

- `mode` 是用户配置的显示模式，`layout` 是实际绘制坐标系。mirror 与 independent 都是 `viewport`，但场景可以据此区分行为。
- `layout === "viewport"`：组件铺满当前窗口，用 `viewport.w/h` 或 `vw/vh` 或百分比布局。
- `layout === "canvas"`：组件位于「画布尺寸」的容器内，容器已按 `view` 偏移；组件应按 `canvas.w/h` 的比例布局，不要假设窗口大小。
- `sync`：只有当场景声明 `wallpaper.sync` 且模式需要同步时才启用；外部场景还必须声明
  `wallpaper.script` 才能收到相位。用 `syncedDelayMs(periodMs, sync.epochMs)` 生成负
  `animation-delay`，让所有窗口相位一致；不要自己调用 `Date.now()`。
- `params`：宿主已按 Manifest 类型还原并应用默认值；number 会限制在 `min/max` 内。
- `reducedMotion`：用户要求减少动态效果时为 `true`，场景应降级为静态或慢速动画。
- `dpr`：需要把物理像素换算成 CSS 像素时使用；画布容器已经做过一次换算。

参考实现：

- 内置媒体场景：[`src/scenes/video`](../src/scenes/video/index.tsx)
- 官方脚本场景：[`extensions/official/bamboo`](../extensions/official/bamboo/src/main.ts)
- 外部脚本示例：[`examples/scenes/param-demo`](../examples/scenes/param-demo)、
  [`examples/scenes/three-scene`](../examples/scenes/three-scene)

**不再新增宿主内置场景**：需要随包分发的壁纸应做成 `extensions/official/<id>` 官方场景包
（`catalog.json` + `index.html` + `src/`），由 `pnpm extensions:build` 构建到
`extensions/dist/<scene-id>`；第三方场景继续放 `public/content/` 或安装内容包。内置
`src/scenes/registry.ts` 只保留需要宿主内部 MediaSurface 的媒体场景。

## 4. 外部静态场景

### 4.1 目录布局

```text
public/content/
  catalog.json          # 内容索引（默认 scenes: []）
  catalog.sig.json      # 目录签名
  keys/                 # 随包公钥
```

`catalog.json`：

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "schemaVersion": 1,
      "type": "scene",
      "id": "demo.fireflies",
      "name": "流萤（测试包）",
      "version": "1.0.0",
      "license": "CC-BY-4.0",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
      "entry": "scenes/demo-fireflies/index.html"
    }
  ]
}
```

### 4.2 静态包（不执行脚本）

没有声明 `wallpaper.script` 的外部包继续使用空 `sandbox`：

- 不能读取 URL 哈希或宿主参数；
- 不能调用 Tauri IPC；
- 不能访问同源存储、Cookie 或 `window.parent`；
- 动画只能使用 CSS（`@keyframes`、`prefers-reduced-motion`）；
- 需要感知屏幕几何时，用 `100%` / `100vw` / `100vh` 等纯 CSS 布局。

静态包不能声明 `params` 或 `wallpaper.sync`（校验器会拒绝），因为没有任何通道能把值送进去。
示例见 [`examples/scenes/demo-fireflies`](../examples/scenes/demo-fireflies)。

### 4.3 脚本场景与 `@lull/scene-sdk`

声明 `wallpaper.script` 的包改用 `sandbox="allow-scripts"`（不带 `allow-same-origin`），
由宿主建立一条最小 postMessage 桥：

```text
iframe 加载 → scene: { v:1, type:"ready", protocol:1 }
host        → scene: { v:1, type:"init", hostApi:3, id, frame, visible }
host        → scene: { v:1, type:"frame", frame }        # 参数/几何/布局变化
host        → scene: { v:1, type:"visibility", visible }
host        → scene: { v:1, type:"pointer", pointer }    # 仅移动；声明 wallpaper.pointer 时
scene       → host : { v:1, type:"log", level, message }
```

> 自建桥必须在 iframe `load` 之后发送 `ready`：宿主在 `onLoad` 里会重置
> ready 状态并补发 `init`，脚本执行期同步发送的 `ready` 会被这次重置覆盖，
> 场景会一直停在未握手状态（收不到 `pointer` / `frame`）。

`frame` 字段：

```ts
type SceneFrame = {
  mode: "mirror" | "independent" | "span";
  layout: "viewport" | "canvas";
  sync: { enabled: boolean; epochMs: number };
  viewport: { w: number; h: number; dpr: number };
  canvas: { x: number; y: number; w: number; h: number } | null;
  view: { x: number; y: number; w: number; h: number } | null;
  dpr: number;
  params: Record<string, string | number | boolean>;
  reducedMotion: boolean;
  performance: { tier: "low" | "medium" | "high"; targetFps?: number } | null;
};

type ScenePointer = {
  /** 场景绘制坐标系内的 CSS 像素（viewport=本屏；canvas=共享画布）。 */
  x: number;
  y: number;
  /** 光标在桌面层上，且落在本场景绘制面内。 */
  inside: boolean;
  /** 最近约 120ms 内是否观察到移动；静止/移出桌面/隐藏时为 false。 */
  moving: boolean;
};
```

场景侧用 [`@lull/scene-sdk`](../packages/scene-sdk/README.md) 消费：

```ts
import { connectLullScene } from "@lull/scene-sdk";

const scene = await connectLullScene();
scene.onFrame((frame) => {
  document.documentElement.style.setProperty(
    "--tint",
    String(frame.params.tint ?? "#9fc7c2"),
  );
});
```

- `wallpaper.params` 声明的参数会按 Manifest 类型还原后放进 `frame.params`；
- `wallpaper.sync` 声明的场景会收到 `sync.enabled` 与 `epochMs`，用
  `syncedDelayMs(periodMs, epochMs)` 生成负 `animation-delay`；
- `viewport` 是 iframe 的实际绘制区域（span 下等于画布尺寸），`canvas` / `view`
  是物理像素桌面坐标；
- Setting 改参数 → Rust 写配置并热更壁纸 URL 哈希 → `SceneHost` 重算帧 →
  桥推送 `frame`，不需要重启壁纸。

#### 鼠标位置（`wallpaper.pointer`）

声明 `wallpaper.script` + `wallpaper.pointer` 且 `compatibility.hostApi >= 3` 的场景
可以订阅鼠标移动：

```ts
const scene = await connectLullScene();
const root = document.documentElement;
scene.onPointer((pointer) => {
  root.style.setProperty("--pointer-x", `${pointer.x}px`);
  root.style.setProperty("--pointer-y", `${pointer.y}px`);
  root.dataset.pointer = !pointer.inside
    ? "outside"
    : pointer.moving
      ? "moving"
      : "idle";
});
```

事件传递机制：

```text
Win32 GetPhysicalCursorPos / WindowFromPoint（Rust 30Hz 采样、去重、idle 状态机）
  → Tauri 定向事件 wallpaper-pointer（emit_to label=wallpaper-N）
  → 壁纸顶层页面按 frame.view / frame.canvas / dpr 换算成本地 CSS 像素
  → iframe postMessage { v:1, type:"pointer", pointer }
  → @lull/scene-sdk 校验并回调 onPointer
```

点击过滤与桌面安全：

- 壁纸窗口是 `WS_EX_TRANSPARENT` 的，DOM `mousemove` 根本不会触发；本方案也**不安装**
  `WH_MOUSE_LL` 钩子，只采样光标坐标，因此点击从设计上就进不了这条链路；
- 宿主不读取按键/滚轮/键盘状态，`pointer` 载荷只有 `x/y/inside/moving`；
- 桥协议没有 `click` / `dblclick` / `mousedown` 等类型，未知类型被直接丢弃；
- 只在光标位于桌面层（Progman / WorkerW）时下发；其他应用窗口、任务栏、开始菜单上
  补发 `inside:false` 后停止更新；
- 单击/双击但未移动时坐标不变，去重后零消息；壁纸窗口不 `SetCapture`、不抢焦点，
  点击始终由桌面/其他窗口处理。

完整可安装示例：
- [`examples/scenes/param-demo`](../examples/scenes/param-demo)：`glow / tint / pulse`，
  1.1.0 新增 `blur / hue / ring`，可验证覆盖更新；
- [`examples/scenes/three-scene`](../examples/scenes/three-scene)：Three.js / WebGL，
  `speed / particles / tint / wireframe / tilt` 参数热更；
- [`examples/scenes/pointer-demo`](../examples/scenes/pointer-demo)：`wallpaper.pointer`
  驱动跟随光晕，验证“移动有反馈、点击落桌面”。

### 4.4 画布与 iframe

宿主把 iframe 放在与内置场景相同的容器中：

- viewport：iframe 铺满窗口；
- span：iframe 先铺满画布，再由宿主容器按当前屏幕偏移裁切。

因此外部页面直接用 `100%` 布局即可，不需要自己重复做跨屏偏移。

### 4.5 安全边界

- 静态包 iframe 使用 `sandbox=""`，脚本完全不执行；
- 脚本场景 iframe 使用 `sandbox="allow-scripts"`，没有同源存储、Cookie 或宿主 DOM
  读取权限；只能通过 `window.parent.postMessage` 与宿主桥通信；
- 内容协议对 HTML 注入 nonce CSP：`script-src` 只允许包内源与本次 nonce，
  `connect-src` 只留包自身源，远程脚本/字体/图片/音频被拦截；
- 不允许 `entry` 逃逸内容根目录（校验器与运行时双重检查）；
- 壁纸窗口只通过 `window-wallpaper` 拿到 `content_packages`（只读目录）与事件订阅，
  没有安装/窗口/壁纸命令；
- `wallpaper.pointer` 只读取光标坐标：不装鼠标钩子、不读按键，协议没有点击类消息；
  壁纸窗口保持输入穿透，场景既收不到也拦不住桌面点击；
- 每个包有 `integrity` 摘要，目录有签名；第三方包没有发布者签名，摘要只证明
  “包没被改过”，不证明来源；
- WebView2 可能把 Tauri 初始化脚本注入子帧，脚本场景里仍可能看到
  `__TAURI_INTERNALS__`；壁纸窗口的 ACL 只允许只读 `content_packages` 与事件订阅，
  这不是受支持的场景 API；
- CSP 约束资源加载，不是完整网络/CPU 沙箱；脚本场景仍会消耗内存与 CPU，
  只应安装可信作者的内容包。

> 能加载一个 HTML 包或运行一段沙箱脚本，不等于建立了完整的插件权限系统。
> 场景没有写配置、创建窗口、调用原生或安装其他包的入口。

### 4.6 游戏渲染绑定（P2）

场景可以只读绑定一个游戏世界（`scene manifest.game`），把壁纸变成该游戏的 Render Replica。**Scene 是可选的视觉主题，不是显示游戏的必需品**：游戏包自带 `entry.replica` 时，宿主可以直接把它设为壁纸（[Game SDK](./game-sdk.md) §5）。

```json
{
  "game": { "id": "community.living-world", "role": "replica" },
  "capabilities": ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.script"],
  "compatibility": { "hostApi": 2, "platforms": ["windows"] }
}
```

- 场景必须声明 `wallpaper.script`；`role` 只能是 `replica`，场景永远不能成为 Authority。
- 游戏包内 `entry.replica` 与场景绑定共用同一套 `game.*` 消息；区别只是宿主来源。
- 游戏未运行或未启用时，宿主在场景 ready 后发送 `game.unavailable`，场景应回退静态视觉。
- 宿主 → 场景：`game.init`（context + 首份快照）、`game.snapshot`、`game.event`、
  `game.render`、`game.lifecycle`、`game.unavailable`；重复 `game.init` 用于 iframe 重载/重连。
- 场景 → 宿主：`game.ready`、`game.requestSnapshot`、`game.reportError`、`game.detach`。
- 场景只能读：没有 `commitState` / 命令发送 / `publishEvent` 入口。
- SDK：`@lull/game-sdk/scene` 的 `connectLullGameRender()`；完整契约见 [Game SDK](./game-sdk.md) §5。
  示例：[`examples/scenes/living-world`](../examples/scenes/living-world)。

```ts
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  game.onSnapshot((snapshot) => draw(snapshot.state, game.render));
  game.onEvent("world.changed", () => refresh());
}
```

## 5. 场景目录与设置页

`src/hooks/use-scene-catalog.ts` 合并（同 id 按优先级保留）：

1. 内置场景（媒体壁纸，同步可用）；
2. 官方随包场景（`extensions/dist/<id>`，Rust `content_packages` 返回 `origin=bundled`）；
3. `public/content/catalog.json` 中登记（如有）的随包内容场景（异步加载并验签，失败只降级为空列表）；
4. 用户安装的内容包（`%APPDATA%/content/<id>`）。

设置页显示场景名、版本、许可证与来源（内置 / 官方 / 随包内容包 / 已安装内容包），
只对声明了 `wallpaper.params` 的场景渲染参数编辑器；参数按场景 id 持久化到配置，
修改后热更新壁纸窗，再由 Scene SDK 桥或内置组件的 `SceneProps` 消费。
`number` 参数同时声明 `min` 与 `max` 时使用滑条（`step` 控制步进，未声明时按范围推断），
无界或只有单边限制的仍用数字输入；`boolean` / `enum` / `color` 分别用开关 / 下拉 / 取色器。
没有 `wallpaper.params` 的场景不会出现参数控件，避免“改了没反应”。

合并规则：

- 不兼容当前 hostApi / 平台的场景会被过滤；
- 同 id 时优先级为 内置 > 官方随包 > 随包内容 > 用户安装；官方场景不能被内容目录或用户包遮挡；
- **单个内容包非法只跳过该条**，其余外部场景照常加载，问题列在设置页；
- 目录加载失败不会影响壁纸运行；官方场景缺失时回退到内置媒体场景。

## 6. 校验

```powershell
pnpm content:hash    # 重算并写回包摘要
pnpm content:pack    # 打成可安装 zip（正斜杠 + UTF-8）
pnpm content:sign    # 给 catalog.json 原始字节签名
pnpm content:check   # 清单 + 摘要 + 签名一次性校验
pnpm scenes:sdk      # 构建 @lull/scene-sdk（dist + .d.ts）
pnpm extensions:build # 构建官方场景包（竹影）到 extensions/dist
pnpm extensions:check # 校验官方场景摘要 / 清单 / 产物边界
```

校验内容：

- catalog schemaVersion / scenes 数组；
- manifest 必填字段、未知字段、id/版本格式、capability 白名单；
- `params` 的类型、默认值、唯一 key、number 范围与 enum 选项；
- 声明 `params` 必须同时有 `wallpaper.params`；外部场景的 `wallpaper.params` /
  `wallpaper.sync` / `wallpaper.pointer` 必须同时有 `wallpaper.script`；
- `wallpaper.pointer` 必须声明 `compatibility.hostApi >= 3`；
- `performance` 档位与 `targetFps`；
- `compatibility` 的 hostApi 范围与平台；
- entry 相对路径安全性与文件存在性；
- 场景 id 不重复；
- `integrity.digest` 与包目录实际摘要一致；
- `catalog.sig.json` 对目录原始字节的签名有效。

Vitest 还会解析随包目录与示例场景，防止文档与实现漂移。

## 7. 版本与兼容

- `schemaVersion` 是破坏性变更开关；新增可选字段不升版本。
- 宿主读到不支持的版本会拒绝该目录并保留内置媒体场景，不崩溃。
- 内容包 `version` 独立于 Lull 版本；`compatibility.hostApi` 声明最低宿主 API，`maxHostApi` 声明最高可用版本，`platforms` 声明平台。
- `wallpaper.pointer` 属于场景宿主 API 3；老宿主不认这个能力，会在目录层跳过该场景。
- 场景 id 一经发布不要修改；改名视为新场景。
- 同 id 安装新版本会**覆盖**旧目录（先备份再替换），壁纸按 manifest `version`
  重建 iframe；没有版本大小比较、回滚或降级保护，发布前先在测试环境验证。

## 8. 非目标

- 静态内容包不允许执行 JavaScript（空 sandbox）；
- 脚本场景只允许在 opaque-origin sandbox 中通过 Scene SDK 桥读取帧，不开放宿主
  DOM、任意 Tauri IPC、原生调用或安装其他包；
- 不允许场景执行任意 Rust 命令；
- 不允许场景创建/管理窗口；
- 不允许场景修改全局配置；
- 鼠标位置通道只传递移动状态与坐标，不提供点击、双击、拖拽按键、滚轮或键盘事件；
  也不提供浏览器 DOM `mousemove` 回退；
- 不允许场景在首版访问麦克风、文件系统或网络；
- 不允许外部场景使用 `MediaSurface`、视频会话命令或读取宿主媒体 token；视频壁纸是内置 `lull.video`，本地素材由设置页登记，细节见 [Media Runtime](media-runtime.md)；
- 不把 React 组件直接分发给第三方；外部场景用静态 HTML/CSS 或 `@lull/scene-sdk` 的
  沙箱脚本包，不能直接复用宿主 React 组件（官方竹影也已改写为脚本场景包）。

## 9. 许可

- `src/sdk/scene/**`、`packages/scene-sdk/**`：**Apache-2.0**（见 [SDK License](../SDK-LICENSE.md)）；
- 内置媒体场景实现 `src/scenes/**`：**GPL-3.0-or-later**；
- 官方竹影场景包 `extensions/official/bamboo/**`：应用代码，**GPL-3.0-or-later**；
- 外部内容示例 `examples/scenes/**`：**CC BY 4.0**（见 [Content License](../CONTENT-LICENSE.md)）；
- 第三方内容包：作者自选许可，但必须在 manifest 的 `license` 字段声明。
