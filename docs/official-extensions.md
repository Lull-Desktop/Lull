# 官方扩展（随应用分发）

> 状态：**契约冻结，实施中**。本文是「把播放器、白噪音这类内置工具迁移为标准
> Widget 包，并随安装包分发」的实现契约。标了阶段（P1–P5）的部分尚未落地；
> 实施完成前，行为以代码为准。
>
> **实施进度（2026-11）**：P1 已落地——官方来源 / 默认授权 / 保留 id / 构建期摘要
> （`widget_package::official` + store）、Vite 构建、`extensions/dist` 资源映射、
> 便携版收录与 CI；`echo` 自检包已移除，`noise` 与 `player` 已迁移为正式官方扩展。P2 已完成：
> Widget 的 player/queue/library 媒体能力与快照裁剪、Tier 2 dev server、
> `widget_apply_resize` + `window.fit`、locale / 主题 token、媒体连接 Hub 均已落地。
> P3 代码完成：白噪音包、托盘与设置页入口、扩展中心官方徽章已接入。P4 代码完成：
> 播放器包、`window.alignPlayer`、封面兜底与设置/托盘入口已接入；剩余验收项是
> 真机打开 / 停用 / 升级 / 篡改测试，以及封面 `asset:` 与 HMR 的 WebView2 验证。
>
> 关联文档：[Widget SDK](./widget-sdk.md)（包格式、能力词汇、桥协议）、
> [扩展中心](./extension-center.md)（安装 / 启用 / 授权 / 卸载语义）、
> [Media Service](./media-service.md)（媒体桥与权限矩阵）、
> [扩展开发模式](./extension-dev-mode.md)（React SDK 用法、Vite dev server、HMR）、
> [架构与模块边界](./architecture.md)（模块图与构建流程）。

## 0. 一句话

官方扩展 = **按同一套 Widget 标准构建、由安装包携带、由宿主按来源识别的包**。
它仍运行在 `sandbox="allow-scripts"` 的不透明源 iframe 里，宿主能力仍只能走
`@lull/widget-sdk` 的 postMessage 桥；与第三方扩展的唯一区别是**分发方式与授权策略**。

## 1. 目标与边界

### 1.1 目标

- 安装包（MSI / NSIS / 便携版 zip）自带 `noise` 与 `player` 两个标准 Widget 包，
  首次启动默认启用，托盘与扩展中心可直接打开。
- 扩展中心把它们显示为「官方 · 随应用分发」：可停用 / 重新启用、查看详情与能力，
  **不可卸载**；用户安装包不能占用这两个 id。
- 行为与迁移前一致：
  - 白噪音：五层声景、本地轨、Preset、睡眠定时、主音量 / 静音、窗口贴合内容高度、
    关窗即隐藏、多窗口状态同步。
  - 播放器：在线氛围曲与本地曲目、封面、530↔880 曲库抽屉与左右停靠、进度 / 音量 /
    播放模式、UI 音效、关窗继续播放。
- 官方包随 App 升级：授权与用户状态保留，新增能力自动补授，用户此前的撤销保持撤销。
- 完整性由构建期摘要锁保证，运行时只读复核；缺锁 / 摘要不符拒绝加载并可诊断。

### 1.2 非目标

- 在线市场、自动更新、版本回滚、远端撤销列表。
- 把资料库（`library`）、番茄钟（`pomodoro`）、设置窗（`settings`）包化。资料库继续
  作为宿主内置的数据管理界面存在。
- 给官方包开放 Tauri IPC、同源 localStorage、`window_set_frame` 或任何「官方专属能力」。
- 跨平台（仍只支持 Windows x64）。

## 2. 与第三方扩展的差异

| 维度 | 官方 bundled | 第三方 user |
| --- | --- | --- |
| 位置 | 安装目录 `extensions/`（只读） | `%APPDATA%\app.lull.desktop\widgets\` |
| 识别方式 | 资源路径 + 保留 id（不由清单声明） | 用户目录扫描 |
| 授权 | 首次启动自动启用并授予声明能力；新版本新增能力自动补授 | 用户手动启用并逐项授权 |
| 完整性 | 构建期 `.lull-integrity.json`，运行时必须存在且匹配 | 安装时 TOFU 补锁，运行时复核 |
| 发布者签名 | 不参与社区签名策略；扩展中心不展示签名警告 | 现有策略不变 |
| 卸载 | 只能停用 / 恢复默认，文件只读 | 可卸载 |
| 升级 | 随 App 发布（扩展版本独立），启动时协调授权与清单哈希 | 手动覆盖安装 |
| 能力 | **与第三方完全相同**，没有官方专属能力 | 同左 |

`origin` 由宿主按解析到的目录判定（`user` / `dev` / `bundled`），**不读取清单里的
`builtin` 字段**。官方包的 `widget.json` 仍写 `builtin: false`，避免把信任写进一个
可被编辑的文件。

## 3. 包格式

### 3.1 清单

沿用 [Widget SDK](./widget-sdk.md) 的 `widget.json`（`schemaVersion: 2`），不新增必需
字段；仅增加两个可选字段，因此**不升 `schemaVersion`**：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `order` | number | 100 | 托盘与扩展中心的排序；官方工具建议 `player: 10`、`noise: 30` |
| `window.fit` | `"none" \| "content"` | `"none"` | 是否允许按内容高度调整窗口（白噪音用 `content`） |

其余规则不变：`id` 与目录同名、`license` 必填、`hostApi: 1`、`entry` 为包内相对
`.html`、窗口尺寸 320×240 – 1600×1200、单包 ≤ 5 MB（硬上限沿用安装管线的 64 MB）。

### 3.2 保留 id

`noise`、`player` 是保留 id（`src-tauri/src/widget_package/official.rs` 的常量表，
后续随官方包扩展）。规则：

- 用户从文件安装时命中保留 id → 拒绝，错误码 `manifest.id-reserved`；
- 开发模式可以临时挂载同名目录做本机调试（列表标「开发」），关闭开发模式后恢复官方包；
- App 升级时如果发现历史用户包占用了保留 id，不删除文件：官方包优先加载，用户包标为
  `invalid` 并给出「与官方扩展 id 冲突」的诊断。

### 3.3 版本与摘要

- 官方包版本是独立语义化版本（首版 `1.0.0`），内容变化就 bump；不要求与 App 版本同号。
- 构建期生成 `.lull-integrity.json`：算法与 `src-tauri/src/widget_package/digest.rs`
  一致（`lull-widget-package\0 + id\0 + version\0 + Σ(path\0 size\0 bytes\0)`，排除
  点号路径），`source: "declared"`。官方包不生成、也不校验 `.lull-signature.json`。
- 运行时要求 bundled 包的摘要锁**存在且匹配**：缺锁或摘要不符都拒绝加载，不自动补锁。

## 4. 构建与随包分发

### 4.1 目录

```text
extensions/
  official/
    _shared/                  # 构建期声明（virtual messages 类型等）
    noise/                    # P3 已迁移：React + CSS Modules，只依赖 @lull/*-sdk
      widget.json
      index.html
      src/
    player/                   # P4 已迁移：React + CSS Modules + Media Hub 会话
      widget.json
      index.html
      src/
  dist/                       # 构建产物（gitignore；.gitkeep 保留目录供 resources 指向）
  README.md                   # 维护者说明：如何新增 / 构建 / 调试官方扩展
```

构建后的 `extensions/dist/<id>/` 就是可直接安装的标准包（去掉 `.lull-integrity.json`
后就是可分发的 `.lull-widget.zip` 内容），与第三方包没有格式差异。

### 4.2 构建脚本

新增 `scripts/build-official-extensions.mjs`：

1. 读取每个 `extensions/official/<id>/widget.json`；
2. Vite 构建（`vite build`）：`base: "./"`、`target: es2022`、React 插件、
   CSS Modules 原生支持；`@lull/widget-sdk` / `@lull/media-sdk` alias 到
   `packages/*/dist`（构建前先跑 `pnpm widgets:sdk && pnpm media:sdk`）；
   `index.html` 作为入口，产物直接落到 `extensions/dist/<id>/`；
3. 包内 `messages.js` 由 Vite 的 `virtual:lull-messages` 插件从
   `i18n/messages/{zh-CN,en-US}.json` 生成；`assets/` 按相对路径输出；
4. 校验：`Skill/lull-extension/lib/validate.mjs`（strict；能力白名单需先按 §13 补齐）
   + 无远程 URL、无 `@tauri-apps/api` / `__TAURI_INTERNALS__` / `localStorage` / `eval`、
   体积预算、CSS `var(--x)` 令牌覆盖；
5. 用共享的 `scripts/lib/widget-digest.mjs`（从 `scripts/pack-widget.mjs` 抽出）计算
   摘要并写 `.lull-integrity.json`；
6. 产出 `extensions/dist/index.json`（`id / version / digest / order`），供诊断与 CI
   断言；`--check` 模式只校验、不改文件。

构建工具从 esbuild 改为 Vite：官方扩展需要 React Fast Refresh、开发服务器与
CSS Modules 的同一套配置，详见 [扩展开发模式](./extension-dev-mode.md)。esbuild 继续
服务 `examples/widgets/*` 的第三方示例。

`package.json` 新增脚本：`extensions:build`、`extensions:dev <id>`、
`extensions:watch <id>`、`extensions:check`、`extensions:pack`。
`scripts/prebuild.mjs` 在 i18n 编译之后、Next 构建之前调用 `extensions:build`；
`pnpm check` 与 CI 调用 `extensions:build && extensions:check`。

### 4.3 随安装包分发

- `src-tauri/tauri.conf.json` 的 `bundle.resources` 增加
  `"../extensions/dist": "extensions"`，安装后位于 `<安装目录>/extensions/`。
- 便携版：`scripts/package-release.mjs` 必须把 `src-tauri/target/release/extensions/`
  一起打进 `Lull_<ver>_x64-portable.zip`；目录缺失直接失败，不允许发出缺资源的包。
- CI：`frontend-test.yml` 增加扩展构建与校验；`release.yml` 走 `prebuild` 自动构建。
- `.gitignore` 增加 `extensions/dist/`。

### 4.4 开发与预览

开发模式分三级，完整设计见 [扩展开发模式](./extension-dev-mode.md)：

- **Tier 0**：`pnpm extensions:build <id>` → 挂载 `extensions/dist/<id>/`，与生产同路径，
  用于验收。
- **Tier 1**：`pnpm extensions:watch <id>` 持续构建，宿主「重载」按钮刷新；P1 可用。
- **Tier 2**：`pnpm extensions:dev <id>` 起 Vite dev server（5273 / 5274），包内
  `.lull-dev.json` 声明地址；宿主仅在 debug 构建、仅 loopback 时直接 iframe 加载它，
  React Fast Refresh 生效；生产 CSP 不放宽。

现有 `scripts/preview-liquid-player.mjs` 依赖内置 `/player` 路由；迁移后改为对
「构建产物 / mock 模式」截图，或在迁移阶段暂时保留为手动工具、不阻塞发布。

## 5. 来源、保留 id 与默认授权

### 5.1 资源根

`widget_package::official::root(app)` 解析顺序：

1. `LULL_EXTENSIONS_DIR`（测试 / 本机调试覆盖）；
2. `app.path().resource_dir()/extensions`（安装版；便携版与 exe 同级，需实测确认）；
3. 开发态回落 `CARGO_MANIFEST_DIR/../extensions/dist`（仅当目录存在）；
4. 都不存在 → 空列表 + 日志，不 panic。

### 5.2 解析顺序

`store::resolve_dir`：开发包（dev 模式挂载）→ 官方 bundled → 用户安装包。

- 官方 id 在用户目录出现时不会覆盖官方包（官方优先）；升级冲突按 §3.2 处理。
- 用户包 / 第三方包继续按现有逻辑从 `%APPDATA%/widgets` 解析。

### 5.3 首次启动与升级协调（`official::reconcile`）

在 `setup` 中、`i18n::init` 之后、`tray::init` 之前执行，逐包处理：

```text
无授权记录            → enabled = true；granted = 声明能力；manifestHash = 当前哈希
有记录                → enabled 保持不变
                      granted = (旧 granted ∩ 新声明) ∪ (新声明 − 旧声明)
                      manifestHash = 当前哈希
声明里已移除的能力    → 从 granted 丢弃
资源里已消失的官方包  → 只清 source=bundled 的授权记录，保留状态 KV
```

- 新增能力自动补授，用户此前撤销过的能力保持撤销（因为它在旧声明里、只是不在旧
  granted 里）。
- 当前以开发模式挂载的同 id 包（`origin=dev`）跳过 reconcile，避免官方清单哈希覆盖
  开发包的授权与状态；关闭开发模式后下一次启动恢复正常协调。
- bundled 来源的 `review_required` 恒为 false：清单哈希由 reconcile 维护，不触发
  「清单漂移，请重新授权」。
- `.grants.json` 的记录增加 `source: "bundled" | "user"`；旧记录缺省按 user 处理。
- 停用官方媒体工具时销毁窗口并停止其拥有的媒体会话（`noise` 停 Session，`player`
  暂停播放），避免「没有 UI 但还在响」；重新启用后重新建窗。

## 6. 完整性、签名与升级

- 缺 `.lull-integrity.json` 或摘要不符 → 不加载、不建窗，扩展中心显示
  `tampered` / `invalid` 与原因；修复方式只有重装应用。
- 官方包不参与 `src-tauri/trust/publisher-keys.json` 的发布者签名策略；扩展中心在
  `origin=bundled` 时不展示签名行。
- 安装目录通常位于 `Program Files`，**任何路径都不得对官方包写文件**（包括 TOFU 补锁、
  摘要刷新、状态 KV）；状态 KV 仍写 `%APPDATA%`。
- 升级不提供单独回滚；回滚 App 版本时会按旧资源重新 reconcile。

## 7. 能力模型与媒体桥（P2）

官方包与第三方共用一套能力；以下能力同时对第三方开放（Experimental），不在本文之外
另设隐藏能力。

| 能力 | 覆盖方法 | topic / 快照 | 用途 |
| --- | --- | --- | --- |
| `media.player.read` | `player.getState` | `player.state`、`player.progress`、`player.level`、snapshot.player | 播放器状态与进度 |
| `media.player.control` | `play` / `pause` / `resume` / `stop` / `seek` / `next` / `previous` / `setMode` | — | 播放控制 |
| `media.player.volume.write` | `setVolume` / `setMuted` | — | 播放器音量 |
| `media.queue.read` | `queue.get` | `queue.changed`、snapshot.queue | 队列视图（只读） |
| `media.queue.write` | `queue.add` / `remove` / `clear` / `move` / `playAt` | — | 加入队列与队列调整 |
| `media.library.read` | `listTracks` / `getTrack` / `getCoverUrl` / `listArtists` / `listAlbums` | `library.changed` | 曲目与封面 |
| `media.library.favorites.write` | `favorites.set` | — | 播放器喜欢按钮 |
| `media.library.sources.write` | `library.addSource` / `startScan` | — | 播放器「添加音乐文件夹」（见 §13） |

现有 8 个 `media.noise.*` 能力不变；`widget.media` 仍是总开关。

规则：

- `media_connect` 至少需要一项 read 能力；topic 白名单 = 已授权 read 能力的并集；
- `widget_snapshot(granted)` 决定快照是否包含 player / queue，revision 也只取被授权域；
- 封面优先复用 `convert_file_src` 的 `asset:` URL，插件 CSP 在 `media.library.read`
  授权时追加 `img-src ... asset: http://asset.localhost https://asset.localhost`；
  若 opaque-origin iframe 被 CORP 拦截，改由 `lullwidget://<id>/__artwork/<trackId>`
  提供（同一处理器内校验授权），SDK API 不变；
- `library.changed` 目前仍由资料库全局广播（官方窗口依赖）；Widget 侧已把它纳入
  topic 白名单，后续再收口到 `media::events` 的订阅过滤；
- 未授权方法返回 `capability.denied`；`media.noise.*` 的现有方法映射保持不变。

## 8. 包级窗口契约（P2）

- 清单 `window.fit: "content"` 允许按内容高度调整；默认 `none`。
- `resize.request` 真正生效：参数 `{ width?, height?, anchor?: "left" | "right" }`，
  返回 `{ width, height, dpr, applied }`。
  - 仅当已授予 `widget.chrome` 时可用；
  - 宽度 ∈ `[minWidth, width]`（初始宽度即上限，覆盖播放器 530↔880），按 `anchor`
    固定对侧边；高度 ∈ `[minHeight, min(工作区高度 − 48, 1200)]`，固定顶边；
  - 越界 / 无法应用时返回 `applied: false` 并记录原因，不抛给插件。
- 新增 Rust 命令 `widget_apply_resize`，内部复用 `window_frame` 的原子
  `SetWindowPos`；包**不能**调用 `window_set_frame`。命令进 `lib.rs`、
  `build.rs APP_COMMANDS`，并跑 `scripts/gen-widgets.mjs` 重生成 capability。
- `window.fit: "content"` 的包，宿主壳延迟 reveal 到第一次成功贴高；保留现有 4 秒
  兜底显示。
- SDK：`requestResize` + React `useWidgetFit`；官方白噪音用它贴高，播放器用它做抽屉
  宽度与左右锚点。

## 9. 本地化、主题令牌与字体（P2）

### 9.1 本地化

- `PluginContext` 增加 `locale`；init 消息带 `locale`；宿主监听
  `i18n-locale-changed` 后广播 `{ type: "locale" }`。
- SDK 增加 `locale` 与 `onLocale`；官方包在构建时把
  `i18n/messages/{zh-CN,en-US}.json` 编译成包内 `messages.js`（轻量 `m` shim，
  不依赖 Paraglide 运行时），入口按 `onLocale` 切换。
- 扩展中心、托盘、设置页里的官方名称 / 描述由宿主的 `widget_<id>_name` /
  `_description` 消息键提供（这些键已存在），Rust 在 `origin=bundled` 时覆盖清单
  里的中文原文；包内文案走包自己的 messages。

### 9.2 主题令牌

- `theme` 消息增加 `tokens: Record<string, string>`（`--font-*`、`--paper`、
  `--bamboo*`、`--flow-*`、`--color-*`、圆角 / 阴影等）；SDK 写入 iframe `:root`。
- 宿主壳维护一份令牌白名单（计划落在 `src/lib/widget-theme-tokens.ts`）；包内附
  `fallback-tokens.css`。构建检查「包 CSS 引用的每个 `var(--x)` 要么在 fallback、
  要么在宿主白名单里」。
- 透明度、`color-scheme: dark` 的坑沿用 Widget SDK 的现有说明。

### 9.3 字体

- 不把 17 MB 的 Noto Sans SC 塞进每个包。新增
  `http://lullwidget.localhost/__shared/fonts/<alias>`（非 Windows 为
  `lullwidget://__shared/fonts/<alias>`）：宿主协议的特殊前缀，从嵌入的前端资源
  （`asset_resolver`）按 prebuild 生成的别名表读取，`Cache-Control: immutable`。
  `font-src` 已允许同源。
- 实现前先做 Tauri 2.12 `asset_resolver` 真机验证；不可行则退化为系统字体栈
  （`Noto Sans SC → Microsoft YaHei → system-ui`），并在发布说明记录视觉差异。

## 10. 迁移顺序与移除清单

| 阶段 | 内容 |
| --- | --- |
| P1 | 官方来源、默认授权、构建/资源/便携版骨架（曾用 echo 包验证，验证后移除） |
| P2 | 播放器 / 队列 / 曲库能力，`widget_apply_resize` + `fit`，locale / tokens，示例包验证 |
| P3 | 白噪音迁移：移动 UI、包构建、托盘 / 设置 / 扩展中心整合，删除内置 noise |
| P4 | 播放器迁移：移动 UI、播放器会话 hook、封面、抽屉宽度/锚点，删除内置 player || P5 | 发布加固：便携版、CI、升级 / 篡改 / 缺资源测试、文档与 Skill 同步 |

迁移后删除（git 历史保留）：

- `src/app/(widgets)/noise/`、`src/app/(widgets)/player/`（均已完成）及对应测试；
- `src/components/ether-bubbles/`、`src/components/liquid-player/`（均已完成）；
- `src/hooks/use-player-session.ts`（已完成）；
- `src/widgets/manifests/noise.json`、`player.json`（均已完成，及 `gen-widgets` 生成的
  capability 文件）；
- `src-tauri/src/media` 中只为 `noise` / `player` label 服务的官方矩阵分支。

保留：`library`、`pomodoro`、`settings` 的内置窗口与 Media 面板；`media-engine`
隐藏音频引擎不变。数据方面，旧内置工具的 localStorage 偏好（启动静音、播放模式/
音量）会一次性重置；播放器模式/音量与白噪音主音量以 Rust `player_state` /
`noise_preferences` 为准，不丢数据。

## 11. 失败模式与诊断

| 场景 | 处理 |
| --- | --- |
| 资源目录缺失 / 被杀软隔离 | 官方包不出现；扩展中心诊断「官方扩展缺失，请重装应用」；不建窗、不 panic |
| 摘要锁缺失 / 摘要不符 | 拒绝加载，卡片 `tampered` / `invalid` + 原因；不写盘、不自动修复 |
| Program Files 只读 | 官方包全程只读；禁止 TOFU 补锁、摘要刷新与状态写入 |
| 升级后清单 / 能力变化 | reconcile 更新哈希、补授新增能力、保留撤销；用户停用状态不丢 |
| 用户历史包占用保留 id | 官方优先；用户包标 `invalid` 并提示卸载，不静默删除 |
| 停用官方媒体工具 | 销毁窗口并停止噪声 Session / 暂停播放，避免无 UI 出声 |
| 封面 `asset:` 被拦 | 切 `lullwidget://<id>/__artwork/<trackId>`，同一处理器内校验授权 |
| 字体服务不可用 | 回退系统字体栈；token fallback 保证布局不塌 |
| 宽度 / 高度请求越界 | 夹取到清单范围与工作区；返回 `applied: false` 并记录原因 |
| 便携版漏收 `extensions/` | `package-release.mjs` 直接失败，不产出缺资源的包 |

## 12. 验收

- [ ] MSI / NSIS / 便携版安装后，`noise` 与 `player` 默认可用，托盘与扩展中心入口正确。
- [ ] 扩展中心显示「官方」徽章，可停用 / 重新启用，不能卸载；停用后无残留播放。
- [ ] 白噪音与播放器的功能逐项对齐（见 §1.1），封面、抽屉宽度、贴高正常。
- [ ] App 升级后官方包更新、用户停用状态与状态 KV 保留、清单不再触发 `needs-review`。
- [ ] 篡改 / 删除官方包文件后拒绝加载并给出诊断；重装后恢复。
- [ ] zh-CN ↔ en-US 切换后，两个工具窗、扩展中心与托盘名称同步。
- [ ] `pnpm typecheck`、`pnpm test`、`pnpm widgets:check`、`pnpm extensions:check`、
      `cargo test`、`cargo clippy` 通过；`biome` 无新增错误。
- [ ] 文档、Skill 标准与站点文档同步检查通过。

## 13. 已定决策与待补

已随方案批准：

1. 官方包**不可卸载**，只能停用 / 恢复默认。
2. 播放器保留「添加音乐文件夹」：新增 `media.library.sources.write`（仅打开系统
   文件夹选择器并触发扫描）。若 P4 验收认为风险偏高，降级为「请到设置 → 音乐库
   添加来源」，并删除该能力。
3. 字体优先走宿主共享字体服务；不可行时接受系统字体回退。
4. 官方包不在官网单独分发 zip：保留 id 使安装到其它实例会被拒绝；构建产物仅供
   审计与开发验证。

P0 契约修订（2026-11，随开发模式设计补充）：

1. 官方扩展统一用 **Vite** 构建（dev server 与生产 build 同一套配置），esbuild 只保留
   给 `examples/widgets/*`。
2. 开发模式分 Tier 0–3；Tier 2 的 dev server 只在 debug 构建、仅 loopback 可用，
   细节见 [扩展开发模式](./extension-dev-mode.md)。
3. `official::reconcile` 跳过当前以开发模式挂载的同 id 包（见 §5.3）。
4. SDK 侧新增共享媒体连接 Hub（`media_connect` 按 label 唯一，多个 React hook 不能
   各自 connect），归属与阶段见 [扩展开发模式](./extension-dev-mode.md) §9。

待补：

- `resource_dir()` 在安装版 / 便携版下的精确落点与 `asset_resolver` 读嵌入字体的
  真机验证（P1/P2 的 spike，结论回写本节）。
- 官方包冷启动耗时与内存占用的基线（P3/P4 记录，不设硬门槛）。
- `media.library.sources.write` 是否在 P4 保留（见上）。
- ~~`Skill/lull-extension` 校验器只列 7 个 widget 能力~~：已补齐到 23 项
  （含 8 个 `media.noise.*`、8 个 Player/Queue/Library 能力），`self-test` 通过。

## 14. 参考

- 包格式与能力：[`docs/widget-sdk.md`](./widget-sdk.md)、
  [`packages/widget-sdk/README.md`](../packages/widget-sdk/README.md)
- 扩展中心状态机与安装管线：[`docs/extension-center.md`](./extension-center.md)
- 媒体权限矩阵：[`docs/media-service.md`](./media-service.md)
- 摘要算法：[`src-tauri/src/widget_package/digest.rs`](../src-tauri/src/widget_package/digest.rs)、
  [`scripts/pack-widget.mjs`](../scripts/pack-widget.mjs)
- 扩展标准：[`Skill/lull-extension/references/extension-standard.md`](../Skill/lull-extension/references/extension-standard.md)
