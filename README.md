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
- **托盘常驻**：关闭窗口只隐藏；只有托盘「退出」才结束进程。
- **可扩展内容**：外部静态场景包通过 `public/content/catalog.json` 被发现，不需要改核心代码。

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
  scenes/                  # 官方内置场景（bamboo / aurora / dusk）与注册表
  widgets/registry.ts      # 内置工具窗口元数据（设置页唯一来源）
  components/              # 窗口外壳、共享 UI、播放器/番茄钟/白噪音实现
  styles/                  # Tailwind 主题与壁纸动效
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
| **B · Extensions** | `src/sdk/{scene,widget,content}` + `src/scenes` + `src/widgets` | 场景清单/目录协议、工具窗口能力分层；首版只开放静态场景包 |
| **C · Community** | `content/schema` + `public/content` + `scripts/validate-content.mjs` | 内容包格式、示例、校验工具；尚未提供在线市场 |
| **D · Services** | 设计文档 | 内容索引、同步、发布服务；不影响本地核心运行 |

壁纸运行协议：Rust 把 `mode / sync / scene / canvas / view` 编码进窗口 URL 哈希，前端 `SceneHost` 解析后选择内置组件或外部静态包。该协议是前后端唯一画面契约。

## 扩展内容

### 新增一个官方内置场景

1. 在 `src/scenes/<id>/index.tsx` 实现一个接收 `SceneProps` 的组件。
2. 在 `src/scenes/registry.ts` 增加 `parseSceneManifest(...)` 与 `BuiltinScene` 条目。
3. 运行 `pnpm test`；设置页与壁纸宿主会自动读取新清单。

### 新增一个外部静态场景包（不改核心）

```text
public/content/
  catalog.json
  scenes/mist/
    index.html
```

在 `catalog.json` 中登记 manifest（`id`、`version`、`license`、`entry`、`capabilities`），运行：

```powershell
pnpm content:check
```

外部场景在 `sandbox=""` 的 iframe 中运行：不执行 JavaScript，没有 Tauri IPC 与同源存储权限。动态效果请用 CSS 动画；需要宿主参数的场景应做成内置场景。

字段与打包细节见 [Scene SDK](docs/scene-sdk.md) 与 [内容格式](docs/content-format.md)。

> **安全边界**：首版只支持静态 HTML/CSS 内容包。第三方工具窗口、任意 Rust 命令和 Win32 调用不开放；工具窗口仍由官方代码注册。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Tauri 开发模式（debug 默认不启用壁纸） |
| `pnpm test` | Vitest 前端测试（jsdom） |
| `cargo test` | Rust 单元测试（在 `src-tauri/` 下） |
| `pnpm lint` / `pnpm fix` | Biome 检查 / 自动修复 |
| `pnpm content:check` | 校验内容目录与 entry 文件 |
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
- [内容包格式](docs/content-format.md)
- [原生桌面宿主](docs/native-host.md)
- [许可说明](docs/licensing.md)
- [贡献指南](docs/contributing.md)

## 当前边界

- 仅支持 Windows；Lull 依赖 Win32 `WorkerW` / `Progman` 桌面层，不具备跨平台回退。
- 原生挂载涉及系统桌面层级，失败恢复、真机验收与日志是产品的一部分；发布前请阅读 [原生宿主说明](docs/native-host.md)。
- 不包含在线服务、账号、云同步；断网不影响壁纸、声场与番茄钟。
- 安装包尚未做代码签名；公开分发前需补齐签名与素材授权复核。

## 许可证与归属

Lull 采用**分层许可**，不是单一许可：

| 范围 | 许可 |
| --- | --- |
| 应用代码（Rust / C++ / Next.js / React / 脚本） | **GPL-3.0-or-later** |
| Scene / Widget / Content SDK 公开接口（`src/sdk/**`） | **Apache-2.0** |
| 官方内容目录、Schema、外部示例 | **CC BY 4.0** |
| 文档 | **CC BY 4.0** |
| 字体（Noto Sans SC / Source Han Serif SC） | **SIL OFL 1.1** |
| Lull 名称与 Logo | 商标政策，见 [`TRADEMARK.md`](TRADEMARK.md) |

完整 GPL 文本见 [LICENSE](LICENSE)，许可见解与合规说明见 [docs/licensing.md](docs/licensing.md)、[SDK-LICENSE.md](SDK-LICENSE.md) 与 [CONTENT-LICENSE.md](CONTENT-LICENSE.md)。

> **源码提供**：发布安装包时请同时提供同一 release tag 的源码归档；本仓库即对应源码。
> 安装包内包含 `LICENSE`、`NOTICE`、`LICENSES/` 与 `THIRD_PARTY_NOTICES.md`。
