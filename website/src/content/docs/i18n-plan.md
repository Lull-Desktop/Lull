---
title: 多语言方案
description: 选型（Paraglide + inlang，语言事实源在 Rust）、从一份消息源到两端的构建链路，以及新增一种语言要改哪几处。
order: 10
group: 架构与运行时
source: docs/i18n-plan.md
---

界面文案统一存在仓库根的 `i18n/messages/*.json`，只有这一份源：前端由 Paraglide 编译成带类型的函数，原生侧在编译期把同一份 JSON 嵌进二进制。当前提供简体中文与英文，基准语言是 `zh-CN`。

## 一、框架与技术选型

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 前端方案 | **Paraglide JS 2.x**（`@inlang/paraglide-js`） | 编译期产出 `m.xxx()` 纯函数：没有运行时 Provider / Hook 开销，键名与参数有 TS 类型，单条消息可被 tree-shake |
| 消息格式 | **inlang message format**（`project.inlang/settings.json`） | ICU 语法（命名参数、`plural`）统一，前后端共用一份 JSON，将来接翻译平台不需要改键 |
| 第二套翻译库 | **不引入** | 同一层出现两套库，键命名、复数规则、回退链会分叉 |
| locale 是否进 URL | **不进** | 静态导出（`output: "export"`）+ Tauri 多窗口，加 `[locale]` 段要改全部路由、capability、窗口 url 与托盘跳转，收益为零 |
| 语言事实源 | **Rust 侧 `app_config_dir/preferences.json`** | 托盘在 `setup()` 里建菜单，早于任何 WebView；只有 native 先知道语言，才不会「启动后语言跳变」 |
| 回退基准（baseLocale） | **`zh-CN`** | 缺译时回落到看得懂的中文，而不是 `player_no_track` 这种键名 |
| 支持语言 | **`zh-CN`、`en-US`，不做繁体** | 繁体系统回落简体（不是英文）；加一种语言的改动面见第三节 |

一份源，两个消费端：

```text
i18n/messages/{zh-CN,en-US}.json          ← 唯一消息源
        │
        ├── pnpm i18n:compile ──→ src/paraglide/      前端 m.xxx()(缓存自动生成)
        │
        └── include_str!（Rust 编译期）→ src-tauri/src/i18n/mod.rs
                                        → t(key) / t_args(key, params)
```

有两处刻意偏离 Paraglide 的默认用法：

- **不用 `setLocale`**。它默认重载文档，壁纸窗重载会重新加载场景、黑闪一帧；`{ reload: false }` 又依赖内部异步状态，首帧可能读到旧值。改用 `overwriteGetLocale(() => currentLocale)`（`src/i18n/locale.ts`）把取值换成同步变量，重渲染交给 React 订阅 —— 持久化本来就归 Rust，不需要 Paraglide 的存储策略。
- **不做 URL 路由化语言**。项目没有服务端，语言靠客户端状态切换，不依赖整页刷新。

## 二、多语言内容的构建流程

**消息源 → 编译 → 运行时。** 编译、加载、切换三段各有一条链路：

```text
① 构建期
i18n/messages/*.json ──i18n:compile──→ src/paraglide/{messages,runtime}  前端
                     ──include_str!──→ Rust 静态消息表                     原生

② 启动期
preferences.json ──解析：explicit ? locale : 系统语言 → 归一化 → 兜底 zh-CN
      ▼
Rust setup() ─┬→ 托盘菜单（切换后 refresh 重建）
              ├→ 窗口标题（建窗时取）
              └→ initialization_script 注入 window.__LULL_LOCALE__（先于页面 JS）
                        ▼
                  LocaleGate 水合门 → useLocale()（useSyncExternalStore）
                        ▼
                  静态导出的 HTML 首帧不闪错语言、无水合不匹配

③ 切换期
用户选择语言 → invoke i18n_set_locale → Rust 写盘 + 广播 i18n-locale-changed
             → 各窗口就地换语言（不重载）+ 托盘/标题同步
```

编译由这些入口自动触发，一般不需要手动跑：

| 入口 | 触发方式 |
| --- | --- |
| `pnpm dev` | `beforeDevCommand` → `pnpm dev:next` → 先 `i18n:compile` |
| `pnpm build` | `beforeBuildCommand` → `scripts/prebuild.mjs` 第 ① 步编译 |
| `pnpm typecheck` / `pnpm test` | `pretypecheck` / `pretest` 钩子编译 |
| 手动 | `pnpm i18n:compile` |

`src/paraglide/` 是生成物、不入库，所以首次 clone 或切换分支后必须先编译一次，否则 `m.xxx()` 不存在。文案进不了两端一致性的只有一种情况：键名拼错。前端靠生成的 `.d.ts` 在 `tsc` 阶段暴露，原生侧靠 `src-tauri/src/i18n` 的用例校验键集、占位符与归一化规则一致。

写文案时的约定：

- 键名扁平 `snake_case`，前缀即命名空间（`settings_`、`player_`、`pomodoro_`、`tray_`），不用点号嵌套。
- 插值用 ICU 花括号命名参数（`保存失败：{reason}`），禁止字符串拼接；数量变化用 `plural`。
- 界面文案一律走消息表；用户可见的 `aria-label` / `title` / `alt` 同样要进消息表。
- 渲染文案的组件用 `useLocale()` 订阅语言变化，首帧早于注入语言的场景由 `LocaleGate` 挡住。

## 三、新增或扩展语言

加一种语言是「加一份文件 + 改四张表」，代码结构不需要动：

1. **加消息文件**：`i18n/messages/<locale>.json`，复制 `zh-CN.json` 作骨架，键名保持完全一致；插值参数与 `plural` 分支也要与基准语言一致。
2. **注册到 inlang 工程**：`project.inlang/settings.json` 的 `locales` 加一项（`pathPattern` 已是 `./i18n/messages/{locale}.json`，无需改）。
3. **原生侧登记**：`src-tauri/src/i18n/mod.rs` 里 `SUPPORTED` 加一项，并在 `SOURCES` 加一行 `include_str!`。两处数组长度是类型的一部分（`[&str; 2]` / `[(&str, &str); 2]`），漏改会编译失败 —— 这是有意的。
4. **前端登记**：`src/i18n/locale.ts` 的 `LOCALE_OPTIONS` 加一项（顺序即设置页展示顺序）、`LOCALE_LABELS` 补语言自称（用该语言自己的文字写，不翻译），并给 `normalizeLocale` 加语言前缀映射。

改完设置页的语言卡片会自动多出一项（页面直接遍历 `LOCALE_OPTIONS`），无需改 UI。最后跑 `pnpm i18n:compile` + `cargo test`，键集与占位符一致性用例会把缺键、多键、参数不一致都拦下来。

几个容易踩的点：

- **前缀映射别漏**。`normalize()` / `normalizeLocale()` 是同一套规则的两份实现，没有前缀映射的话，系统语言为该语言时会被兜底成 `zh-CN`。
- **宽泛前缀要放在具体变体之后**。现在 `zh` 及所有 `zh-*`（含繁体）统一落 `zh-CN`；若将来恢复繁体，`zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` 的判断必须排在宽泛的 `zh` 之前。
- **回退链只有两级**：当前语言 → 基准语言 → 键名本身。新语言缺的键会显示中文，不会显示键名，也不会显示空白。
- **第三方场景与 Widget 的元数据**走的是另一套契约（清单里的 `name` / `description`），不在这张消息表里。
