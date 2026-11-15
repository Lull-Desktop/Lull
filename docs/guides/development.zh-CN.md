# Lull 开发参考

[项目首页](../../README.zh-CN.md) · [使用指南](user-guide.zh-CN.md) · [English quickstart](../en/getting-started.md) · [贡献约定](../contributing.md)

本文承接 README 中的开发、打包和文档索引。接口以当前源码为准；发布版用户应使用相应 tag 的 SDK 和示例。

## 开发环境

| 依赖 | 要求 |
| --- | --- |
| Windows | 10 / 11，x64；真实壁纸挂载依赖 Explorer 桌面 |
| Node.js | 22，见 [`.node-version`](../../.node-version) |
| pnpm | 使用 [`package.json`](../../package.json) 的 `packageManager` 指定版本 |
| Rust | [`rust-toolchain.toml`](../../rust-toolchain.toml) 选择 MSVC stable 工具链 |
| Visual Studio Build Tools | C++ 桌面开发工作负载与 Windows SDK |
| Git Bash | 原生构建脚本需要 `bash` / `cygpath` |
| WebView2 | Microsoft Edge WebView2 Runtime |
| Python / uv | 仅桌面验收需要 Pillow；也可由 `uv` 提供临时环境 |

在 PowerShell 中获取源码、准备 pnpm 并启动：

```powershell
git clone https://github.com/Lull-Desktop/Lull.git
cd Lull
$lullPackageManager = (Get-Content package.json -Raw | ConvertFrom-Json).packageManager
npm install --global $lullPackageManager
pnpm install --frozen-lockfile
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh
pnpm dev
```

Git 装在其他位置时调整 Bash 路径。首次运行或修改原生代码后需要重建 DLL。Debug 默认只打开设置、不接管壁纸；关闭设置只会隐藏窗口，停止应用应从托盘退出。

官网是独立的 Astro 项目，Node 要求见其 `package.json`，CI 使用 Node 24；详见[官网开发指南](../../website/README.md)。不要把官网的要求混入应用环境表。

## 构建与桌面验收

```powershell
pnpm test-mode
pnpm test-mode -SkipVerify -HoldSeconds 30
pnpm build
pnpm release:package
```

`test-mode` 构建 DLL、启动应用、验证桌面层序 / 命中 / 动画，再退出还原桌面，会临时操作真实桌面。验收需要 Pillow；可用 `LULL_PYTHON` 指定解释器，或在 PATH 中提供 `uv`。

`pnpm build` 经 `scripts/prebuild.mjs` 编译翻译、校验内容和能力、构建随包扩展与 DLL，再静态导出前端。`pnpm release:package` 将安装包、便携版和 SHA256 校验和整理到 `artifacts/release/`；便携版必须包含随包扩展、索引与摘要锁。

视频默认使用 HTML `<video>`。验证可选原生后端前，先按[媒体运行时](../media-runtime.md)准备 FFmpeg、libclang 和兼容的 WebView2 环境：

```powershell
pnpm test-mode -NativeMedia
pnpm test-mode -NativeMedia -RequireNative
```

`-RequireNative` 要求启动场景确实使用视频且原生 attach 成功；普通预览允许回退。不要把某一台机器上的错误码或测试结果写成所有用户的运行条件。

## 开发第一个工具

以下命令在仓库根目录运行，无需全局安装 `lull-ext` 或智能体技能：

```powershell
node Skill/lull-extension/bin/lull-ext.mjs sdk build --from . --out ./artifacts/extension-sdk
node Skill/lull-extension/bin/lull-ext.mjs new widget ./artifacts/hello-lull --id hello-lull --name "Hello Lull" --sdk ./artifacts/extension-sdk
node Skill/lull-extension/bin/lull-ext.mjs validate ./artifacts/hello-lull --strict
node Skill/lull-extension/bin/lull-ext.mjs pack ./artifacts/hello-lull --out ./artifacts/extension-packages
```

在“设置 → 扩展 → 从文件安装”选择 `hello-lull-0.1.0.lull-widget.zip`，阅读清单后安装、启用并打开。修改生成的 HTML / JavaScript / CSS 后重新校验和打包；更新已安装包时提高 `widget.json` 的版本号。模板默认许可是 MIT，分发前填写作者与适用许可，并保留 SDK 声明。

SDK 构建会写入仓库各包的 `dist/`，再复制到输出目录；缺 TypeScript 时会尝试通过 npm 准备包级依赖。更多 CLI 参数与可选智能体技能见 [Skill 指南](../extension-skill.md)。

## 场景与接口边界

静态场景以 `catalog.json` 和 HTML 入口组成内容包，在禁止脚本的 iframe 中运行，动态效果可用 CSS。脚本场景声明 `wallpaper.script`，将 Scene SDK 打入本地包，再按需声明参数、同步、鼠标或音频能力。

```powershell
pnpm scenes:sdk
pnpm content:hash --bundle ./my-scene
pnpm content:hash --bundle ./my-scene --check
pnpm content:pack ./my-scene --out artifacts
```

这里的 `my-scene` 必须先按[内容格式](../content-format.md)准备；也可以用 CLI 的 `new scene` 生成骨架。打包工具生成正斜杠 ZIP 路径，避免安装器拒绝反斜杠条目。

Rust 宿主用 URL 哈希传递 `mode / sync / scene / canvas / view / params`，场景宿主负责解析和向脚本场景发送帧。音频响应使用独立只读通道，要求 `wallpaper.audio` 与宿主 API 5；不提供原始 PCM、文件路径或播放控制。参数热更新、跨屏坐标、权限和桥协议见[Scene SDK](../scene-sdk.md)及[架构说明](../architecture.md)。

Scene、Widget、Media、Game SDK 独立演进，当前均按实验性接口使用。包版本、宿主 API 和清单 schema 是不同概念；不要根据应用版本推测所有 SDK 的版本。React / Vue / testing 等导出入口以各包 `package.json` 为准。长期兼容、弃用周期和迁移承诺尚未建立。

## 常用命令

下列命令均在仓库根目录执行，生成 / 安装类命令会写入相应产物或用户目录。

| 命令 | 用途 |
| --- | --- |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 前端测试、类型和代码检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust 测试 |
| `pnpm check` | 前端、内容、清单、SDK、适配器和扩展综合检查 |
| `pnpm widgets:sdk` / `pnpm scenes:sdk` / `pnpm media:sdk` / `pnpm game:sdk` | 分别构建四个 SDK |
| `pnpm game:adapters` / `pnpm game:adapters:check` | 游戏渲染适配器构建 / 类型检查 |
| `pnpm content:check` / `pnpm content:hash` / `pnpm content:pack <dir>` | 内容校验、摘要和打包 |
| `pnpm content:keygen` / `pnpm content:sign` / `pnpm content:verify` | 本机内容目录密钥生成、签名与验签；私钥在 `.keys/`，不能提交 |
| `pnpm widgets:gen` / `pnpm widgets:check` | 生成窗口 capability / 校验清单 |
| `pnpm scenes:samples:build` / `pnpm scenes:samples:check` | 场景示例构建 / 摘要校验；各脚本覆盖的示例集合见根 `package.json` |
| `pnpm widgets:samples:build` / `pnpm widgets:samples:pack` | 工具示例构建 / ZIP 打包；批量打包含故意篡改的测试包，不应分发该测试包 |
| `pnpm widget:pack <dir>` | 打包单个构建后的工具目录 |
| `pnpm games:samples:build` / `pnpm games:samples:pack` | 游戏示例构建 / 打包 |
| `pnpm extensions:build` / `pnpm extensions:check` | 随包扩展构建 / 源码边界和摘要检查 |
| `pnpm extensions:dev <id>` / `pnpm extensions:watch <id>` | 官方扩展开发服务器 / 监听重建 |
| `pnpm build:next` | 仅构建前端，不能替代完整应用打包 |

## 目录与文档入口

| 目录 / 主题 | 职责与文档 |
| --- | --- |
| `src-tauri/src/`、`src-tauri/native/`、`src/core/` | 宿主、原生桌面层、配置及平台能力；[架构](../architecture.md)、[原生宿主](../native-host.md) |
| `src/scenes/`、`src/widgets/`、`src/sdk/` | 媒体壁纸、场景桥、窗口清单和宿主侧契约 |
| `packages/` | 四类 TypeScript SDK 和游戏渲染适配器；[Widget SDK](../widget-sdk.md)、[Scene SDK](../scene-sdk.md)、[Media SDK](../../packages/media-sdk/README.md)、[Game SDK](../game-sdk.md) |
| `extensions/official/`、`extensions/bundled/` | 官方源码与预构建随包扩展；[官方扩展](../official-extensions.md)、[开发模式](../extension-dev-mode.md) |
| `examples/` | 场景、工具和游戏示例；[游戏打包](../../examples/games/README.md) |
| `content/`、`public/content/` | Schema 与内容目录；[内容格式](../content-format.md) |
| 扩展运行与管理 | [扩展中心设计](../extension-center.md)、[功能槽位](../extension-slots.md)；设计阶段说明需结合代码阅读 |
| 游戏运行时 | [宿主实现](../game-runtime.md)、[稳定性验收记录](../game-runtime-webview-stability.md) |
| 音乐、音境与视频 | [媒体服务](../media-service.md)、[智能随机](../smart-shuffle.md)、[视频运行时](../media-runtime.md) |
| `docs/`、`website/` | [贡献](../contributing.md)、[多语言](../i18n-plan.md)、[许可](../licensing.md)、[官网开发](../../website/README.md) |
