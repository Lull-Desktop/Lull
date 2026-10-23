# Scene SDK

> 目标：让创作者**不修改 Lull 核心代码**就能开发、测试并分发壁纸场景。
> 首版范围：内置 React 场景 + 外部内容包（静态 HTML/CSS 或声明 `wallpaper.script`
> 的沙箱脚本场景）。脚本场景通过 `@lull/scene-sdk` 的 postMessage 桥读取参数、
> 画布几何与同步相位。

## 1. 场景分类

| 类型 | 注册方式 | 运行位置 | 首版 |
| --- | --- | --- | --- |
| 内置场景（built-in） | `src/scenes/registry.ts` | Next.js 客户端组件 | ✅ |
| 外部静态场景 | `catalog.json`（随包或用户内容目录） | `sandbox=""` iframe（仅 HTML/CSS） | ✅ |
| 外部脚本场景 | `catalog.json` + `wallpaper.script` | `sandbox="allow-scripts"` iframe + Scene SDK 桥 | ✅ |
| 任意代码插件（可访问宿主 DOM/原生） | 未定义 | — | ❌ |

外部场景不进入 `src/`，不参与 Rust 编译。壁纸窗口本身只拿到一条只读 capability
（列出已安装内容包），用于把 `scene` id 解析成入口 URL；静态场景 iframe 仍是
`sandbox=""`，脚本场景 iframe 不带 `allow-same-origin`，这条权限不对外部内容开放。
WebView2 可能把 Tauri 初始化脚本注入子帧；壁纸窗口的 ACL 只允许只读
`content_packages` 与事件订阅，不构成受支持的场景 API（见 §4.5）。

## 2. Scene Manifest

```json
{
  "schemaVersion": 1,
  "type": "scene",
  "id": "community.mist",
  "name": "雾岚",
  "version": "1.0.0",
  "description": "薄雾与远山。",
  "author": "Lull Community",
  "license": "CC-BY-4.0",
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas"
  ],
  "entry": "scenes/mist/index.html",
  "theme": {
    "background": "#0a1416",
    "accent": "#9fc7c2"
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
    "digest": "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb"
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
| `entry` | 外部场景必填 | 相对 `public/content/` 的 `.html` 路径；禁止 `..` / 绝对路径 / 反斜杠 |
| `description` | — | 设置页场景说明 |
| `author` | — | 创作者署名 |
| `theme.background` | — | 首帧防闪背景色（`#RRGGBB`） |
| `theme.accent` | — | 目录/设置页强调色 |
| `params` | — | 可选参数声明；每项含 `key/type/label/default`，number 可带 `min/max/step`，enum 必须带 `options`。声明参数时必须同时声明 `wallpaper.params`；内置场景经 `SceneProps` 读取，外部脚本场景经 `@lull/scene-sdk` 读取，外部静态包必须省略 |
| `performance` | — | 性能提示：`tier` 为 `low/medium/high`，可选 `targetFps`（1-240） |
| `compatibility` | — | 宿主兼容范围：`hostApi` 必填，可选 `maxHostApi` 与 `platforms` |
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

`compatibility.hostApi` 超出当前宿主 API 或不支持当前平台的场景会在目录层被过滤，不会出现在设置页。
当前宿主 API 版本是 `SCENE_HOST_API = 1`。

## 3. 内置场景接口

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

- [`src/scenes/bamboo`](../src/scenes/bamboo/index.tsx)
- [`src/scenes/aurora`](../src/scenes/aurora/index.tsx)
- [`src/scenes/dusk`](../src/scenes/dusk/index.tsx)

新增内置场景：

```ts
// src/scenes/registry.ts
const MY_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.my-scene",
  name: "我的场景",
  version: "1.0.0",
  license: "GPL-3.0-or-later",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
  params: [
    {
      key: "density",
      type: "number",
      label: "密度",
      default: 0.5,
      min: 0,
      max: 1,
    },
  ],
  performance: { tier: "medium", targetFps: 60 },
  compatibility: { hostApi: 1, platforms: ["windows"] },
});
```

然后在 `BUILTIN_SCENES` 追加 `{ source: "builtin", manifest: MY_MANIFEST, component: MyScene }`。设置页与宿主会自动读取。

## 4. 外部静态场景

### 4.1 目录布局

```text
public/content/
  catalog.json
  scenes/
    mist/
      index.html
      assets/…      # 可选，必须使用相对路径
```

`catalog.json`：

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "schemaVersion": 1,
      "type": "scene",
      "id": "community.mist",
      "name": "雾岚",
      "version": "1.0.0",
      "license": "CC-BY-4.0",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
      "entry": "scenes/mist/index.html"
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
示例见 [`public/content/scenes/mist/index.html`](../public/content/scenes/mist/index.html)。

### 4.3 脚本场景与 `@lull/scene-sdk`

声明 `wallpaper.script` 的包改用 `sandbox="allow-scripts"`（不带 `allow-same-origin`），
由宿主建立一条最小 postMessage 桥：

```text
iframe 加载 → scene: { v:1, type:"ready", protocol:1 }
host        → scene: { v:1, type:"init", hostApi:1, id, frame, visible }
host        → scene: { v:1, type:"frame", frame }        # 参数/几何/布局变化
host        → scene: { v:1, type:"visibility", visible }
scene       → host : { v:1, type:"log", level, message }
```

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

完整可安装示例：
- [`examples/content/param-demo`](../examples/content/param-demo)：`glow / tint / pulse`，
  1.1.0 新增 `blur / hue / ring`，可验证覆盖更新；
- [`examples/content/three-scene`](../examples/content/three-scene)：Three.js / WebGL，
  `speed / particles / tint / wireframe / tilt` 参数热更。

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
- 每个包有 `integrity` 摘要，目录有签名；第三方包没有发布者签名，摘要只证明
  “包没被改过”，不证明来源；
- WebView2 可能把 Tauri 初始化脚本注入子帧，脚本场景里仍可能看到
  `__TAURI_INTERNALS__`；壁纸窗口的 ACL 只允许只读 `content_packages` 与事件订阅，
  这不是受支持的场景 API；
- CSP 约束资源加载，不是完整网络/CPU 沙箱；脚本场景仍会消耗内存与 CPU，
  只应安装可信作者的内容包。

> 能加载一个 HTML 包或运行一段沙箱脚本，不等于建立了完整的插件权限系统。
> 场景没有写配置、创建窗口、调用原生或安装其他包的入口。

## 5. 场景目录与设置页

`src/hooks/use-scene-catalog.ts` 合并：

1. 内置场景（同步可用）；
2. `public/content/catalog.json` 中的外部场景（异步加载并验签，失败只降级为空列表）。

设置页显示场景名、版本、许可证与来源（内置 / 随包内容包 / 已安装内容包），
只对声明了 `wallpaper.params` 的场景渲染参数编辑器；参数按场景 id 持久化到配置，
修改后热更新壁纸窗，再由 Scene SDK 桥或内置组件的 `SceneProps` 消费。
`number` 参数同时声明 `min` 与 `max` 时使用滑条（`step` 控制步进，未声明时按范围推断），
无界或只有单边限制的仍用数字输入；`boolean` / `enum` / `color` 分别用开关 / 下拉 / 取色器。
没有 `wallpaper.params` 的场景不会出现参数控件，避免“改了没反应”。

合并规则：

- 不兼容当前 hostApi / 平台的场景会被过滤；
- 同 id 时内置场景优先，外部包不能覆盖官方 id；
- **单个内容包非法只跳过该条**，其余外部场景照常加载，问题列在设置页；
- 目录加载失败不会影响壁纸运行。

## 6. 校验

```powershell
pnpm content:hash    # 重算并写回包摘要
pnpm content:pack    # 打成可安装 zip（正斜杠 + UTF-8）
pnpm content:sign    # 给 catalog.json 原始字节签名
pnpm content:check   # 清单 + 摘要 + 签名一次性校验
pnpm scenes:sdk      # 构建 @lull/scene-sdk（dist + .d.ts）
```

校验内容：

- catalog schemaVersion / scenes 数组；
- manifest 必填字段、未知字段、id/版本格式、capability 白名单；
- `params` 的类型、默认值、唯一 key、number 范围与 enum 选项；
- 声明 `params` 必须同时有 `wallpaper.params`；外部场景的 `wallpaper.params` /
  `wallpaper.sync` 必须同时有 `wallpaper.script`；
- `performance` 档位与 `targetFps`；
- `compatibility` 的 hostApi 范围与平台；
- entry 相对路径安全性与文件存在性；
- 场景 id 不重复；
- `integrity.digest` 与包目录实际摘要一致；
- `catalog.sig.json` 对目录原始字节的签名有效。

Vitest 还会解析随包目录与示例场景，防止文档与实现漂移。

## 7. 版本与兼容

- `schemaVersion` 是破坏性变更开关；新增可选字段不升版本。
- 宿主读到不支持的版本会拒绝该目录并保留内置场景，不崩溃。
- 内容包 `version` 独立于 Lull 版本；`compatibility.hostApi` 声明最低宿主 API，`maxHostApi` 声明最高可用版本，`platforms` 声明平台。
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
- 不允许场景在首版访问麦克风、文件系统或网络；
- 不把 React 组件直接分发给第三方；外部场景用静态 HTML/CSS 或 `@lull/scene-sdk` 的
  沙箱脚本包，不能直接复用内置 React 组件。

## 9. 许可

- `src/sdk/scene/**`、`packages/scene-sdk/**`：**Apache-2.0**（见 [SDK License](../SDK-LICENSE.md)）；
- 内置场景实现 `src/scenes/**`：**GPL-3.0-or-later**；
- 外部内容示例 `public/content/**`：**CC BY 4.0**（见 [Content License](../CONTENT-LICENSE.md)）；
- 第三方内容包：作者自选许可，但必须在 manifest 的 `license` 字段声明。
