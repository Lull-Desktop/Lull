# 云栖 / Lull

> 云栖之处，安然入眠。

**Lull** 是一款开源的助眠与专注桌面应用。屏幕亮着，不吵你；闭上眼，它哄你睡。

竹影、暮色与极光在桌面上缓缓流动，雨声、风声、海浪、篝火与远雷在耳边轻轻起伏。它不推送、不催促、不打扰——只是安静地陪着，直到你睡着，或把手头的事做完。

Lull 采用 Tauri + Win32 桌面宿主这条最难的技术路径，**桌面运行时核心（Core）＋ 场景/工具 SDK（Extensions）＋ 内容格式（Community）＋ 可选服务（Services）** 四层。详见 [架构说明](docs/architecture.md)。

---

## 功能

- **动态壁纸**：竹影、暮色、极光三个官方场景；每台显示器一个壁纸窗口；支持复制 / 独立 / 跨屏三种模式与跨屏同步动画。
- **白噪音**：雨、雷、风、海浪、篝火五层声景独立混音，主音量、静音与助眠定时。
- **番茄钟**：液态时间沙漏，专注 / 短休 / 长休节奏，可保存偏好。
- **播放器**：液态黑胶浮窗，在线氛围声与本地曲目。
- **托盘常驻**：关闭窗口只隐藏；只有托盘「退出」才结束进程；托盘「扩展」子菜单直接打开已启用的工具扩展。
- **可扩展内容**：外部场景包通过 `catalog.json` 被发现，支持静态 HTML/CSS 与声明 `wallpaper.script` 的沙箱脚本场景（参数、几何、同步相位经 `@lull/scene-sdk` 下发）；第三方内容包可在「扩展」页「从文件安装」选择 zip / 拖入安装，安装时复核清单与整包摘要。
- **扩展中心**：设置页「扩展」页签统一管理壁纸内容与工具扩展；导入前预览清单、能力与体积，安装不执行代码，启用时才授权；scene 支持同 id 覆盖安装（本地手动更新，壁纸按版本重载）；参数按 Manifest 类型渲染，带 min/max 的数字参数使用滑条；开发模式可挂载本地目录热调试。
- **自定义 Widget 插件**：静态包安装到用户目录，宿主壳 + iframe + Rust 状态 KV；支持自绘窗口顶栏/透明背景，提供原生 / React / Vue 示例，见 [插件包格式](docs/widget-package.md)。

## 界面预览

| 竹影（默认） | 暮色 |
| --- | --- |
| ![竹影](docs/assets/scene-bamboo.jpg) | ![暮色](docs/assets/scene-dusk.jpg) |

| 极光 | 社区示例「雾岚」 |
| --- | --- |
| ![极光](docs/assets/scene-aurora.jpg) | ![雾岚](docs/assets/scene-mist.jpg) |

![设置窗口](docs/assets/window-setting.jpg)

## 快速开始

### 前置条件

| 依赖 | 版本 / 说明 |
| --- | --- |
| Windows | 10 / 11（原生宿主只针对 Win32 桌面层） |
| Node.js | 24（见 `.node-version`） |
| pnpm | 11（见 `package.json` 的 `packageManager`） |
| Rust | `stable-x86_64-pc-windows-msvc`（由 `rust-toolchain.toml` 固定） |
| Visual Studio | 「使用 C++ 的桌面开发」+ Windows 10/11 SDK |
| Git Bash | 编译 `lull_native.dll` 需要 `bash` / `cygpath` |
| Python / uv | `pnpm test-mode` 需要 Pillow；本机 Python 缺 Pillow 时脚本会自动使用 `uv run --with pillow` |

### 安装与开发

```powershell
pnpm install

# 编译原生宿主（首次或改过 src-tauri/native 后）
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh

pnpm dev
```

`pnpm dev` 默认 **不接管桌面壁纸**（debug 构建），只打开设置窗，方便调 UI。
要在开发态验证真实壁纸挂载，使用一键验收模式：

```powershell
pnpm test-mode            # 构建 DLL → 启动 → 层序/命中/动画验收 → 退出并还原桌面
pnpm test-mode -SkipVerify -HoldSeconds 30
```

> 验收脚本需要 Pillow。本机 Python 没有安装时，若 PATH 中有 `uv`，脚本会自动用
> `uv run --with pillow` 准备临时环境；也可以用 `LULL_PYTHON` 指定一个已安装 Pillow 的解释器。

### 构建安装包

```powershell
pnpm build
```

`scripts/prebuild.mjs` 会依次：校验内容目录 → 编译 `lull_native.dll` → 清理 `dist/.next` → Next 静态导出 → 触碰 `lib.rs` 强制重嵌入。

## 目录结构

```text
src/
  app/                     # Next.js 路由外壳（设置 / 壁纸 / 工具窗）
  core/
    wallpaper/params.ts    # URL 哈希协议、跨屏几何、同步相位（纯函数）
    window/                # 无边框窗口的 IPC 封装与贴合计算
  content/catalog.ts       # 内容目录加载服务（依赖 sdk/scene）
  sdk/
    scene/                 # Scene Manifest、Catalog、运行时类型
    widget/                # Widget Manifest、能力分层
    content/               # 通用内容包清单
  scenes/                  # 官方内置场景（bamboo / aurora / dusk）、外部场景桥与注册表
  widgets/registry.ts      # 内置工具窗口元数据（设置页唯一来源）
  components/              # 窗口外壳、共享 UI、播放器/番茄钟/白噪音实现
  styles/                  # Tailwind 主题与壁纸动效
packages/widget-sdk/       # 第三方插件侧 SDK：TypeScript 源码 → dist + .d.ts
packages/scene-sdk/        # 场景侧 SDK：参数/几何/同步/可见性桥
examples/widgets/          # 原生 / React / Vue 三个 TypeScript 插件包示例
examples/content/          # 可安装内容包示例（静态 / 脚本场景）
src-tauri/
  src/
    lib.rs                 # 只做插件/命令/生命周期接线
    config/                # display.json 模型、版本迁移、原子写盘
    wallpaper/
      ffi.rs               # lull_native.dll 加载与 C ABI
      topology.rs          # 显示器枚举、虚拟桌面几何
      protocol.rs          # 壁纸 URL 哈希协议
      windows.rs           # 壁纸窗口创建/销毁/重建/热更新
      watchdog.rs          # 挂载修复、拓扑指纹、WorkerW 补建
      runtime.rs           # 配置状态、生命周期、IPC 命令
    window_host/           # 窗口工厂 + WidgetSpec + 全局窗口偏好
  content_package/       # 用户内容包：清单校验、整包摘要、zip 安装、lullcontent:// 协议
  native/                  # C++ 原生宿主（lull_native.dll）
  acceptance/              # Windows 真机验收工具（Python）
  capabilities/            # Tauri 权限（壁纸窗口刻意不在授权列表内）
public/content/            # 随包分发的内容目录与外部场景示例
content/schema/            # JSON Schema
docs/                      # 架构、SDK、内容格式、原生宿主、贡献指南
scripts/                   # 构建、内容校验、预览、验收编排
```

## 架构一页

| 层 | 当前落地 | 说明 |
| --- | --- | --- |
| **A · Core** | `src-tauri/src/{wallpaper,window_host,config}` + `src/core` | 桌面宿主、显示器拓扑、窗口生命周期、配置、IPC、原生桥 |
| **B · Extensions** | `src/sdk/{scene,widget,content}` + `src/scenes` + `src/widgets` + `packages/{widget-sdk,scene-sdk}` | 场景清单/目录协议、脚本场景桥、工具窗口能力分层；插件侧与场景侧 SDK 均为 TypeScript（`dist` + `.d.ts`）；外部场景支持静态包与 `wallpaper.script` 沙箱包 |
| **C · Community** | `content/schema` + `public/content` + `scripts/{hash,sign,validate}-content.mjs` + `src-tauri/src/content_package` | 内容包格式、包摘要、目录签名、校验工具；用户内容目录与安装器（拖入 zip/文件夹、摘要复核）已落地；仍无在线市场 |
| **D · Services** | 设计文档 | 内容索引、同步、发布服务；不影响本地核心运行 |

壁纸运行协议：Rust 把 `mode / sync / scene / canvas / view / params` 编码进窗口 URL 哈希，前端 `SceneHost` 按 Manifest 解析默认值、能力与兼容性后选择内置组件或外部包；脚本场景再由 `scene-bridge` 把帧推给 `@lull/scene-sdk`。该协议是前后端唯一画面契约。

## 扩展内容

### 新增一个官方内置场景

1. 在 `src/scenes/<id>/index.tsx` 实现一个接收 `SceneProps` 的组件。
2. 在 `src/scenes/registry.ts` 增加 `parseSceneManifest(...)` 与 `BuiltinScene` 条目。
3. 运行 `pnpm test`；设置页与壁纸宿主会自动读取新清单。

### 新增一个外部场景包（不改核心）

静态包：

```text
my-scene/
  catalog.json
  scenes/mist/
    index.html
```

在 `catalog.json` 中登记 manifest（`id`、`version`、`license`、`entry`、`capabilities`，可选 `performance`、`compatibility`），运行：

```powershell
pnpm content:hash --bundle ./my-scene
pnpm content:hash --bundle ./my-scene --check
pnpm content:pack ./my-scene --out artifacts
```

> 不要用 Windows 自带的 `Compress-Archive` 或部分压缩工具：它们可能把 zip 条目写成
> 反斜杠路径，Lull 安装器会按安全规则拒绝。`content:pack` 统一写正斜杠与 UTF-8。

静态包在 `sandbox=""` 的 iframe 中运行：不执行 JavaScript，没有 Tauri IPC 与同源存储权限；
不能声明参数或同步，动态效果只能用 CSS。

需要参数/几何/同步的场景，声明 `wallpaper.params`、`wallpaper.sync` 与 `wallpaper.script`，
在包里打包 `@lull/scene-sdk`：

```powershell
pnpm scenes:sdk
# 在场景工程里用 esbuild / Vite 把 main.ts 打成包内 main.js
```

Setting 会按 Manifest 的 `params` 自动渲染控件；改值后热更壁纸 URL 哈希，
再由 `scene.onFrame((frame) => ...)` 把 `frame.params` 送到场景，不需要重启壁纸。
可直接安装的示例：
[`examples/content/param-demo`](examples/content/param-demo)（参数演示，1.1.0）与
[`examples/content/three-scene`](examples/content/three-scene)（Three.js WebGL，1.0.0）；
打包后分别在 `artifacts/demo.param-scene-1.1.0.zip`、`artifacts/demo.three-scene-1.0.0.zip`。

字段与打包细节见 [Scene SDK](docs/scene-sdk.md)、[`@lull/scene-sdk`](packages/scene-sdk/README.md) 与 [内容格式](docs/content-format.md)。

> **安全边界**：静态包不执行脚本；脚本场景运行在 opaque-origin 的 `allow-scripts` iframe 中，
> 只能通过 Scene SDK 桥读取宿主下发的帧，不开放宿主 DOM、任意 Tauri IPC、Rust 命令或 Win32 调用。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Tauri 开发模式（debug 默认不启用壁纸） |
| `pnpm test` | Vitest 前端测试（jsdom） |
| `cargo test` | Rust 单元测试（在 `src-tauri/` 下） |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm content:check` | 校验内容目录、包摘要与目录签名 |
| `pnpm content:hash` | 重算并写回内容包的 `integrity` 摘要（`--bundle <dir>` 可处理待分发内容包） |
| `pnpm content:pack <dir>` | 把内容包打成可安装 zip（正斜杠 + UTF-8，避免 Windows 压缩工具的反斜杠） |
| `pnpm content:sign` | 用本机私钥给 `catalog.json` 原始字节签名 |
| `pnpm content:keygen` | 生成内容签名密钥（私钥在 `.keys/`，不进仓库） |
| `pnpm widgets:sdk` | 构建第三方插件 SDK（TypeScript → `dist` + `.d.ts`） |
| `pnpm widgets:sdk:check` | 只做 SDK 类型检查（CI 用） |
| `pnpm scenes:sdk` | 构建场景侧 SDK（TypeScript → `dist` + `.d.ts`） |
| `pnpm scenes:sdk:check` | 只做场景 SDK 类型检查（CI 用） |
| `pnpm scenes:samples:build` | 构建 `param-demo` / `three-scene` 两个脚本场景示例 |
| `pnpm scenes:samples:hash` | 重算两个示例的 `integrity` |
| `pnpm scenes:samples:check` | 校验两个示例摘要（CI 用） |
| `pnpm scenes:samples:pack` | 把两个示例打成可安装 zip |
| `pnpm widgets:samples:build` | 构建 `examples/widgets/*` 三个示例插件包 |
| `pnpm widgets:samples:pack` | 把三个示例打成 `artifacts/*.lull-widget.zip`（含 tampered 测试包） |
| `pnpm widget:pack <dir>` | 把任意构建后的 Widget 目录打成可安装 zip |
| `pnpm build:next` | 仅导出 Next 静态前端 |
| `pnpm test-mode` | Windows 真机壁纸验收（构建 DLL、层序/命中/动画） |
| `pnpm build` | 完整 Tauri 安装包构建 |

## 日志与配置

- 配置：`%APPDATA%\app.lull.desktop\display.json`（旧版 `wallpaper.json` 不再读取）
- 应用日志：`%TEMP%\lull\app.log`
- 原生宿主日志：`%TEMP%\lull_wallpaper.log`
- 验收截图 / 日志：`%TEMP%\lull\`

## 文档

- [架构与模块边界](docs/architecture.md)
- [Scene SDK](docs/scene-sdk.md)
- [Widget SDK](docs/widget-sdk.md)
- [Widget 插件 SDK（`@lull/widget-sdk`）](packages/widget-sdk/README.md)
- [Scene 场景 SDK（`@lull/scene-sdk`）](packages/scene-sdk/README.md)
- [内容包格式](docs/content-format.md)
- [扩展中心设计](docs/extension-center.md)（v1 进行中：后端与基础 UI 已落地）
- [扩展中心实施计划](docs/extension-center-plan.md)
- [原生桌面宿主](docs/native-host.md)
- [许可说明](docs/licensing.md)
- [贡献指南](docs/contributing.md)

## 当前边界

- 仅支持 Windows；Lull 依赖 Win32 `WorkerW` / `Progman` 桌面层，不具备跨平台回退。
- 原生挂载涉及系统桌面层级，失败恢复、真机验收与日志是产品的一部分；发布前请阅读 [原生宿主说明](docs/native-host.md)。
- 不包含在线服务、账号、云同步；断网不影响壁纸、声场与番茄钟。
- 内容包安装为本地行为：只接受单场景包、必须声明整包摘要；scene 支持同 id 覆盖安装
  （本地手动更新，壁纸按版本重载），未做第三方签名、在线更新与回滚。
- 外部场景分为静态包与 `wallpaper.script` 脚本包；脚本包只能通过 Scene SDK 桥读取帧，
  仍不是可访问宿主 DOM/原生/IPC 的通用插件系统。
- `@lull/widget-sdk` / `@lull/scene-sdk` 目前随仓库构建，尚未发布到 npm。
- 安装包尚未做代码签名；公开分发前需补齐签名与素材授权复核。

## 许可证与归属

Lull 采用**分层许可**，不是单一许可：

| 范围 | 许可 |
| --- | --- |
| 应用代码（Rust / C++ / Next.js / React / 脚本） | **GPL-3.0-or-later** |
| Scene / Widget / Content SDK 公开接口（`src/sdk/**`、`packages/*-sdk/**`） | **Apache-2.0** |
| 官方内容目录、Schema、外部示例 | **CC BY 4.0** |
| 文档 | **CC BY 4.0** |
| 字体（Noto Sans SC / Source Han Serif SC） | **SIL OFL 1.1** |
| Lull 名称与 Logo | 商标政策，见 [`TRADEMARK.md`](TRADEMARK.md) |

完整 GPL 文本见 [LICENSE](LICENSE)，许可见解与合规说明见 [docs/licensing.md](docs/licensing.md)、[SDK-LICENSE.md](SDK-LICENSE.md) 与 [CONTENT-LICENSE.md](CONTENT-LICENSE.md)。

> **源码提供**：发布安装包时请同时提供同一 release tag 的源码归档；本仓库即对应源码。
> 安装包内包含 `LICENSE`、`NOTICE`、`LICENSES/` 与 `THIRD_PARTY_NOTICES.md`。
