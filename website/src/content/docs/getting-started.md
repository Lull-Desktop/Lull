---
title: 快速开始
description: 从下载安装到本地开发环境，跑通 Lull 的最短路径。
order: 1
group: 开始使用
source: README.md
---

## 直接使用

1. 到[下载页](../../download/)取当前版本的 `.msi` 或 `.exe`。
2. 双击安装。安装包尚未做代码签名，SmartScreen 提示「未知发布者」时选「更多信息 → 仍要运行」。
3. 启动后在设置里打开「显示壁纸」。壁纸挂在 Win32 桌面层，需要 Explorer 正常运行。
4. 关闭窗口只是隐藏，退出请用托盘菜单的「退出」。

配置与日志位置：

| 内容 | 路径 |
| --- | --- |
| 显示配置 | `%APPDATA%\app.lull.desktop\display.json` |
| 应用日志 | `%TEMP%\lull\app.log` |
| 原生宿主日志 | `%TEMP%\lull_wallpaper.log` |

## 本地开发

只调 UI 时不需要真机挂载壁纸，`debug` 构建默认不接管桌面：

```powershell
pnpm install

# 首次或改过 src-tauri/native 后
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh

pnpm dev
```

### 前置依赖

| 依赖 | 版本 / 说明 |
| --- | --- |
| Windows | 10 / 11，原生宿主只针对 Win32 桌面层 |
| Node.js | 22（见 `.node-version`） |
| pnpm | 11（见 `package.json` 的 `packageManager`） |
| Rust | `stable-x86_64-pc-windows-msvc`，由 `rust-toolchain.toml` 固定 |
| Visual Studio | 「使用 C++ 的桌面开发」+ Windows 10/11 SDK |
| Git Bash | 编译 `lull_native.dll` 需要 `bash` / `cygpath` |

> 本机 pnpm 的默认 isolated 链接方式在部分 Windows 环境下会静默失败。
> 遇到 `Cannot find module` 时改用 `pnpm install --config.node-linker=hoisted`。

### 验证真实壁纸挂载

```powershell
pnpm test-mode            # 构建 DLL → 启动 → 层序/命中/动画验收 → 退出并还原桌面
pnpm test-mode -SkipVerify -HoldSeconds 30
```

验收脚本需要 Pillow；本机 Python 没装时，若 PATH 中有 `uv` 会自动用 `uv run --with pillow`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Tauri 开发模式（debug 默认不启用壁纸） |
| `pnpm test` | Vitest 前端测试 |
| `cargo test` | Rust 单元测试（在 `src-tauri/` 下） |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm content:check` | 校验内容目录、包摘要与目录签名 |
| `pnpm build` | 打包安装包（含内容校验、DLL 编译、Next 静态导出） |
| `pnpm build:next` | 只导出前端静态资源 |

完整的命令表与目录说明见仓库 [README](https://github.com/Lull-Desktop/Lull#readme)，
前置条件与提交流程见[参与贡献](../contributing/)。

## 接下来

- 想懂它为什么这么设计：[架构与模块](../architecture/) → [原生桌面宿主](../native-host/)。
- 想做场景：[场景与 Scene SDK](../scene-sdk/) → [内容包格式](../content-format/)。
- 想写工具窗口：[Widget SDK](../widget-sdk/)（包结构、清单与插件侧 SDK）。
- 想管扩展：[扩展中心](../extension-center/)。
