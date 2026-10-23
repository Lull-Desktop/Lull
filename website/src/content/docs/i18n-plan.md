---
title: 多语言方案
description: Paraglide + Rust 侧语言事实源：为什么 locale 不进 URL，以及中英双语的分阶段落地方案。
order: 10
group: 架构与运行时
source: docs/i18n-plan.md
---

## 结论先行

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 前端方案 | **Paraglide JS 2.x** | 编译期产出 `m.xxx()` 纯函数，无运行时 Provider / Hook 开销，键名与参数有 TS 类型 |
| 第二套库 | 不引入 | 两套翻译库会让键命名、复数规则、回退链分叉 |
| URL 带 locale 前缀 | **不带** | 静态导出 + Tauri 多窗口，加 `[locale]` 要改全部路由、capability、窗口 url 与托盘跳转 |
| 语言事实源 | **Rust 侧 `preferences.json`**，启动时一次解析并注入各窗口 | 托盘在 `setup()` 里建菜单，早于任何 WebView；只有 native 先知道语言，才不会「启动后语言跳变」 |
| 消息源 | 仓库根 `i18n/messages/*.json` | 一份源两个消费端：Paraglide 编译成 JS，Rust `include_str!` 读同一份 |
| 基准语言 | `zh-CN` | 缺译时回退到看得懂的中文，而不是 `player_no_track` 这种键名 |
| 支持语言 | `zh-CN`、`en-US`；**不做繁体** | 繁体系统回落简体（不是英文）；加语言 = 加一份消息文件 + `SOURCES` 一行 |
| 迁移方式 | 按界面分批人工迁移，不做自动抽取 | 中文散在 JSX、模板串、三元表达式、`aria-label` 里，自动抽取只会产出一堆 `text_1` |

## 三处结构性障碍

1. **文案不集中在组件里**。清单 JSON 的 `name` / `title` 经 `build.rs` 生成 Rust 常量，
   同时被托盘、窗口标题和设置页列表三处消费，改一处显示名要同时动 TS、JSON 与 Rust。
2. **Rust 错误字符串直接进 UI**。`保存失败：${String(err)}` 这类写法把中文错误串从 IPC
   一路透传到界面，前端无法翻译。
3. **测试按中文文案断言**。大量 `getByText("偏好")`，迁文案会连带打断测试——这是成本里最容易被低估的一块。

## 目标架构

```text
i18n/messages/{zh-CN,en-US}.json           ← 唯一消息源（inlang message format）
        │
        ├── compile (构建期, scripts/i18n-compile.mjs)
        │      └→ src/paraglide/            ← 前端 m.xxx()，带类型
        │
        ├── include_str! (Rust 编译期)
        │      ├→ src-tauri/src/i18n/mod.rs → t(key) / t_with(key, params)
        │      └→ build.rs 生成 msg_key.rs  → 键名常量（写错键 = 编译失败）
        │
        └── scripts/i18n-check.mjs (CI)     → 缺失键 / 多余键 / 参数不一致 / 未使用键
```

```text
preferences.json (app_config_dir)          ← 语言偏好的持久化事实源
      │  启动读取：explicit locale > OS UI 语言 > zh-CN
      ▼
Rust setup() ──┬─→ 托盘菜单文案（refresh 时按当前 locale 重建）
               ├─→ 窗口标题（建窗时取）
               └─→ initialization_script 注入 window.__LULL_LOCALE__
                        ▼
                  各 WebView：boot 时同步 locale 快照 → useSyncExternalStore 触发重渲染
                        ▲
                  用户切换 → invoke i18n_set_locale → 写盘 + 广播 locale-changed + 重建托盘/标题
```

### 为什么不用 `url` 策略

Paraglide 的 Next.js 集成假设 locale 在 URL 里（中间件 rewrite 或 `/en/...` 预渲染）。
本项目 `output: "export"` 没有服务端，即使加 `[locale]`，每个窗口的 route、capability 文件、
`window_host` 的 url 都要跟着复制一份。所以走官方另一条路：**纯客户端渲染 + 自己的 store 驱动重渲染**，
不依赖整页刷新——壁纸窗刷新会导致场景重载与黑闪，必须避免。

实现上没有用 `setLocale(locale, { reload: false })`，而是 `overwriteGetLocale(() => currentLocale)`
（`src/i18n/locale.ts`）：`setLocale` 的内部状态是异步写入的，首帧可能读到旧值；
把 `getLocale` 换成同步变量，消息函数第一次渲染就返回正确语言。代价是不再用 Paraglide 的持久化策略——
持久化本来就归 Rust。

### 启动时序：避免语言跳变

静态导出会把 `zh-CN` 文案写进构建期 HTML，客户端首帧直接渲染的话，en 用户会看到一帧中文。两步解决：

1. **注入优先**：Rust 建窗时用 `initialization_script` 写入已解析的 locale，脚本先于页面 JS，无异步等待。
2. **水合门**：`LocaleGate` 在 `mounted === false` 时只渲染既有的 `boot-veil`，首帧与预渲染 HTML 完全一致，
   既无水合不匹配，也没有错误语言的闪烁。

## 语言设置模型

`app_config_dir/preferences.json`，沿用 `config/mod.rs` 的版本校验 + 原子写盘：

```json
{ "version": 1, "locale": "en-US", "explicit": true }
```

- `explicit: false` 表示「跟随系统」，每次启动重新读 `GetUserDefaultUILanguage`。
- 解析优先级：`explicit ? locale : OS` → 归一化到支持列表（`zh` 及所有 `zh-*` → `zh-CN`，
  `en-*` → `en-US`，其余 → `zh-CN`）→ 兜底 `zh-CN`。
- 归一化集中在 `resolve_locale()`，Rust 与 TS 各一份实现，由同一张表驱动，`i18n-check` 校验两边一致。

设置页「偏好」页签内的语言卡片是单选组（跟随系统 / 简体中文 / English），选中即生效、无需重启，
说明文字显示当前实际生效值。

## 进展

**阶段 0（已完成）**：inlang 工程与两份消息文件、`i18n-compile.mjs` 编译链路、
前端语言层（`locale.ts` / `messages.ts` / `errors.ts` / `provider.tsx`）、
Rust 语言层（`src-tauri/src/i18n/mod.rs`）、窗口与壁纸窗的 locale 注入、托盘与设置页试点。

**阶段 1（进行中，设置窗口已完成）**：设置页三张卡片 + 页签 + 语言卡、顶栏、
壁纸面板与场景参数控件、扩展中心与详情、主题切换、内置窗口名与描述，全部改走消息表。
守卫用例会检查「英文界面下偏好页签不残留中文」。

仍未覆盖：壁纸面板展示的场景名与描述（来自清单元数据）、内容目录加载失败的原因串、
播放器与番茄钟、环境声面板。阶段 2 计划把用户可见的 IPC 错误结构化成 `IpcError{code,params,fallback}`
并本地化窗口标题。

## 明确不做

- 不做繁体中文（`zh-*` 一律回落简体）。
- 不在 URL 里带 locale，不做按语言分目录的静态导出。
- 不引入第二套翻译库，也不做运行时下载语言包。
- 不对现有中文做自动抽取迁移。

## 写代码时的约定

- 界面文案一律走 `i18n/messages/*.json`，不在组件里写死中英文。
- 键名扁平 `snake_case`，前缀即命名空间（`settings_`、`player_`、`pomodoro_`、`tray_`）。
- 插值用 ICU 命名参数，禁止字符串拼接；数量变化用 `plural`。
- 两套语言的键必须齐全，`cargo test` 与 CI 都会查。
- 渲染文案的组件用 `useLocale()` 订阅语言变化，首帧早于注入语言时用 `useLocaleReady()` 挡住预渲染内容。

分阶段任务、PR 拆分与验收标准见仓库
[多语言实施方案](https://github.com/Lull-Desktop/Lull/blob/main/docs/i18n-plan.md)。
