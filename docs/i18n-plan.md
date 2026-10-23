# 多语言（i18n）实施方案

> 状态：方案 v1，已在 v0.1.0 基线落地**阶段 0**（见 §11 实施记录）。目标版本 v0.2.0。本文描述**要做什么、按什么顺序做、怎么验收**，不涉及具体文案确定稿。
>
> 相关文档：[架构与模块边界](./architecture.md) · [内容格式](./content-format.md) · [Widget SDK](./widget-sdk.md)

## 1. 结论先行

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 前端方案 | **Paraglide JS 2.x**（`@inlang/paraglide-js`） | 编译期产出 `m.xxx()` 纯函数，无运行时 Provider / Hook 开销；键名与参数有 TS 类型；单条消息可被 tree-shake |
| 是否引入第二套库 | **不引入** | 同一层出现两套翻译库，键命名、复数规则、回退链会分叉 |
| URL 是否带 locale 前缀 | **不带** | `output: "export"` 静态导出 + Tauri 多窗口（`/setting`、`/player`、`/pomodoro`、`/noise`、`/embed`），加 `[locale]` 段要改全部路由、capability、窗口 url 与托盘跳转，收益为零 |
| 当前语言的事实源 | **Rust 侧 `preferences.json`**，启动时一次性解析并注入各窗口 | 托盘在 `setup()` 里建菜单，早于任何 WebView 加载；只有 native 先知道语言，才能避免"启动后语言跳变" |
| 消息源 | 仓库根 `i18n/messages/*.json`（inlang message format） | 一份源，两个消费端：Paraglide 编译成 JS；Rust `include_str!` 走同一份 JSON |
| 源语言 / 回退基准 | `zh-CN`（baseLocale） | 现有文案全部是中文，缺译时回退到"看得懂的中文"，而不是 `player_no_track` 这种键名 |
| 支持语言 | `zh-CN`、`en-US` 两种；**不做繁体** | 繁体系统回落到简体（不是英文）；将来要加语言，只需加一份消息文件 + `SOURCES` 一行，键集由测试强制对齐 |
| 迁移方式 | 按界面分批迁移，**不做自动抽取** | 现有中文在 JSX、模板字符串、三元表达式、`aria-label` 里都有，自动抽取极易产出一堆 `text_1` 垃圾键 |

## 2. 现状盘点

统计口径：`src/**/*.ts(x)` 排除 `*.test.*`。

| 指标 | 数值 |
| --- | --- |
| 含中文的文件 | 80 |
| 含中文的行（含注释） | 1268 |
| 文案最密集的文件 | `liquid-player.tsx`(105) · `liquid-pomodoro.tsx`(96) · `extensions-panel.tsx`(94) · `setting/page.tsx`(61) · `ether-bubbles.tsx`(46) |
| Rust 侧含中文的文件 | 31（`tray.rs`、`window_host/spec.rs`、`extension/*`、`wallpaper/*`、`config/mod.rs`） |

三处结构性障碍，决定了实施顺序：

1. **文案不是集中在组件里**。`src/widgets/manifests/*.json` 的 `name`/`title` 经 `build.rs` 生成 `$OUT_DIR/widget_specs.rs`，同时被 `tray.rs`（菜单）、`window_host`（窗口标题）和 TS 的 `registry.ts`（设置页列表）三处消费。改一处显示名，要同时改 TS、JSON 和 Rust 世界。
2. **Rust 错误字符串直接进 UI**。设置页 `catch((err) => setWindowPrefsMsg(\`保存失败：${String(err)}\`))` 这类写法把中文错误串从 IPC 一路透传到界面，前端无法翻译。
3. **测试按中文文案断言**。`setting/page.test.tsx`(69 处)、`liquid-player` 相关测试大量 `getByText("偏好")`，迁移文案会连带打断测试；这是迁移成本里最容易被低估的一块。

## 3. 目标架构

```text
i18n/messages/{zh-CN,en-US}.json           ← 唯一消息源（inlang message format）
        │
        ├── compile (构建期, scripts/i18n-compile.mjs)
        │      └→ src/paraglide/{messages.js,runtime.js}   ← 前端 m.xxx()，带类型
        │
        ├── include_str! (Rust 编译期)
        │      ├→ src-tauri/src/i18n/mod.rs   → t(key) / t_with(key, params)
        │      └→ build.rs 生成 msg_key.rs    → 键名常量（写错键 = 编译失败）
        │
        └── scripts/i18n-check.mjs (CI) → 缺失键 / 多余键 / 参数不一致 / 未使用键
```

三个消费端，一份源，键名在 CI 里对齐。

```text
preferences.json (app_config_dir)      ← 语言偏好的持久化事实源
      │  启动读取：explicit locale > OS UI 语言 > zh-CN
      ▼
Rust setup() ──┬─→ 托盘菜单文案（refresh 时按当前 locale 重建）
               ├─→ 窗口标题（建窗时取）
               └─→ WebviewWindowBuilder.initialization_script 注入 window.__LULL_LOCALE__
                        │
                        ▼
                  每个 WebView：boot 时 setLocale(注入值, { reload:false })
                        │
                  用户切换语言 → invoke i18n_set_locale
                        └→ Rust 写盘 + 广播 locale-changed + 重建托盘/标题
                             └→ 各窗口：更新 locale 快照 → useSyncExternalStore 触发重渲染
```

### 3.1 为什么不用 `url` 策略

Paraglide 官方 Next.js 集成假设 locale 在 URL 里（中间件 rewrite 或 `/en/...` 预渲染）。本项目 `output: "export"`，没有服务端；即使加 `[locale]`，每个窗口的 `route`、capability 文件、`window_host` 的 url 都要跟着复制一份。所以走官方给的另一条路：**纯客户端渲染 + `strategy: ["localStorage", "baseLocale"]`**。重渲染由我们自己的 store 驱动，不依赖整页刷新——壁纸窗口刷新会导致场景重载与黑闪，必须避免。

实现上没有用 `setLocale(locale, { reload: false })`，而是 `overwriteGetLocale(() => currentLocale)`（`src/i18n/locale.ts`）：`setLocale` 的内部状态是异步写入的，首帧读取可能拿到旧值；直接把 `getLocale` 换成一个同步变量，消息函数在第一次渲染时就返回正确语言。代价是不再使用 Paraglide 的持久化策略——持久化本来就归 Rust。

### 3.2 启动时序：避免语言跳变

静态导出会在构建期把 `zh-CN` 文案写进 HTML，客户端首帧若直接渲染，会出现 en 用户看到一帧中文。两步解决：

1. **注入优先**：Rust 建窗时通过 `initialization_script` 把已解析的 locale 写进 `window.__LULL_LOCALE__`，脚本先于页面 JS 执行，无异步等待。
2. **水合门**：`src/i18n/provider.tsx` 的 `LocaleGate` 在 `mounted === false` 时只渲染既有的 `boot-veil`（壁纸窗已有该组件），首帧与预渲染 HTML 完全一致 → 无水合不匹配、无错误语言闪烁。

## 4. 语言设置模型

`app_config_dir/preferences.json`，沿用 `config/mod.rs` 的版本校验 + 原子写盘（临时文件 + rename）：

```json
{
  "version": 1,
  "locale": "en-US",
  "explicit": true
}
```

- `explicit: false` 表示"跟随系统"：每次启动重新解析 OS UI 语言（Rust 侧读 `GetUserDefaultUILanguage`）。
- 解析优先级：`explicit ? locale : OS` → 归一化到支持列表（`zh` 及所有 `zh-*` 变体→`zh-CN`，`en-*`→`en-US`，其余→基准 `zh-CN`）→ 兜底 `zh-CN`。
- 归一化规则集中在一个函数 `resolve_locale()`，Rust 与 TS 各有一份实现（TS 侧用于 `preferredLanguage` 兜底），由同一张表驱动，`i18n-check` 校验两边表一致。

UI：设置页新增「语言」卡片（`偏好`页签内、主题流光之前）：

| 控件 | 行为 |
| --- | --- |
| 单选组：跟随系统 / 简体中文 / English | 选中即生效，无需重启 |
| 说明文字 | 显示当前实际生效值（跟随系统时标明解析结果） |

## 5. 阶段计划

### 阶段 0：基础设施（2–3 人日）

| 任务 | 涉及文件 | 说明 |
| --- | --- | --- |
| 建 inlang 工程 | `project.inlang/settings.json` | `baseLocale: "zh-CN"`，`locales: ["zh-CN","en-US"]`，`pathPattern: "./i18n/messages/{locale}.json"` |
| 建消息文件 | `i18n/messages/{zh-CN,en-US}.json` | 先只放 5 个键跑通链路 |
| 编译脚本 | `scripts/i18n-compile.mjs` | `compile({ project, outdir: "src/paraglide", strategy: ["localStorage","baseLocale"], emitTsDeclarations: true })`；`src/paraglide/` 加 `.gitignore` |
| 脚本接线 | `package.json`、`scripts/prebuild.mjs` | `dev:next` 前置编译；`prebuild.mjs` 在 ① 之前插入编译步骤；`check` 前置编译 |
| 前端 locale store | `src/i18n/locale.ts` | 照搬 `use-flow-theme.ts` 的 `useSyncExternalStore` + 跨窗口事件模式，键 `i18n-locale-changed` |
| 水合门 + `lang` | `src/i18n/provider.tsx`、`src/app/layout.tsx` | `LocaleGate`、`document.documentElement.lang`、`:lang()` 字体栈 |
| 错误码解析 | `src/i18n/errors.ts` | `localizeError(err)`：`{code, params, fallback}` → 消息；字符串原样返回（兼容未迁移命令） |
| Rust i18n 模块 | `src-tauri/src/i18n/mod.rs`、`build.rs` | `include_str!` 三份 JSON → `OnceLock<HashMap>`；build.rs 生成键名常量 `msg_key.rs` |
| 偏好持久化 | `src-tauri/src/config/preferences.rs`、`lib.rs` | 新命令 `i18n_boot` / `i18n_set_locale` |
| 窗口注入 | `src-tauri/src/window_host/mod.rs` | 所有建窗路径统一 `initialization_script` |
| 语言设置 UI | `src/app/(control)/setting/page.tsx` | 新增卡片 |

**验收**：切到 `en-US`，设置页标题/页签变化且不重启；重启后保持；壁纸窗无黑闪、无首帧中文；`pnpm check` 全绿。

### 阶段 1：前端文案迁移（6–8 人日，5 个 PR）

按"用户能看见的第一屏"排序，每批独立可发布：

| 批次 | 范围 | 文件 | 预估键数 |
| --- | --- | --- | --- |
| 1.1 | 设置页骨架 | `setting/page.tsx`、`wallpaper-panel.tsx`（偏好/壁纸/扩展页签、关于卡） | ~90 |
| 1.2 | 顶栏与窗口壳 | `window-topbar.tsx`、`window-shell.tsx`、`theme-switcher.tsx`、`widget-plugin-shell.tsx` | ~60 |
| 1.3 | 播放器 | `liquid-player.tsx`、`cover-art.tsx`、`use-window-fit.ts` 报错 | ~150 |
| 1.4 | 番茄钟 | `liquid-pomodoro.tsx`、`timer-model.ts` | ~120 |
| 1.5 | 环境声与扩展 | `ether-bubbles.tsx`、`scene-params.tsx`、`extensions-panel.tsx`、`extension-detail-sheet.tsx` | ~130 |

迁移规则（写进 `docs/contributing.md`）：

- 键名扁平 `snake_case`，前缀即命名空间：`settings_tab_preferences`、`player_no_track`、`pomodoro_phase_focus`、`error_save_failed`。**不用点号嵌套**——生成器对键名的标识符合法性有约束，扁平 snake_case 是最稳的写法。
- 带插值一律用 ICU 花括号命名参数：`error_save_failed: "保存失败：{reason}"`，禁止字符串拼接。
- 复数/数量走 ICU `plural`（英文必须，中文单形式）：`scene_params_selected: "{count, plural, =0 {未选择} other {已选 # 项}}"`。
- 纯装饰性中文（`aria-label`、`title`、`alt`）**必须**迁移，它们会进无障碍树。
- 用户可见的格式化（时间/日期/数字）统一走 `Intl.*` 配合 `getLocale()`；`scenes/shared/clock.tsx` 需要按 locale 支持 12/24 小时。
- 内置场景/工具的显示名走消息键（`scene_builtin_bamboo_name`），**不复用**清单 JSON 里的中文 `name`；第三方场景走阶段 3 的元数据。

**验收**：`en-US` 下设置页、播放器、番茄钟、白噪音、扩展中心的 DOM 文本中文占比为 0（脚本判定，见阶段 4）；英文文案 +30% 长度不溢出（播放器固定 880×552、顶栏固定高度是高风险点）；测试改为按 `m.xxx()` 断言或 `data-testid`。

### 阶段 2：打通 Tauri 与 Rust（3–4 人日）

| 任务 | 说明 |
| --- | --- |
| 托盘菜单 | `tray.rs` 的 `显示/隐藏设置`、`退出`、子菜单标题全部改 `i18n::t(msg_key::TRAY_*)`；`i18n_set_locale` 后调 `tray::refresh` |
| 窗口标题 | `window_host` 建窗时用当前 locale 取标题；切换语言时遍历已开窗口 `set_title` |
| 内置工具名 | `build.rs` 读清单生成 `WidgetSpec.name_key`，由 `i18n::t` 解析；清单 `name` 保留为"英文兜底/无译时原文" |
| IPC 错误结构化 | 新增 `IpcError { code, params, fallback }`（`Serialize`）。**只迁移会被 UI 展示的命令**：`window_prefs_set`、`widget_open`、`widget_close`、`extensions_install`、`extensions_remove`、`wallpaper_set_display`。其余保持 `String`，前端 `localizeError` 已能兼容 |
| 校验错误 | `sdk/scene/manifest.ts` / `sdk/widget/runtime.ts` 的中文校验信息属开发者面向，**不翻译**，但要在 `error_*` 命名空间之外单独命名（`dev_*`），避免进翻译文件 |
| 限制记录 | `tauri.conf.json` 的 `shortDescription`/`longDescription` 是安装包元数据，无法随 locale 变；本期保持现状并在文档标注 |

**验收**：系统语言为英文时冷启动，托盘菜单、窗口标题、安装失败提示均为英文；切换语言后已打开的 4 个窗口标题与托盘同步更新，无需重启。

### 阶段 3：社区扩展多语言元数据（2–3 人日）

契约演进原则：**只放宽、不收紧**。`name` / `description` 从 `string` 放宽为 `string | Record<locale, string>`：

```json
{
  "schemaVersion": 1,
  "id": "aurora.demo",
  "name": { "zh-CN": "极光", "en-US": "Aurora" },
  "description": { "zh-CN": "沉浸式桌面场景", "en-US": "An atmospheric desktop scene" }
}
```

- `schemaVersion` 保持 1：字符串形式仍然合法，旧包零改动；v2 只在"要求至少一个 locale"成为硬约束时再引入。
- 统一解析函数 `pickLocalized(value, locale)`，回退链：**精确 locale → 语言前缀（`zh`）→ baseLocale → 对象首个值 → 原字符串**。TS 与 Rust 各一份，行为由同一组用例覆盖。
- `content/schema/{scene,catalog}.json` 更新为 `oneOf[string, object]`；`validate-content.mjs` 增加 locale 键合法性校验（非法 locale 报 `issue` 而非直接失败）。
- ⚠️ **内容目录签名**：`catalog.json` 进哈希与签名（`content:hash` / `content:sign`）。字段语义变化后必须重新哈希重签，否则 `verify.ts` 校验失败、外部场景全部隐藏。阶段 3 与下一次内容发布对齐，不要单独发。
- Widget 插件：
  - 清单新增可选 `defaultLocale`、`locales: string[]`；
  - 宿主上下文 `window.__LULL_WIDGET__` 增加 `locale`，SDK 暴露 `useLocale()` 与 `lull:locale-changed` 事件；
  - 插件自带 `locales/*.json`，缺失时回退 `defaultLocale` 再回退清单原文；
  - 未声明 `locales` 的旧插件行为不变（无本阶段风险）。
- 文档：`docs/content-format.md`、`docs/widget-sdk.md` 各补一节 + 一个示例包。

**验收**：示例场景包提供 zh-CN/en-US 两份元数据，切换语言后设置页壁纸列表即时更新；只提供中文的旧包在 en 下正常显示中文而非空白。

### 阶段 4：翻译质量门禁（1–2 人日）

`scripts/i18n-check.mjs`（接入 `pnpm check` 与 CI）：

1. **缺失键**：`zh-CN` 缺键 = 失败；其他语言缺键 = 按"允许未完成"策略放行，但输出清单并在发布前要求清零 `en-US`。
2. **多余键**：非 base 语言出现 base 没有的键 = 失败（拼写错误探测器）。
3. **参数一致性**：解析每个键的 `{param}` 与 ICU 复数分支，各语言集合必须相同，否则是运行时崩溃隐患。
4. **空值与占位**：空串、`TODO`、与 base 完全相同的长句（>20 字符且非专有名词）给出告警清单。
5. **未使用键**：扫 `m.xxx(` / `m["xxx"](` / `msg_key::XXX` / `i18n::t("…")`，反转检查；未使用键告警，连续两版未使用则要求删除。
6. **locale 合法性**：`project.inlang` 的 locales 与 `TAURI` 侧支持表、TS 侧支持表三处一致。
7. **生成物新鲜度**：`i18n:compile` 后 `git diff --exit-code src/paraglide`（若选择入库）或校验编译耗时（若忽略）。

另外两个守卫（vitest，随 `pnpm test` 跑）：

- **硬编码中文棘轮**：扫描 `src/**/*.tsx` 中除白名单（注释、`dev_*` 校验信息、`console.*`）外的中文字面量，基线数随每批迁移**只降不升**，新增即失败。
- **locale 矩阵渲染**：`setting/page.tsx` 在 `en-US` 下渲染，断言 `container.textContent` 不含 CJK。

**验收**：故意删一个 `en-US` 键、改一个参数名、加一句硬编码中文，三种情况 CI 均失败。

## 6. 排期

单人串行约 4 周；两人并行（A：阶段 1 前端迁移；B：阶段 0 的 Rust 部分 + 阶段 2）约 2.5 周。阶段 3、4 可以搭在阶段 1 尾期并行。

| 周 | A（前端） | B（原生 / 契约） |
| --- | --- | --- |
| W1 | 阶段 0 前端部分 + 1.1、1.2 | 阶段 0 Rust 部分（注入、偏好、i18n 模块） |
| W2 | 1.3 播放器 | 阶段 2 托盘 / 标题 / 错误码 |
| W3 | 1.4、1.5 | 阶段 3 元数据契约 + 校验器 |
| W4 | 全量回归 + 英文文案走查 | 阶段 4 门禁 + CI |

## 7. PR 拆分

| # | 标题 | 依赖 |
| --- | --- | --- |
| 1 | `chore(i18n): 引入 Paraglide 与消息源骨架` | — |
| 2 | `feat(i18n): locale store、水合门与语言设置项` | 1 |
| 3 | `feat(native): preferences.json + locale 注入与广播` | 1 |
| 4–8 | `refactor(i18n): 迁移设置页 / 顶栏 / 播放器 / 番茄钟 / 环境声与扩展` | 2 |
| 9 | `feat(native): 托盘与窗口标题本地化` | 3 |
| 10 | `feat(ipc): 用户可见错误结构化` | 9 |
| 11 | `feat(content): 场景与 Widget 元数据多语言契约` | 4–8 |
| 12 | `ci(i18n): 键完整性、参数一致性与硬编码守卫` | 4–8 |

每个 PR 自带该批次的键与对应测试改动；`docs/i18n-plan.md` 的阶段勾选随 PR 更新。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 测试按中文断言 | 每批迁移都打断测试，回滚成本高 | 迁移时同步改断言（`m.xxx()` 或 `data-testid`），禁止为通过测试把文案留在代码里 |
| 英文变长溢出 | 播放器 880×552 固定尺寸、顶栏固定高度先崩 | 每批用 an 最长的键做布局回归；关键容器改 `min-h` 而非固定高度 |
| 水合不匹配 | 控制台报错、首帧闪错语言 | `LocaleGate` + `initialization_script`；壁纸窗沿用 `boot-veil` |
| 内容签名失效 | 外部场景消失，看起来像功能故障 | 阶段 3 与内容发布同批；CI 增加 `content:verify` 步骤 |
| 多窗口同步竞态 | 一个窗口换了、另一个没换 | 幂等 apply + 以 Rust 广播为最终态；窗口重新聚焦时校一次快照 |
| Rust/TS 键漂移 | `t("tray.exit")` 拼错静默显示键名 | build.rs 生成键常量（编译期拦截）+ `i18n-check` 交叉扫描 |
| 字体观感 | 现有 CJK 字体渲染拉丁字母偏窄 | `:lang(en)` 字体栈回退到系统 UI 字体；壁纸场景内文字不受影响 |

## 9. 明确不做

- 不做 URL 路由化语言（无服务端、无分享链接需求）。
- 不做服务端语言协商（无服务端）。
- 不引入第二套运行时翻译库（`i18next` / `next-intl`），也不为历史原因保留 `t()` 兼容层。
- 不翻译开发者面向内容：Rust `eprintln!` 日志、TS 校验错误、测试断言、代码注释。
- 不做翻译平台接入（inlang 生态可后接，键格式已兼容，届时零改动）。

## 10. 下一步（本周可开工）

1. 评审本方案的三处硬决策：`baseLocale = zh-CN`、locale 不进 URL、语言事实源在 Rust。
2. 建 `project.inlang` + 三份消息文件（各 5 个键）+ `scripts/i18n-compile.mjs`，验证 Next 16 / Turbopack 下编译链路与 `tsc` 类型提示正常。
3. 用设置页「关于 Lull」卡片这一小块做端到端试点（约 10 个键），跑通"改 JSON → 编译 → 切语言 → 重启保持"闭环，再开 PR #1。

## 11. 实施记录

### 阶段 0（已完成）

| 交付物 | 路径 |
| --- | --- |
| inlang 工程 | `project.inlang/settings.json`（baseLocale `zh-CN`，locales `zh-CN`/`en-US`） |
| 消息源 | `i18n/messages/{zh-CN,en-US}.json`（各 21 条：设置页签 / 语言卡片 / 关于卡片 / 托盘 / 错误） |
| 编译脚本 | `scripts/i18n-compile.mjs` → `src/paraglide/`（已在 `.gitignore` 与 `biome.json` 忽略） |
| 前端语言层 | `src/i18n/locale.ts`（快照 + 跨窗口同步）、`src/i18n/messages.ts`（动态键）、`src/i18n/errors.ts`（IPC 错误本地化）、`src/i18n/provider.tsx`（水合守卫） |
| Rust 语言层 | `src-tauri/src/i18n/mod.rs`（系统探测 / 偏好持久化 / 查表 / `i18n_boot` / `i18n_set_locale`） |
| 注入 | `window_host`（含 `__LULL_WIDGET__.locale`）与 `wallpaper/windows.rs` 的 `initialization_script` |
| 托盘 | 菜单项、子菜单、tooltip 改走 `i18n::t`，切换语言后 `tray::refresh` |
| 设置页试点 | 语言卡片（跟随系统 / 简体中文 / English）、页签、关于卡片、两个错误提示 |
| 文档 | `docs/contributing.md` 增加 i18n 约定与命令 |

配套改动：`build.rs` 的 `APP_COMMANDS` 增加两个命令（capability 已重新生成）；`scripts/gen-widgets.mjs` 的命令名正则放宽到 `[a-z0-9_]+`（原先读不到 `i18n_boot` 这类带数字的名字）。

验证：前端 39 文件 / 217 项通过（新增 3 项语言测试）；Rust 107 项通过（新增 7 项：键集完整性、占位符一致、归一化、解析优先级、回退）；`tsc --noEmit` 干净；`next build` 静态导出成功。

### 阶段 1（进行中：设置窗口已完成）

设置窗口内的全部界面文案已迁到消息表，共 201 条消息（中英各一套）：

| 范围 | 文件 | 备注 |
| --- | --- | --- |
| 设置页三张卡片 + 页签 + 语言卡 | `app/(control)/setting/page.tsx` | 主题流光、窗口、关于、语言 |
| 顶栏 | `window-topbar.tsx`、`window-shell.tsx`、`(control)/layout.tsx` | `section` 改传消息函数，语言切换后窗口名跟着变 |
| 壁纸面板 | `settings/wallpaper-panel.tsx` | 状态提示改存枚举（`visible`/`hidden`/`not-running`），错误走 `localizeError` |
| 场景参数控件 | `scene-params.tsx` | — |
| 扩展中心 | `extensions/extensions-panel.tsx`、`extension-detail-sheet.tsx`、`labels.ts` | 能力等级改成机器值（`required`/`hint`/`basic`），翻译在渲染时做 |
| 主题切换 / 主题名 | `theme-switcher.tsx`、`lib/flow-theme.ts` | `FlowTheme.label` 改为 `() => string` |
| 内置窗口名与描述 | `widgets/registry.ts` | 清单 JSON 保持原文作兜底，界面走 `widgetDisplayName()` |

守卫：`src/i18n/locale.test.tsx` 新增「英文界面下偏好页签不残留中文」用例（剔除语言自称后比对 CJK）。

仍未覆盖：壁纸面板展示的场景名/描述（来自清单元数据，阶段 3）、内容目录加载失败的 `reason`（来自 `src/content/catalog.ts` 的中文错误串，阶段 2 结构化后再处理）、播放器与番茄钟、环境声面板（除主题名外）。

### 尚未做（按 §5 的顺序）

- 阶段 1 剩余四批：顶栏 / 播放器 / 番茄钟 / 环境声与扩展中心（约 460 条文案）。
- 阶段 2：窗口标题本地化、用户可见 IPC 错误的 `IpcError{code,params,fallback}` 结构化（前端 `localizeError` 已就位）。
- 阶段 3：内容包与 Widget 元数据的多语言字段。
- 阶段 4：`scripts/i18n-check.mjs`（缺失键 / 多余键 / 参数一致 / 未使用键 / 硬编码中文棘轮）与 CI 接入。
- `build.rs` 生成 Rust 键常量（当前 Rust 侧用字面量键，靠 `cargo test` 的键集校验兜底）。

### 环境注意事项

- `src/paraglide/` 不入库：首次 clone 后必须 `pnpm i18n:compile`（`dev:next` / `typecheck` / `test` / 打包前已自动触发）。
- inlang 的 message-format 插件从 jsdelivr 加载并缓存；离线环境首次编译会失败，接入 CI 时需要一次联网预热或改为本地依赖。
