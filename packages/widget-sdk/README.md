# `@lull/widget-sdk`

Lull 第三方 Widget（工具窗口）的**插件侧 SDK**：TypeScript 源码、类型声明随包发布。

插件运行在宿主窗口的 sandbox iframe 里，拿不到宿主 DOM、`localStorage` 与 Tauri IPC；
所有能力都通过 `postMessage` 桥由宿主校验后转发。这个包只负责那一层通信，不依赖 React / Vue。

- 无框架依赖：`@lull/widget-sdk`
- React 适配：`@lull/widget-sdk/react`
- Vue 3 适配：`@lull/widget-sdk/vue`
- 测试辅助：`@lull/widget-sdk/testing`

## 安装

当前随仓库分发，尚未发布到 npm。先构建产物，再引用：

```bash
pnpm widgets:sdk   # 生成 packages/widget-sdk/dist（含 .d.ts）
```

两种用法：

```bash
# 1) 直接引用本仓库的包（示例插件的做法：esbuild/vite 打包时解析）
pnpm add --save-dev file:../../packages/widget-sdk

# 2) 在插件工程里用路径别名指向 packages/widget-sdk/dist
```

React / Vue 适配是**可选 peer 依赖**，不用框架的插件不会被强制安装。
包是 ESM-only（`"type": "module"`，导出带 `types` 条件）；CommonJS 工程需要打包器转换。

## 快速开始

```ts
import { connectLullWidget } from "@lull/widget-sdk";

const lull = await connectLullWidget();

// 宿主 KV：卸载/重开窗口后仍在
const prefs = await lull.getState("prefs", { focus: 25, rest: 5 });
await lull.setState("prefs", { ...prefs, focus: 50 });

// 主题（宿主下发的只读令牌）
const apply = (theme) => {
  if (!theme) return;
  document.documentElement.style.setProperty("--accent", theme.colors.accentLight);
};
apply(lull.theme);
lull.onTheme(apply);

// 能力检查：清单没声明或用户没授权都是 false
if (lull.has("widget.audio") && (await lull.requestAudio())) {
  // 可以创建音频上下文
}
```

React：

```tsx
import { connectLullWidget } from "@lull/widget-sdk";
import { LullProvider, useLullState, useLullTheme } from "@lull/widget-sdk/react";

const client = await connectLullWidget();

function App() {
  const [prefs, setPrefs] = useLullState("prefs", { focus: 25 });
  const theme = useLullTheme();
  return <button onClick={() => setPrefs({ ...prefs, focus: 50 })}>{prefs.focus}</button>;
}

createRoot(root).render(
  <LullProvider client={client}>
    <App />
  </LullProvider>,
);
```

Vue 3：

```ts
import { createApp, defineComponent, h } from "vue";
import { connectLullWidget } from "@lull/widget-sdk";
import { createLullPlugin, useLullState } from "@lull/widget-sdk/vue";

const client = await connectLullWidget();
const App = defineComponent({
  setup() {
    const [prefs] = useLullState("prefs", { focus: 25 });
    return () => h("p", String(prefs.value.focus));
  },
});

createApp(App).use(createLullPlugin(client)).mount("#app");
```

## 客户端 API

`connectLullWidget(options?)` → `Promise<LullWidgetClient>`（同一页面重复调用返回同一个 Promise）

| 成员 | 说明 |
| --- | --- |
| `id` / `hostApi` / `protocol` | 插件 id、宿主 API 版本、桥协议版本 |
| `window` | 清单解析后的窗口描述（尺寸、是否透明、chrome 归属） |
| `minimizable` / `transparent` / `visible` | 当前窗口状态；`transparent` 会随 `setTransparent` 更新 |
| `capabilities` / `has(cap)` | 已授予能力（清单声明 ∩ 用户授权），未知能力恒为 `false` |
| `theme` / `viewport` | 当前主题令牌与内容区尺寸 |
| `getState(key, fallback?)` / `setState` / `removeState` | 宿主 KV 读写；键只允许字母数字与 `._-`，单值 ≤ 32 KiB，单插件 ≤ 256 KiB |
| `requestAudio()` | 音频是否被授权 |
| `requestResize(w, h)` | v1 宿主只回报测量值（`applied: false`），不会真的改窗口尺寸 |
| `startDrag()` / `minimize()` / `setTransparent()` / `close()` | 需要 `widget.chrome` 能力（`close` 不需要） |
| `log(message, level?)` | 转发到宿主控制台，前缀 `[plugin:<id>]` |
| `onTheme` / `onViewport` / `onVisibility` | 订阅并**立刻回放当前值**，返回退订函数 |
| `request(method, params)` | 直接调用桥方法，参数与返回值按 `WidgetBridgeMethods` 推导 |
| `destroy()` | 退订全部监听并拒绝未完成请求，之后所有调用返回 `disposed` |

错误统一抛 `LullWidgetError`，用 `code` 分支，不要匹配文案：

| code | 场景 |
| --- | --- |
| `not-embedded` | 不在宿主 iframe 里（顶层页面/SSR） |
| `init-timeout` | 宿主没在超时前发 `init`（默认 10s） |
| `bad-init` | 协议版本不符或缺少 `token` |
| `timeout` | 单次请求超过 8s |
| `host-error` | 宿主拒绝（未授权、未知方法、参数非法等），`message` 为宿主给的原因 |
| `disposed` | 客户端已 `destroy()` |

## 桥方法

| method | params | result |
| --- | --- | --- |
| `state.get` | `{ key }` | `{ value }` |
| `state.set` | `{ key, value }` | `{ saved }` |
| `state.remove` | `{ key }` | `{ removed }` |
| `audio.request` | `{}` | `{ granted }` |
| `resize.request` | `{ width, height }` | `{ width, height, dpr, applied }` |
| `window.startDrag` | `{}` | `{ dragging }` |
| `window.minimize` | `{}` | `{ minimized }` |
| `window.setTransparent` | `{ transparent, color }` | `{ transparent }` |
| `close` | `{}` | `{ closed }` |
| `log` | `{ level, message }` | `{ logged }` |

宿主 → 插件：`init` / `theme` / `viewport` / `visibility` / `response`（字段见 `src/protocol.ts`）。
全部消息带 `v: 1`；请求还要带宿主在 `init` 里下发的 `token`，宿主据此拒收冒名请求。

## 兼容矩阵

| SDK | 桥协议 | 宿主 API | 对应 Lull | 说明 |
| --- | --- | --- | --- | --- |
| `0.2.x` | `1` | `1` | `0.1.x` | TypeScript 重写；`setState`/`startDrag` 等返回 `void`，`getState` 支持泛型与 fallback |
| `0.1.x` | `1` | `1` | `0.1.x` | 手写 JS，无类型声明 |

兼容策略：

- **桥协议**（`v`）只在字段语义破坏性变化时递增；递增后旧插件必须靠宿主兼容层继续可用。
- **宿主 API**（`hostApi`）由宿主在 `init` 里下发，插件清单用 `compatibility.hostApi` / `maxHostApi` 声明区间，宿主据此决定是否加载。
- SDK 自身遵循 semver；`0.x` 期间 `minor` 可能引入破坏性改动，升级前先看本表的“说明”列。

## 开发与测试

```bash
pnpm widgets:sdk        # tsc 构建 dist（含 .d.ts / .d.ts.map）
pnpm widgets:sdk:check  # 只做类型检查，不落盘（CI 用）
pnpm test               # 根 vitest 会跑 packages/widget-sdk/src/*.test.ts
```

测试覆盖握手、typed request、状态回退、订阅、超时、销毁与线上格式锁定；
React / Vue 适配各有组件级用例。测试辅助在 `@lull/widget-sdk/testing`：

```ts
import { createInitMessage, createMemoryTransport } from "@lull/widget-sdk/testing";
import { createLullWidgetClient } from "@lull/widget-sdk";

const transport = createMemoryTransport();
const client = createLullWidgetClient(createInitMessage({ id: "my-widget" }), { transport });
const pending = client.setState("count", 1);
transport.respond(transport.lastRequest()!.id, { saved: true });
await pending;
```

## 目录

```text
packages/widget-sdk/
  src/protocol.ts    # 线上格式、能力白名单、桥方法表
  src/errors.ts      # LullWidgetError
  src/transport.ts   # postMessage 传输（可替换）
  src/client.ts      # 握手 + 客户端
  src/react.ts       # React 适配
  src/vue.ts         # Vue 适配
  src/testing.ts     # 内存传输与 init 样例
  dist/              # tsc 产物（git 忽略，随包发布）
```

## 边界

- 插件是**不透明源 iframe**，不能访问宿主 DOM / 存储 / 窗口 API；但 WebView2 会把 Tauri
  初始化脚本注入子帧，插件里仍可能看到 `__TAURI_INTERNALS__`——它不是受支持的 API，ACL 也只授予
  本窗口的状态命令。
- 本地 ZIP 安装器与 `.lull-integrity.json` 摘要锁已落地；仍没有发布者签名、在线目录
  与自动更新。手动放入 `%APPDATA%\app.lull.desktop\widgets\<id>\` 的包会在启用时补锁。
- `resize.request` 在 v1 是只读探测；窗口尺寸由清单与宿主偏好决定。
- 网络访问受宿主按插件注入的 CSP 限制，白名单来自清单 `network` 字段。

许可：Apache-2.0（见仓库根 `SDK-LICENSE.md`）。
