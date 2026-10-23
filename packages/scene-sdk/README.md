# `@lull/scene-sdk`

Lull 壁纸场景（外部内容包）的**场景侧 SDK**：在 `sandbox="allow-scripts"` 的 iframe 里
通过 postMessage 桥接收宿主下发的参数、视口/画布几何、同步相位与可见性。

只给声明了 `wallpaper.script` 的场景使用；没有该能力的静态包继续以 `sandbox=""` 加载，
不执行脚本，也不需要这个包。

- 客户端：`@lull/scene-sdk`
- 测试辅助：`@lull/scene-sdk/testing`

## 安装

当前随仓库分发，尚未发布到 npm。先构建产物：

```bash
pnpm scenes:sdk   # 生成 packages/scene-sdk/dist（含 .d.ts）
```

在场景工程里把 `@lull/scene-sdk` 指向本仓库的 `packages/scene-sdk`（或用路径别名），
再用 esbuild / Vite 打成单文件 ESM。场景包本身不加载远程模块。

## 快速开始

`scenes/my-scene/index.html`：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #07110f;
        overflow: hidden;
      }
      .glow {
        position: absolute;
        inset: 15%;
        background: var(--tint, #9fc7c2);
        opacity: var(--glow, 0.5);
        filter: blur(40px);
        animation: breathe 8s ease-in-out infinite alternate;
        animation-delay: var(--sync-delay, 0ms);
      }
      @keyframes breathe {
        from {
          transform: scale(0.9);
        }
        to {
          transform: scale(1.1);
        }
      }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`src/main.ts`：

```ts
import {
  connectLullScene,
  type SceneFrame,
  syncedDelayMs,
} from "@lull/scene-sdk";

const scene = await connectLullScene();

function apply(frame: SceneFrame) {
  const root = document.documentElement;
  root.style.setProperty("--glow", String(frame.params.glow ?? 0.5));
  root.style.setProperty("--tint", String(frame.params.tint ?? "#9fc7c2"));
  root.style.setProperty(
    "--sync-delay",
    `${syncedDelayMs(8000, frame.sync.epochMs)}ms`,
  );
  scene.log(
    `params=${JSON.stringify(frame.params)} layout=${frame.layout}`,
  );
}

scene.onFrame(apply);
```

`catalog.json` 里必须声明能力与参数：

```json
{
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas",
    "wallpaper.params",
    "wallpaper.script"
  ],
  "params": [
    {
      "key": "glow",
      "type": "number",
      "label": "光晕强度",
      "default": 0.5,
      "min": 0,
      "max": 1
    },
    {
      "key": "tint",
      "type": "color",
      "label": "光晕颜色",
      "default": "#9fc7c2"
    }
  ]
}
```

Setting 页会按 `params` 自动渲染控件；改值后经 `wallpaper_set_scene_params` 写入配置、
热更壁纸 URL 哈希，再由 SDK 的 `frame` / `onParams` 送到场景。不需要重启壁纸。

## 客户端 API

`connectLullScene(options?)` → `Promise<LullSceneClient>`（同一页面重复调用返回同一个连接）

| 成员 | 说明 |
| --- | --- |
| `id` / `hostApi` / `protocol` | 场景 id、宿主 API 版本、桥协议版本 |
| `frame` | 最近一帧；`init` 之前为 `null` |
| `params` | 当前参数（已按 Manifest 类型还原）；`init` 之前为 `{}` |
| `visible` | 当前窗口可见性 |
| `onFrame(fn)` | 订阅帧更新；注册时立即回放当前帧，返回退订函数 |
| `onParams(fn)` | 只订阅参数；注册时立即回放 |
| `onVisibility(fn)` | 订阅窗口显隐；注册时立即回放 |
| `log(message, level?)` | 转发到宿主控制台，前缀 `[scene:<id>]` |
| `destroy()` | 退订全部监听 |

`SceneFrame`：

```ts
type SceneFrame = {
  mode: "mirror" | "independent" | "span";
  layout: "viewport" | "canvas";
  sync: { enabled: boolean; epochMs: number };
  viewport: { w: number; h: number; dpr: number }; // iframe 实际绘制区域（CSS 像素）
  canvas: { x: number; y: number; w: number; h: number } | null; // 物理像素
  view: { x: number; y: number; w: number; h: number } | null; // 物理像素
  dpr: number;
  params: Record<string, string | number | boolean>;
  reducedMotion: boolean;
  performance: { tier: "low" | "medium" | "high"; targetFps?: number } | null;
};
```

- `layout === "canvas"` 时 iframe 已被宿主铺满共享画布，`viewport` 等于画布尺寸；
  用 `canvas` / `view` 做跨屏定位，不要假设窗口大小。
- `sync.enabled` 为 true 时用 `syncedDelayMs(periodMs, sync.epochMs)` 生成负
  `animation-delay`，不要自己调用 `Date.now()`。
- `params` 已按 Manifest 的类型、`min/max`、`options` 归一化；缺失键回退默认值。

错误统一是 `LullSceneError`，用 `code` 分支：

| code | 场景 |
| --- | --- |
| `not-embedded` | 不在壁纸 iframe 里（顶层页面/SSR） |
| `init-timeout` | 宿主没在超时前发 `init`（默认 10s） |
| `disposed` | 客户端已 `destroy()`（保留给后续版本） |

## 桥方法

宿主 → 场景：`init` / `frame` / `visibility`（全部带 `v: 1`）。
场景 → 宿主：`ready` / `log`。

`init` 载荷：

```json
{
  "v": 1,
  "type": "init",
  "protocol": 1,
  "hostApi": 1,
  "id": "demo.param-scene",
  "frame": { "...": "SceneFrame" },
  "visible": true
}
```

宿主只接受 `event.source === iframe.contentWindow` 的消息；不透明源的 `event.origin`
是 `"null"`，不能依赖 origin 校验。场景侧同样只处理来自 `window.parent` 的消息。

## 安全边界

- iframe 是 `sandbox="allow-scripts"`，**不带 `allow-same-origin`**：拿不到宿主 DOM、
  localStorage、Cookie 或 IndexedDB；
- 内容协议按文档下发 nonce CSP：默认只允许包内资源，`connect-src` 只留包自身源，
  远程脚本/字体/图片/音频被 CSP 拦截；
- 场景只能通过桥读取宿主下发的帧与参数，没有写宿主配置、创建窗口或调用 Tauri 命令的入口；
- WebView2 会把 Tauri 初始化脚本注入子帧，场景里仍可能看到 `__TAURI_INTERNALS__`；
  壁纸窗口的 ACL 只授予 `content_packages`（只读目录）与事件订阅，这不是受支持的场景 API；
- 生产环境请只安装来源可信的场景包。摘要只证明“包没被改过”，不是签名。

## 开发与测试

```bash
pnpm scenes:sdk        # tsc 构建 dist（含 .d.ts / sourcemap）
pnpm scenes:sdk:check  # 只做类型检查（CI 用）
pnpm test              # 根 vitest 会跑 packages/scene-sdk/src/*.test.ts
```

测试辅助：

```ts
import {
  createMemorySceneTransport,
  createSceneInitMessage,
} from "@lull/scene-sdk/testing";
import { createLullSceneClient } from "@lull/scene-sdk";

const transport = createMemorySceneTransport();
const pending = createLullSceneClient({ transport });
transport.receive(createSceneInitMessage());
const scene = await pending;
```

## 兼容矩阵

| SDK | 桥协议 | 宿主 API | 说明 |
| --- | --- | --- | --- |
| `0.1.x` | `1` | `1` | 首个场景侧 SDK；参数/几何/同步/可见性 |

`wallpaper.script` 与 `wallpaper.params` 是 Scene SDK v1 的能力；没有声明这两个能力的
外部场景仍按静态包加载，继续不执行 JavaScript。

许可：Apache-2.0（见仓库根 `SDK-LICENSE.md`）。
