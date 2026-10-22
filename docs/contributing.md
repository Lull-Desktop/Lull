# 贡献指南

感谢你愿意参与 Lull。请先读 [架构说明](architecture.md)，再开始改代码。

## 1. 环境

| 依赖 | 要求 |
| --- | --- |
| Windows | 10 / 11 |
| Node.js | 24（`.node-version`） |
| pnpm | 11（`packageManager`） |
| Rust | `stable-x86_64-pc-windows-msvc`（`rust-toolchain.toml`） |
| Visual Studio | C++ 桌面开发 + Windows SDK |
| Git Bash | 编译 `lull_native.dll` |
| Python / uv | `pnpm test-mode` 需要 Pillow；有 uv 时自动准备临时环境 |

```powershell
pnpm install
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## 2. 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | Tauri 开发模式（debug 默认不启用壁纸） |
| `pnpm test` | Vitest 单元测试 |
| `cargo test` | Rust 单元测试 |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm content:check` | 内容目录校验 |
| `pnpm widgets:check` | Widget 清单校验 + capability 同步检查 |
| `pnpm widgets:gen` | 生成 `src-tauri/capabilities/window-*.json` |
| `pnpm widgets:samples:build` | 构建 `examples/widgets/*` 插件样例 |
| `pnpm widgets:samples:install` | 把样例安装到用户插件目录 |
| `pnpm build:next` | 静态导出 |
| `pnpm test-mode` | Windows 真机壁纸验收（原生改动必须跑） |
| `pnpm build` | 完整安装包 |

## 3. 许可

Lull 采用分层许可，提交前请确认文件归属：

| 改动范围 | 许可 |
| --- | --- |
| 应用代码、Rust、C++、Next.js UI、脚本 | GPL-3.0-or-later |
| `src/sdk/**` 公开接口 | Apache-2.0 |
| 文档、官方内容、Schema、示例 | CC BY 4.0 |
| 字体 | SIL OFL 1.1 |

- 贡献按对应目录的许可接收，不需要签署 CLA；
- 请使用 DCO sign-off：`git commit -s`；
- 新增第一方文件建议加 SPDX 头，例如 `// SPDX-License-Identifier: GPL-3.0-or-later`；
- 不要引入与 GPL-3.0 不兼容的依赖、字体或素材。

详见 [许可说明](licensing.md)、[SDK License](../SDK-LICENSE.md) 与 [Content License](../CONTENT-LICENSE.md)。
## 4. 代码约定

### 3.1 前端

- 使用 Biome 格式化；提交前 `pnpm fix`。
- 纯函数优先：几何、协议、清单校验放在 `src/core` / `src/sdk`，React 组件只做渲染。
- 场景组件只接收 `SceneProps`，不读全局配置、不调用 Tauri。
- 新增工具窗只改 `src/widgets/manifests/<id>.json`，然后跑 `pnpm widgets:gen`；Rust 描述由 `build.rs` 生成，不要手写 `spec.rs` 或 `capabilities/desktop.json`。
- 工具组件只通过 `@/sdk/widget` / `@/sdk/widget/react` 使用宿主能力（状态、窗口、音频、媒体），不要直接 import `core/window/controls` 或读 `localStorage`。
- 外部内容包只放 `public/content/`，不要 import 到 `src/`。
- 中文注释用于解释“为什么”，不要复述代码。

### 3.2 Rust

- 2 空格缩进（`.rustfmt.toml`）。
- `lib.rs` 只做接线；业务逻辑进 `wallpaper` / `window_host` / `config`。
- 壁纸建窗只能从非主线程发起；不要在同步命令里调用 `WebviewWindowBuilder`。
- 配置写入必须走事务模型：改内存 → 写盘 → 失败回滚。
- `unsafe` 只允许出现在 `wallpaper/ffi.rs`、`wallpaper/{runtime,windows,watchdog}.rs` 等已声明的模块，新增时在模块顶部说明安全前提。
- 原生 ABI 变更必须同步 Rust 绑定、构建脚本、`tauri.conf.json`、验收工具与文档。

### 3.3 原生

- C++ 不依赖 React / Tauri / 内容包。
- 不改变 `lull_native_*` 导出签名而不更新 Rust。
- 修改挂载、Z 序、DPI、看门狗逻辑后必须跑 `pnpm test-mode`，并在 PR 里贴日志/截图。
- 不提交 `.dll/.obj/.exp/.lib`（已 gitignore）。

## 5. 测试要求

| 改动 | 最低验证 |
| --- | --- |
| 前端纯函数 / SDK | `pnpm test` + `pnpm lint` |
| 设置页 / 窗口 UI | `pnpm test` + 手动打开对应窗口 |
| Rust 逻辑 | `cargo test` |
| 原生宿主 | `cargo test` + `pnpm test-mode` |
| 内容格式 | `pnpm content:check` + `pnpm test` |
| Widget 清单 / 能力 | `pnpm widgets:gen` + `pnpm widgets:check` + `pnpm test` + `cargo test` |
| 插件包 / 宿主桥 | `pnpm widgets:samples:build` + `pnpm widgets:samples:install` + 真机打开 `widget-*` 窗口 |
| 安全配置（CSP / capability） | `pnpm test` + `cargo test` + `pnpm build` 后真机冒烟 |
| 构建链 | `pnpm build:next`，必要时 `pnpm build` |

当前基线（会随测试增加）：

- 前端：25 个测试文件 / 139 项；
- Rust：63 项；
- 内容：1 个外部场景示例。

新增行为请补测试；修复回归请先写失败用例。不要通过删除测试来“修复”失败。

## 6. 架构检查清单

提交前问自己：

- [ ] 这段逻辑属于 Core、Extensions 还是 App？有没有放错层？
- [ ] 是否让 `core` 反向依赖 `scenes/widgets/app`？
- [ ] 是否把 Tauri 命令直接暴露成“公共插件 API”？
- [ ] 是否新增了第三方可执行代码路径？插件代码只能通过 iframe + 白名单桥访问宿主；WebView2 注入的 internals 不是受支持入口（见 [`widget-package.md`](widget-package.md) 6.3）。
- [ ] 新工具的能力是否写进 manifest，并在 SDK 门面里实际校验？
- [ ] 新增 IPC 是否同时更新了 `lib.rs` 与 `build.rs` 的 `APP_COMMANDS`，并确认目标窗口 capability 已授权？
- [ ] 配置写入失败时是否会回滚？
- [ ] 新增文件是否在文档与目录树中体现？

## 7. 新增内容 / 场景 / 工具

- 内置场景：`src/scenes/<id>/index.tsx` + `src/scenes/registry.ts`。
- 外部场景：`public/content/scenes/<id>/index.html` + `catalog.json` + `pnpm content:check`。
- 内置工具：`src/widgets/manifests/<id>.json` + 路由 + `src/sdk/widget` + `pnpm widgets:gen`；托盘与设置页从清单自动生成。
- 第三方插件：`examples/widgets/` 样例 + `packages/widget-sdk`；包格式、协议与 CSP 见 [Widget 插件包](widget-package.md)。改桥协议要同时更新 SDK、宿主壳、Rust 命令与文档。
- 新增 IPC：先确定归属模块，再在 `lib.rs` 注册，并把命令名加入 `build.rs` 的 `APP_COMMANDS`；更新 `docs/architecture.md` 的命令表与目标窗口的 capability（`pnpm widgets:gen`）。
- 新增配置字段：提升 `CURRENT_VERSION` 并写迁移测试；旧字段保留默认值。

## 8. 提交与 PR

- 一个 PR 只做一类改动：命名迁移不要和 Win32 逻辑重构混在一起。
- 提交信息建议：`feat(scene): ...` / `fix(native): ...` / `docs: ...` / `refactor(core): ...`。
- PR 描述包含：动机、改动范围、验证命令与结果、风险/回滚方式。
- 原生改动附 `%TEMP%\lull\app.log` 关键行与真机截图。
- 不提交生成物（`dist/`、`.next/`、`target/`、DLL、`node_modules/`）。

## 9. 安全问题

桌面挂载、WebView、内容包都涉及安全边界。发现以下问题请不要公开细节，先按 [SECURITY.md](../SECURITY.md) 私密报告：

- 内容包逃逸 iframe / 访问宿主 IPC；
- 路径穿越读写；
- 原生宿主导致桌面不可恢复；
- 权限提升或任意命令执行。
