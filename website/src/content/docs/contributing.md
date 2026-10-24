---
title: 参与贡献
description: 环境、常用命令、分层许可、代码约定与测试要求——提交 PR 之前该知道的事。
order: 11
group: 项目
source: docs/contributing.md
---

## 先读什么

先读[架构与模块](../architecture/)，再动代码。分层边界不是风格问题——Core 反向依赖
`scenes` / `widgets` / `app` 会被当成架构问题退回。

## 环境

| 依赖 | 要求 |
| --- | --- |
| Windows | 10 / 11 |
| Node.js | 22（见 `.node-version`） |
| pnpm | 11（见 `package.json` 的 `packageManager`） |
| Rust | `stable-x86_64-pc-windows-msvc`（`rust-toolchain.toml` 固定） |
| Visual Studio | C++ 桌面开发 + Windows SDK |
| Git Bash | 编译 `lull_native.dll` |
| Python / uv | `pnpm test-mode` 需要 Pillow；有 `uv` 时自动准备临时环境 |

```powershell
pnpm install
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | Tauri 开发模式（debug 默认不启用壁纸） |
| `pnpm test` / `cargo test` | 前端（Vitest）/ Rust 单元测试 |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm typecheck` | 全仓 TypeScript 检查 |
| `pnpm check` | lint + typecheck + test + 内容/清单/SDK 校验一次跑完 |
| `pnpm i18n:compile` | 编译消息文件到 `src/paraglide/`（生成物不入库） |
| `pnpm widgets:sdk` / `pnpm scenes:sdk` | 构建两侧 SDK（TS → `dist` + `.d.ts`） |
| `pnpm content:check` / `content:pack <dir>` | 内容目录校验 / 打成可安装 zip |
| `pnpm widgets:gen` / `pnpm widgets:check` | 生成逐窗口 capability / 校验清单与命令表 |
| `pnpm test-mode` | Windows 真机壁纸验收（原生改动必须跑） |

## 分层许可

| 改动范围 | 许可 |
| --- | --- |
| 应用代码、Rust、C++、Next.js UI、脚本 | GPL-3.0-or-later |
| `src/sdk/**` 公开接口 | Apache-2.0 |
| 文档、官方内容、Schema、示例 | CC BY 4.0 |

- 贡献按对应目录的许可接收，**不需要签 CLA**，但要 DCO sign-off：`git commit -s`。
- 新增第一方文件建议加 SPDX 头，例如 `// SPDX-License-Identifier: GPL-3.0-or-later`。
- 不要引入与 GPL-3.0 不兼容的依赖、字体或素材。细节见[许可与合规](../licensing/)。

## 代码约定

**前端**

- 纯函数优先：几何、协议、清单校验放 `src/core` / `src/sdk`，组件只做渲染。
- 场景组件只接收 `SceneProps`，不读全局配置、不调 Tauri 命令。
- 新增工具窗只改 `src/widgets/manifests/<id>.json` 再跑 `pnpm widgets:gen`，
  不要手写 `spec.rs` 或 `capabilities/*.json`。
- 工具组件只通过 `@/sdk/widget` 用宿主能力，不直接 import `core/window/controls`、不读 `localStorage`。
- 外部内容包只放 `public/content/`，不要 import 进 `src/`。
- 界面文案一律走消息文件，不在组件里写死中英文；键名扁平 `snake_case`，插值用 ICU 命名参数。

**Rust**

- `lib.rs` 只做接线，业务逻辑进 `wallpaper` / `window_host` / `config`。
- 壁纸建窗只能从非主线程发起，不要在同步命令里调 `WebviewWindowBuilder`。
- 配置写入走事务模型：改内存 → 写盘 → 失败回滚。
- `unsafe` 只允许出现在已声明的模块（`wallpaper/ffi.rs` 等），新增要在模块顶部说明安全前提。
- 原生 ABI 变更必须同步 Rust 绑定、构建脚本、`tauri.conf.json`、验收工具与文档。

**原生**

- C++ 不依赖 React / Tauri / 内容包。
- 改挂载、Z 序、DPI、看门狗逻辑后必须跑 `pnpm test-mode`，并在 PR 里贴日志或截图。
- 不提交 `.dll` / `.obj` / `.exp` / `.lib`（已 gitignore）。

## 测试要求

| 改动 | 最低验证 |
| --- | --- |
| 前端纯函数 / SDK | `pnpm test` + `pnpm lint` |
| 设置页 / 窗口 UI | `pnpm test` + 手动打开对应窗口 |
| Rust 逻辑 | `cargo test` |
| 原生宿主 | `cargo test` + `pnpm test-mode` |
| 内容格式 | `pnpm content:check` + `pnpm test` |
| Widget 清单 / 能力 | `pnpm widgets:gen` + `pnpm widgets:check` + `pnpm test` + `cargo test` |
| 插件包 / 宿主桥 | `pnpm widgets:samples:build` + `install` + 真机打开 `widget-*` 窗口 |
| 安全配置（CSP / capability） | `pnpm test` + `cargo test` + `pnpm build` 后真机冒烟 |

新增行为请补测试；修复回归先写失败用例。不要通过删测试来「修复」失败。

## 提交前自检

- 这段逻辑属于 Core、Extensions 还是 App？有没有放错层？
- 是否让 `core` 反向依赖 `scenes` / `widgets` / `app`？
- 是否把 Tauri 命令直接暴露成「公共插件 API」？
- 是否新增了第三方可执行代码路径？插件只能通过 iframe + 白名单桥访问宿主。
- 新增 IPC 是否同时更新了 `lib.rs` 与 `build.rs` 的 `APP_COMMANDS`，目标窗口 capability 是否已授权？
- 配置写入失败时是否会回滚？新增文件是否在文档与目录树里体现？

## 提交与 PR

- 一个 PR 只做一类改动：命名迁移不要和 Win32 逻辑重构混在一起。
- 提交信息建议：`feat(scene): …` / `fix(native): …` / `docs: …` / `refactor(core): …`。
- PR 描述包含动机、改动范围、验证命令与结果、风险与回滚方式。
- 不提交生成物（`dist/`、`.next/`、`target/`、DLL、`node_modules/`）。

## 安全问题

桌面挂载、WebView、内容包都涉及安全边界。发现内容包逃逸 iframe、路径穿越、原生宿主导致桌面
不可恢复、权限提升或任意命令执行，请不要公开细节，先按 `SECURITY.md` 私密报告。

任务清单原文（含完整命令表、测试基线与架构检查项）见仓库
[贡献指南](https://github.com/Lull-Desktop/Lull/blob/master/docs/contributing.md)。
