---
title: 快速开始
description: 从下载安装到本地开发环境，跑通 Lull 的最短路径。
order: 1
group: 开始使用
source: docs/guides/user-guide.zh-CN.md
---

## 直接使用

1. 到[下载页](../../download/)或 [GitHub Releases](https://github.com/Lull-Desktop/Lull/releases/latest) 获取 Windows x64 安装包或便携版。安装包功能以该 Release 说明为准，源码分支可能领先于公开发布版。
2. 安装或解压运行，需要 Windows 10 / 11 和 WebView2 Runtime；安装器可以引导安装运行时，便携版需要本机已有。安装包尚未签名，Windows 可能提示「未知发布者」。
3. 启动后在设置里打开「显示壁纸」。壁纸挂在 Win32 桌面层，需要 Explorer 正常运行。
4. 关闭窗口只是隐藏，退出请用托盘菜单的「退出」。

在「音乐」页浏览曲库、收藏、队列和歌单；通过音乐管理窗口维护目录、标签和智能歌单。「音境」页控制混音、音量、定时器并应用预设，通过音境管理窗口维护素材和预设。

扩展需要先安装、再启用；播放器和音境控制器可在功能槽位切换实现。更新同一扩展需要更高版本，失败会尝试恢复旧包。番茄钟作为示例另行安装，完整步骤见仓库[使用指南](https://github.com/Lull-Desktop/Lull/blob/master/docs/guides/user-guide.zh-CN.md)。

配置与日志位置：

| 内容 | 路径 |
| --- | --- |
| 显示配置 | `%APPDATA%\app.lull.desktop\display.json` |
| 应用日志 | `%TEMP%\lull\app.log` |
| 原生宿主日志 | `%TEMP%\lull_wallpaper.log` |

## 本地开发

只调 UI 时不需要真机挂载壁纸，`debug` 构建默认不接管桌面：

```powershell
git clone https://github.com/Lull-Desktop/Lull.git
cd Lull
pnpm install --frozen-lockfile

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
| WebView2 | Microsoft Edge WebView2 Runtime |

> 本机 pnpm 的默认 isolated 链接方式在部分 Windows 环境下会静默失败。
> 遇到 `Cannot find module` 时先检查安装结果和版本，必要时尝试 `pnpm install --frozen-lockfile --config.node-linker=hoisted`。

官网是独立项目，环境要求见仓库的[官网指南](https://github.com/Lull-Desktop/Lull/blob/master/website/README.md)，与应用侧的 Node 配置分开维护。

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
| `cargo test --manifest-path src-tauri/Cargo.toml` | 从仓库根目录运行 Rust 单元测试 |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm content:check` | 校验内容目录、包摘要与目录签名 |
| `pnpm build` | 打包安装包（含内容校验、DLL 编译、Next 静态导出） |
| `pnpm build:next` | 只导出前端静态资源 |
| `pnpm release:package` | 整理安装包、便携版和 SHA256 到 `artifacts/release/` |

完整的命令表与目录说明见仓库[开发参考](https://github.com/Lull-Desktop/Lull/blob/master/docs/guides/development.zh-CN.md)，
前置条件与提交流程见[参与贡献](../contributing/)。

## 接下来

- 想懂它为什么这么设计：[架构与模块](../architecture/)。
- 想做场景：[Scene SDK](../scene-sdk/)（包结构、参数与同步、摘要签名、打包安装）。
- 想写工具窗口：[Widget SDK](../widget-sdk/)（包结构、清单与插件侧 SDK）。
- 想做桌面游戏：[Game SDK](../game-sdk/)。
- 想运行 GLSL：[着色器壁纸](../shadertoy-import/)。
- 想用英文入门：[English quickstart](https://github.com/Lull-Desktop/Lull/blob/master/docs/en/getting-started.md)（源码启动与首个工具的打包、安装）。
