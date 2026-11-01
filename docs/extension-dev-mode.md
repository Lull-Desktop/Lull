# 扩展开发模式与 React SDK 接入

> 状态：**设计评审稿**。本文回答两件事：迁移后的官方扩展（白噪音 / 播放器）如何只通过
> SDK 使用宿主能力；以及用 React 开发扩展时，开发模式如何与宿主、Vite、媒体桥协调。
> 与 [官方扩展](./official-extensions.md)（包格式 / 随包分发）、
> [Widget SDK](./widget-sdk.md)（包与能力契约）、[Media Service](./media-service.md)
> （媒体桥）配套阅读。
>
> 本文是计划：标 P1–P5 的部分尚未实现，实施后以代码与文档为准。
>
> **实施进度（2026-11）**：P1 的 Vite 构建、Tier 0、`extensions:watch` 与边界检查已落地；
> P2 的媒体桥、Tier 2 dev server、`widget_apply_resize` + `window.fit`、locale 与主题
> token、媒体连接 Hub 均已落地，P2 完成。P3：白噪音已迁为 `extensions/official/noise`，
> 走 `virtual:lull-messages` 与 SDK，`echo` 自检包已移除；播放器属 P4。

## 0. 一句话

生产环境只有一套契约：**标准 Widget 包 + `@lull/widget-sdk` / `@lull/media-sdk` +
不透明源 iframe**。开发环境分三级：构建监听（零宿主改动）→ Vite 开发服务器 + HMR
（仅 debug 构建、仅 loopback）→ 单命令编排。React 侧只有一个根 Provider 和一个
**共享媒体连接 Hub**；禁止每个 hook 各自 `connect` / `disconnect`。

## 1. 约束与现状

| 约束 | 影响 |
| --- | --- |
| 扩展是独立静态 Web 应用，不能 import 宿主 `src/**` | 现内置工具的 `@/hooks/use-media-client`、`@/sdk/widget`、`@/paraglide/messages` 都要换成 SDK / 包内实现 |
| iframe 是 `sandbox="allow-scripts"` 的不透明源 | 没有 localStorage / Cookie / IndexedDB；开发服务器页面同样受此限制（Vite HMR 可用，但别依赖存储） |
| 宿主壳只按 `event.source` 校验消息 | 开发服务器的 iframe（origin `null` 或 `http://127.0.0.1`）同样能握手，不需要改桥协议 |
| Rust 的媒体订阅按窗口 label 只保存一份 | 多个 hook 各自 `media.connect` 会互相覆盖，`disconnect` 会清空别人的订阅 |
| 当前开发模式只挂本地目录、由 `lullwidget://` 读静态产物 | 没有 dev server / HMR；改完必须点「重载」 |
| 生产 CSP 不包含 localhost | 开发服务器只能在 `tauri.conf.json` 的 `devCsp` 里单独放行 |

## 2. 迁移扩展如何使用 SDK

### 2.1 依赖边界

| 原内置依赖 | 包内替代 |
| --- | --- |
| `@/hooks/use-media-client`、`createMediaClient` | `createWidgetMediaClient({ request, onMediaEvent })`（`@lull/media-sdk/widget`） |
| `@/hooks/use-player-session` | 包内 `_shared/use-player-session.ts`，基于共享媒体 Hub（见 2.4） |
| `@/sdk/widget`（hide / minimize / drag / resize / align） | `@lull/widget-sdk` 的 `lull.close() / minimize() / startDrag() / requestResize()` |
| `@/sdk/widget/react`（theme / fit / state） | `@lull/widget-sdk/react` + 包内 `_shared` 钩子 |
| `@/paraglide/messages` | 构建期 `virtual:lull-messages`（来自 `i18n/messages/*.json`） |
| `widgetStorageKey` / `readWidgetStorage` | `lull.getState / setState`（异步，prefs 合并成单键） |
| `@/components/ui/*`、`@/lib/*` | 包内自绘（CSS Modules）或只依赖 `lucide-react` 等 npm 包 |

强制规则（构建与 CI 检查）：

- 只允许 `@lull/widget-sdk`、`@lull/widget-sdk/react`、`@lull/media-sdk`、
  `@lull/media-sdk/react`、`@lull/media-sdk/widget`；测试可用 `@lull/*/testing`。
- 禁止 `@/`、`../src`、`@tauri-apps/api`、`window.__TAURI_INTERNALS__`、`localStorage`、
  `sessionStorage`、`eval`、远程 URL。
- React / ReactDOM 打进包内（iframe 是独立文档），不要 externalize 到宿主。
- 原生 `window.chrome = "custom"` 的包（播放器 / 白噪音）自绘顶栏，拖拽 / 最小化 /
  关闭分别走 `startDrag` / `minimize` / `close`，不要直接调 Tauri 窗口 API。

### 2.2 入口与 Provider 组合

```tsx
// extensions/official/player/src/main.tsx
const lull = await connectLullWidget();
const media = createWidgetMediaClient({
  request: (method, params) => lull.request(method as never, params as never),
  onMediaEvent: lull.onMediaEvent,
});

createRoot(document.getElementById("root")!).render(
  <LullProvider client={lull}>
    <LullMediaProvider client={media}>
      <MessagesProvider>
        <PlayerApp />
      </MessagesProvider>
    </LullMediaProvider>
  </LullProvider>,
);
```

- 握手失败（不在 iframe、8 秒超时、协议版本不符）由 `LullWidgetError` 的 `code` 分支处理，
  显示错误页 + 重试，不要静默白屏。
- HMR 整页刷新时**不主动** `media.disconnect`：旧页面晚到的断开可能杀掉新页面的连接。
  下一次 `connect` 会覆盖同一窗口 label 的订阅，媒体状态用快照恢复；窗口销毁时宿主
  自动清理。`import.meta.hot?.dispose()` 只销毁 bridge client 的监听与挂起请求。
- 不要在组件树里重复 `connectLullWidget()`；它是模块级单例，但 Provider 只应创建一次。

### 2.3 React 状态、主题、本地化、视口

| 关注点 | 用法 |
| --- | --- |
| 持久状态 | `useLullState(key, fallback)`（Rust KV）；首帧用默认值，挂载后再读；一个工具只用一个 prefs 键 |
| 主题 | `useLullTheme()` 取主题与 token map；`<ThemeTokens>` 写入 `:root` CSS 变量；包内带 fallback |
| 本地化 | `useLullLocale()` / `useLullMessages()`；宿主 `i18n-locale-changed` 广播后重渲染，不重建窗口 |
| 视口 | `useLullViewport()`；`useWidgetFit(ref)` 按内容贴高（清单 `window.fit: "content"`） |
| 窗口宽度 | 播放器用 `requestResize({ width, anchor })`，范围由清单 `[minWidth, width]` 限定 |
| 可见性 | `useLullVisibility()`：隐藏时停动画 / 降频；宿主音频会话不受影响 |
| 音频 | `requestAudio()` 拿到授权后再建 UI 音效的 `AudioContext`；主音频由宿主引擎输出，包内不放播放器引擎 |

### 2.4 共享媒体连接 Hub（关键设计）

**问题**：Rust 的 `media_connect` 按窗口 label 保存一份订阅（后一次覆盖前一次），
`media_disconnect` 清空整份。而播放器同时需要 `player.*`、`queue.*`、`library.*`，
白噪音需要 `noise.*`；如果每个 React hook 各自 connect/disconnect，会互相踢掉订阅；
StrictMode 的双调用与 HMR 刷新还会造成连接抖动和事件丢失。

**设计**：在 media-sdk 增加 `MediaSessionHub`，由 `LullMediaProvider` 为每个 client
持有一个实例：

```text
usePlayerSession ─┐
useNoiseSession ──┼─► MediaSessionHub ──► client.connect(union topics)
useLibrary     ──┘        │
                          ├─ 快照合并（player / queue / noise / output）
                          ├─ 事件分发（按 topic + revision 去重）
                          └─ 状态：connected / error / revision
```

规则：

1. **按需求并集连接**：订阅者登记自己需要的 topic / `progressMs` / `levels`；
   只有并集扩大时才重新 `connect`（Rust 覆盖订阅并返回新快照），并集缩小时不重连。
2. **不在最后一个订阅卸载时立即 disconnect**：StrictMode / 路由切换会短暂归零；
   连接保留到 `destroy()` 或宿主窗口销毁。订阅归零只停止分发。
3. **快照 + revision**：hub 用 `connect` 返回的快照初始化各域 store；事件带 revision，
   小于当前快照的直接丢弃（与 `usePlayerSession` 现有逻辑一致）。
4. **单事件监听**：`client.events.on` 只注册一次，hub 分发给所有 hook；
   避免每个 hook 各挂一个监听器。
5. **能力过滤**：hub 只请求清单已声明且已授权的能力对应 topic；未授权的域保持空状态，
   `capability.denied` 在诊断面板可见。

公开 API（`@lull/media-sdk/react`，Experimental）：

```ts
const status = useMediaStatus();            // { connected, error, revision }
const player = usePlayerSession();          // player/queue/actions（官方播放器用）
const noise = useNoiseSession();            // 现有 API，内部改为走 hub
useMediaEvent("library.changed", () => {});
```

`useNoiseSession` / `useNoiseLibrary` / `useNoisePresets` 的现有签名保持不变，内部从
`NoiseStore` 迁到 hub；新增 `usePlayerSession` / `useQueue`，供官方播放器与第三方复用。
`@lull/media-sdk/widget` 的传输层不变。

### 2.5 桥协议与版本握手

- init（宿主 → 包）：`protocol`、`hostApi`、`id`、`name`、`version`、`granted`、
  `requested`、`theme`（含 `tokens`）、`locale`、`viewport`、`minimizable`、`window`。
- ready（包 → 宿主）：`protocol`、`sdkVersion`（新增，便于诊断）；宿主比较
  `hostApi` 并在 debug 日志 / 诊断面板提示。
- 请求超时 8s；错误码区分 `not-embedded` / `init-timeout` / `capability.denied` /
  `method-unsupported`；UI 只按 `code` 分支，不匹配文案。
- 事件：`theme` / `locale` / `viewport` / `visibility` / `media.event`；
  同一份连接多个订阅者，事件不保证跨域顺序，但同 topic 带 revision。

### 2.6 诊断面板

- 仅 `import.meta.env.DEV` 时渲染：id / hostApi / protocol / locale / theme id /
  viewport / 已授权能力 / 媒体连接状态 / 最近 N 条桥消息。
- 生产构建由 tree-shaking 移除；宿主壳在 dev 窗口顶栏显示 `DEV · <url>` 角标（仅 debug）。
- `lull.log(message, level)` 转发到宿主控制台；不要在生产打日志。

## 3. 开发模式分级

| 级别 | 命令 | 宿主改动 | HMR | 用途 |
| --- | --- | --- | --- | --- |
| **Tier 0** 静态挂载 | `pnpm extensions:build <id>` | 无 | 无 | 验收、第三方作者、复现生产 |
| **Tier 1** 监听重载 | `pnpm extensions:watch <id>` | 无 | 手动 | 日常小改、CI 前自测 |
| **Tier 2** 开发服务器 | `pnpm extensions:dev <id>` | `devCsp` + dev URL | React Fast Refresh | 日常开发（推荐） |
| **Tier 3** 单命令编排 | `pnpm dev:ext <id>` | 无（复用 Tier 2） | 有 | 新同学一条命令起环境 |

### 3.1 Tier 0 / 1：先保证不依赖 dev server

- Tier 0：Vite 构建到 `extensions/dist/<id>/`，设置 → 扩展 → 开发模式 → 添加目录。
  与生产同一条 `lullwidget://` 路径，最接近真实。
- Tier 1：`vite build --watch` 持续输出 dist；宿主「重载」按钮刷新 iframe。适合
  不适合 HMR 的改动（入口、SDK 版本、manifest）。
- 两者都不需要改宿主 CSP 或 Rust；P1 就能落地，先让迁移有一个可用的开发闭环。

### 3.2 Tier 2：Vite dev server + HMR

**包内声明**（点号文件，不进摘要、协议不服务、构建排除）：

```json
// extensions/official/player/.lull-dev.json
{ "schemaVersion": 1, "server": "http://127.0.0.1:5274" }
```

**宿主流程**：

1. 开发模式挂载目录时读取 `.lull-dev.json`；
2. 校验：仅 `http`、host 为 `127.0.0.1` / `localhost` / `[::1]`、端口 1024–65535、
   不允许 userinfo、不允许 `..` 路径；**仅 `debug_assertions` 构建接受**；
3. `DevPackage` 增加 `entryUrl`（存 `extensions.json`），`extensions_dev_state` 返回它；
4. 打开开发包时 iframe 直接加载 dev URL；bridge token / init / 事件与静态包完全一致；
5. release 构建忽略已保存的 dev URL；若挂载目录包含 `.lull-dev.json`，release 构建会
   直接拒绝挂载并提示改用构建产物。debug 构建不加载 dev URL 时回落静态入口。

**CSP**：只在 `tauri.conf.json` 的 `devCsp` 的 `frame-src` 追加
`http://127.0.0.1:* http://localhost:*`（dev-only；若 WebView2 对端口通配支持有差异，
回落到端口表逐个列）；生产 `csp` 不变。开发服务器页面自身不带宿主 CSP。

**实现前 spike**：① `sandbox="allow-scripts"` 的不透明源下，Vite HMR WebSocket
（Origin: `null`）与 React Fast Refresh 是否可用；② `devUrl` 模式由 Next 提供壳页时
Tauri 的 `devCsp` 是否实际注入。任一不成立就回退 Tier 1（watch + 重载），不阻塞迁移。

**端口表**：`noise: 5273`、`player: 5274`；`--port` 可覆盖，`strictPort: true` 失败即报错，
不静默换端口（否则 `.lull-dev.json` 会指向空端口）。

**HMR 生命周期**：

- 组件改动 → React Fast Refresh，不丢状态；
- CSS / CSS Modules 改动 → 样式热替换；
- 入口 / Provider / bridge 模块改动 → 整页 reload；iframe `onLoad` 后宿主壳会重新
  `sendInit`（现有 `handleFrameLoad` 已覆盖），媒体连接靠下一次 `connect` 覆盖并用
  快照恢复；
- `manifest`（窗口尺寸 / 能力）改动不会热更新：关闭窗口重开，或在设置里重新挂载；
- Rust / 宿主壳 / 桥协议改动 → 重启 `pnpm dev`。

**安全边界**：

- 开发服务器入口只在 `debug_assertions` 下可用；生产包即使 `extensions.json` 里残留
  dev URL 也不加载。
- dev URL 不写入构建产物：`.lull-dev.json` 是点号文件，摘要与协议都排除；
  `extensions:check` 额外扫描 dist 里不得出现 `.lull-dev.json` 与 `localhost` / `127.0.0.1`。
- 开发包仍走同一套授权账本与 iframe 沙箱；它拿不到 Tauri IPC、bridge token 只在宿主壳。
- 开发服务器页面同样是不可信静态代码：不要在里面放凭据；它和第三方包信任级相同。
- `.lull-dev.json` 只在开发模式挂载时读取；用户安装包即使带这个文件也不会使用
  （点号路径不被扫描、不被协议服务），所以不需要在安装管线里特判。

### 3.5 宿主改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/extension/dev.rs` | `DevPackage.entryUrl`；读取 / 校验 `.lull-dev.json`；debug 守卫；`extensions_dev_state` 返回 URL |
| `src-tauri/src/widget_package/store.rs` | `effective_entry_url(app, id, entry)`：dev 包有 dev URL 时优先；`info_from` 接收可选的 dev URL |
| `src-tauri/src/widget_package/mod.rs` | `PluginContext.entryUrl` 改走 `effective_entry_url` |
| `src-tauri/src/extension/mod.rs` | `widget_info` 的 `entryUrl`；开发包重载保留 `window.reload()` |
| `src-tauri/tauri.conf.json` | `devCsp` 的 `frame-src` 放行 loopback（仅 dev；生产 `csp` 不变） |
| `src/lib/extensions.ts` / `extensions-panel.tsx` | `DevPackage.entryUrl?`；开发卡显示「开发 · URL」与不可达提示 |
| `src/components/widget-plugin-shell.tsx` | debug 角标显示 dev URL；ready 记录 `sdkVersion`；超时文案提示开发服务器未启动 |

### 3.3 Tier 3：单命令编排

- `scripts/dev-official-extension.mjs`：用 Node `child_process` 并行起
  `vite dev` 与 `pnpm dev`（不新增依赖），打印挂载路径与端口。
- 默认**不**自动改 `extensions.json`；首次挂载仍由用户在设置页确认（安全与可预期）。
- 退出时一起结束子进程；端口被占用直接失败并提示。

### 3.4 与宿主项目开发的协调

| 改动 | 动作 |
| --- | --- |
| 扩展组件 / 样式 / 文案 | Tier 2 HMR，无需重启 |
| 扩展入口、Provider、SDK 调用方式 | iframe 整页 reload；必要时 `extensions_dev_reload` |
| `@lull/*-sdk` 源码 | 另起 `pnpm sdk:watch`（tsc --watch）更新 dist；Vite 监听 dist 后整页刷新；改了桥协议同时重启宿主 |
| 宿主壳 / Rust / 命令 / CSP | 重启 `pnpm dev`；`widgets:check` 校验命令与 capability |
| `widget.json` 能力 / 窗口 | 重开窗口或重新挂载；授权在扩展中心逐项确认 |
| i18n 消息 | Vite 插件监听 `i18n/messages/*.json`，重新生成 `virtual:lull-messages`；宿主侧需 `pnpm i18n:compile` 或重启 |

**同 id 开发包的边界**：用 `noise` / `player` 挂载开发包时，开发包与官方包共用授权账本
和状态 KV（`official::reconcile` 会跳过它），列表只显示一条 `origin=dev` 的条目。
优点是能验证真实状态，缺点是开发数据会写进正式状态；需要隔离时给开发包换一个新 id
（清单 id 与目录同名），代价是状态从空开始。

## 4. 仓库与工具链

### 4.1 目录与共享层

```text
extensions/official/
  _shared/
    app-shell.tsx        # LullProvider + LullMediaProvider + MessagesProvider
    media-hub.ts         # MediaSessionHub（P2 落 media-sdk/react；风险高时先包内）
    theme-tokens.ts      # token 应用 + fallback
    i18n.ts              # virtual:lull-messages 的 React 绑定
    use-player-session.ts
    dev-diagnostics.tsx
  noise/
    .lull-dev.json       # 仅开发，不进包
    index.html           # Vite 入口
    widget.json
    src/main.tsx
    vite.config.ts       # 复用 scripts/lib/extension-vite.config.mjs
  player/
```

### 4.2 构建与开发脚本

统一用 **Vite**（生产 build + 开发 server），不再为官方扩展维护 esbuild 配置；
esbuild 继续服务 `examples/widgets/*` 的第三方示例。新增 `vite` 为根 devDependency：
仓库已通过 vitest 间接安装 7.3.1，新增直接依赖预计只改动 lockfile 的 importers 段
（实现时验证 `pnpm install --offline` 可复现）。

- `scripts/lib/extension-vite.config.mjs`：导出 `createExtensionConfig({ id, port })`：
  - `root` = 扩展目录，`base: "./"`（生产）、`build.outDir` = `extensions/dist/<id>`；
  - `resolve.alias`：`@lull/widget-sdk` / `@lull/media-sdk` → `packages/*/dist`
    （与发布物一致；不要把源码 alias 进 Vite，SDK 源码用 `.js` 扩展名导入，
    需要额外的 `.js→.ts` 插件，容易造成 dev/prod 两套解析）；
  - `server.fs.allow: [repoRoot]`（无 pnpm workspace，默认 allow 可能挡住 `packages/`）；
  - `server.host: "127.0.0.1"`、`strictPort: true`、`hmr.protocol: "ws"`；
  - `server.cors: true`：插件 iframe 是 `sandbox="allow-scripts"`，origin 为 `null`；
    Vite 默认只回显 localhost origin，模块脚本会被浏览器 CORS 拦截，表现为
    「窗口只有 DEV 角标、没有内容」；
  - React 插件、CSS Modules、`build.modulePreload.polyfill: false`；
    不引入 Tailwind（工具用 CSS Modules + token）。
- SDK 迭代：`pnpm sdk:watch`（widget-sdk + media-sdk 的 `tsc --watch`）持续更新
  `packages/*/dist`；Vite 监听 dist，变化后整页刷新。`extensions:dev` 启动前先跑一次
  `pnpm widgets:sdk && pnpm media:sdk`，避免用到旧 dist。
- `virtual:lull-messages`：Vite 插件在请求时读取 `i18n/messages/*.json`，按 locale 生成
  模块；`handleHotUpdate` 监听 JSON 变化。生产构建把结果内联进包，不依赖宿主文件。
  **当前实现**：`noise` 入口用 `HostSync` 调 `setLocale(locale)` 并包住组件子树，
  locale 变化时整体重渲染；独立的 `MessagesProvider` / `useLullMessages` 尚未抽包。
- 脚本：`extensions:build`、`extensions:dev <id>`、`extensions:watch <id>`、
  `extensions:check`、`extensions:pack`、`dev:ext <id>`（Tier 3）、`sdk:watch`；
  `prebuild.mjs` 依次构建 SDK → 扩展 → 前端；CI 调 build+check。

### 4.3 类型、lint 与边界检查

- 根 `tsconfig.json` 的 `include` 已覆盖 `**/*.ts(x)`，扩展源码直接参与 `pnpm typecheck`；
  `@lull/*` 走现有 paths。
- `biome.json` 的 `files.includes` 增加 `extensions/**`；注意仓库基线已有存量 lint 报错，
  新目录按「不新增错误」验收。
- `scripts/check-extension-imports.mjs`（新）：扫描源码里的禁用导入 / API；`extensions:check`
  先跑它，再跑 `Skill/lull-extension/lib/validate.mjs`（strict，能力白名单按 P2 补齐）。
- `vitest` 自动收集 `extensions/**/*.test.tsx`；组件测试用 `@lull/widget-sdk/testing`
  的 `createMemoryTransport` 与 `@lull/media-sdk/testing`，不需要真宿主。

### 4.4 独立 UI 预览（mock 模式）

- `pnpm extensions:dev player` 后打开 `http://127.0.0.1:5274/?mock=1`：
  entry 检测 `import.meta.env.DEV` 与查询参数，用 testing transport 注入假 host
  （capabilities / theme / locale / 快照），不依赖 Tauri。
- mock 数据与单测 fixture 共用；`?mock=1` 分支在生产构建中被 tree-shaking 移除。
- 原 `scripts/preview-liquid-player.mjs` 改为对 mock URL 截图；或迁移期保留为手动工具。

## 5. 通信协调契约

### 5.1 握手字段

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| init | `protocol` / `hostApi` | 桥协议与宿主 API 版本 |
| init | `theme.tokens` | CSS 变量白名单（见官方扩展文档） |
| init | `locale` | `zh-CN` / `en-US` |
| init | `granted` / `requested` | 已授权 / 已声明能力 |
| ready | `protocol` / `sdkVersion` | 包侧实现版本，仅诊断 |
| 事件 | `theme` / `locale` / `viewport` / `visibility` / `media.event` | 订阅式，init 后回放 |

### 5.2 重载与状态语义

| 触发 | 窗口 | 包内 JS | Rust KV | 媒体订阅 | 媒体播放 |
| --- | --- | --- | --- | --- | --- |
| HMR 组件刷新 | 保留 | 组件状态保留 | 保留 | 保留 | 继续 |
| HMR 整页 reload | 保留 | 重建 | 保留 | 重连后快照 | 继续 |
| `extensions_dev_reload` | 重建 WebView | 重建 | 保留 | 重连 | 继续 |
| 关闭窗口 | 隐藏 | 继续 | 保留 | 保留 | 继续 |
| 停用扩展 | 销毁 | 结束 | 保留 | 断开 | 停止（官方媒体工具） |

### 5.3 版本与兼容

- `hostApi` 是能力面版本（当前 1）；`protocol` 是桥消息版本（当前 1）；两者独立。
- 破坏性改动才升版本；官方扩展与 SDK 在同一个仓库、同一个 PR 里改，CI 用
  `widgets:check` + `extensions:check` 防漂移。
- 新增可选字段 / 新能力不升 `schemaVersion`、不升 `hostApi`；删除或改语义才升。
- 第三方包声明 `hostApi: 1`；宿主遇到更高版本拒绝加载并给出诊断（现有规则）。

## 6. 日常开发流程

1. 终端 A：`pnpm dev`（Tauri + Next 宿主，debug 构建）。
2. 终端 B：`pnpm extensions:dev noise`（Vite，5273）。
3. 首次：设置 → 扩展 → 开发模式 → 添加 `extensions/official/noise`；卡片显示
   「开发 · 127.0.0.1:5273」。
4. 改组件 / 样式 / 文案 → HMR；改入口 / Provider → 自动整页 reload。
5. DevTools 选中 `widget-noise` 窗口的 iframe 上下文；诊断面板看 hostApi / locale /
   媒体连接；桥日志用 `lull.log`。
6. 提交前：`pnpm extensions:build && pnpm extensions:check`；CI 同。
7. 验收前：Tier 0 挂 `extensions/dist/noise`，确认与生产同路径。

## 7. 失败模式与诊断

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 窗口一直隐藏 / 8 秒超时 | dev server 未起、端口不对、`devCsp` 没放行 | 检查终端 B、`.lull-dev.json`、`tauri.conf.json` `devCsp` |
| 白屏且无 ready | iframe 加载 404 / Vite 报错 | 直接浏览器打开 dev URL 看错误；看 Vite 终端 |
| HMR WebSocket 连接失败 | 端口被占 / HMR host 配错 | `strictPort` 已保证失败即报错；检查 `hmr` 配置 |
| 媒体状态不更新 | 多个 hook 各自 connect 覆盖订阅 | 统一走 Hub；确认 provider 只创建一次 |
| StrictMode 下连接抖动 | effect 清理触发 disconnect | Hub 不因订阅归零断开；连接保留到窗口销毁 / 显式 destroy |
| 主题 / 字体不对 | token 未下发 / fallback 缺失 | 诊断面板看 tokens；检查 CSS `var(--x)` 覆盖 |
| release 里看到 dev URL | 构建/校验漏了 | `extensions:check` 阻断；release 忽略 dev URL |
| 能力 / 窗口改动不生效 | manifest 不热更 | 重开窗口 / 重新挂载；授权在扩展中心确认 |
| HMR 后媒体事件丢失 | reconnect 前的事件 | Hub 用 connect 快照恢复；revision 去重 |

## 8. 阶段计划

| 阶段 | 开发模式交付 | 出口条件 |
| --- | --- | --- |
| **P1** | Vite 构建 + Tier 0/1（`extensions:watch`）+ 边界检查 | 官方包能构建、挂载、重载；无宿主 CSP/URL 改动 |
| **P2** | 媒体 Hub + player/queue/library hooks；locale/tokens/fit；Tier 2（`.lull-dev.json`、dev URL、`entry_url` 重构、devCsp、debug 守卫）；诊断面板 | React 扩展改组件即时生效；多 hook 共存不互相踢连接；release 不含 dev URL |
| **P3** | 白噪音用 Tier 2 开发，Tier 0 验收；dev 卡片显示 URL | 白噪音功能对齐；HMR 下媒体/主题/语言正常 |
| **P4** | 播放器用 Tier 2 开发；消费 P2 的 `usePlayerSession` / `useQueue`（若 P2 先落在 `_shared`，本阶段上游到 media-sdk） | 播放器功能对齐；抽屉宽度 / 封面 / UI 音效正常 |
| **P5** | Tier 3 单命令编排；文档、Skill、站点同步；安全审计 | 新同学按文档一条命令起环境；CI 全绿 |

## 9. 开放决策

1. **官方扩展统一用 Vite（替代 P0 文档里的 esbuild）**：建议是；esbuild 只保留给
   `examples/widgets/*`。理由是 React Fast Refresh、CSS Modules、资源处理与 dev server
   共用一套配置。
2. **Hub 先放包内还是直接进 media-sdk**：建议 P2 就进 `@lull/media-sdk/react`（第三方
   React 组合会遇到同样问题），官方 `_shared` 只做薄封装；若风险高，先包内、P4 上游。
3. **Tier 3 是否自动挂载**：建议不自动；首次挂载必须用户在设置页确认。
4. **是否允许第三方用 dev server**：建议允许（同一套 `extension::dev`，release 禁用），
   这样文档、脚本、排错只有一条路径。
5. **端口表固定还是动态**：建议固定 5273/5274，`--port` 覆盖；`strictPort` 失败即报错。

## 10. 验收

- [ ] 官方扩展只依赖 `@lull/*`；`check-extension-imports` 对 `@/`、Tauri API、存储 API 零命中。
- [ ] Tier 1：改组件 → 点重载 → 生效；Tier 2：改组件 < 1s 可见，改 CSS 即时。
- [ ] HMR 整页 reload 后：握手成功、KV 读取正确、媒体快照恢复、主题/语言保持。
- [ ] 同一窗口同时使用 player + queue + library（或 noise）hook 时，连接不被互相覆盖。
- [ ] StrictMode 下媒体连接不抖动；组件卸载不误伤其他订阅者。
- [ ] release 构建不加载 dev URL、CSP 未放宽；`extensions:check` 能阻断残留。
- [ ] 诊断面板在 dev 可见、生产被 tree-shake；错误页按 `code` 给出可操作提示。
- [ ] 第三方作者按本文能在 10 分钟内起一个 React 扩展（Tier 0 或 Tier 2）。

## 11. 参考

- 包格式与能力：[`docs/widget-sdk.md`](./widget-sdk.md)
- 官方扩展契约：[`docs/official-extensions.md`](./official-extensions.md)
- 媒体权限矩阵：[`docs/media-service.md`](./media-service.md)
- Widget SDK 客户端 / 传输：[`packages/widget-sdk/src/client.ts`](../packages/widget-sdk/src/client.ts)、
  [`transport.ts`](../packages/widget-sdk/src/transport.ts)
- 媒体 React hooks：[`packages/media-sdk/src/hooks.tsx`](../packages/media-sdk/src/hooks.tsx)、
  [`react.tsx`](../packages/media-sdk/src/react.tsx)
- 宿主壳：[`src/components/widget-plugin-shell.tsx`](../src/components/widget-plugin-shell.tsx)
- 开发模式：[`src-tauri/src/extension/dev.rs`](../src-tauri/src/extension/dev.rs)
