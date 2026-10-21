# 从 Serene 迁移到 Lull

本文记录 v0.1.0 重构做了什么、没做什么，以及为什么这样分步。目标是让后续贡献者能区分**品牌/命名迁移**与**功能改造**，避免再次把两者混在一起。

## 1. 迁移原则

1. **先保持功能，再改结构**：每个阶段都以测试基线为门槛。
2. **命名迁移一次做完**：DLL、ABI、环境变量、日志、存储键、包 ID 统一替换，避免新旧路径并存。
3. **配置兼容旧数据**：Lull 配置目录中若存在 Serene v1 的 `wallpaper.json`，会读取并迁移，不要求用户手改。
4. **不为了目录整齐拆仓库**：Rust 仍是单一 crate；前端按 `core/sdk/scenes/widgets` 分层。
5. **保留关键技术资产**：Win32 挂载、看门狗、跨屏几何、WebView2 时序经验原样保留。

## 2. 产品身份

| 项目 | Serene | Lull |
| --- | --- | --- |
| 产品名 | `tauri-nextjs-template` / Serene | `Lull` |
| 包 / crate | `tauri-nextjs-template` | `lull` |
| Rust lib | `tauri_nextjs_template_lib` | `lull_lib` |
| 可执行文件 | `tauri-nextjs-template.exe` | `lull.exe` |
| bundle identifier | `com.template.tauri-nextjs` | `app.lull.desktop` |
| 原生 DLL | `serene_probe.dll` | `lull_native.dll` |
| C ABI 前缀 | `serene_probe_*` | `lull_native_*` |
| C++ 命名空间 | `serene::wallpaper` | `lull::wallpaper` |
| 原生日志 | `%TEMP%\serene_wallpaper.log` | `%TEMP%\lull_wallpaper.log` |
| 应用日志 | `%TEMP%\serene_probe\wallpaper-app.log` | `%TEMP%\lull\app.log` |
| 启用壁纸 | `SERENE_WALLPAPER=1` | `LULL_WALLPAPER=1` |
| DevTools | `SERENE_DEVTOOLS` | `LULL_DEVTOOLS` |
| 配置 | `wallpaper.json` | `display.json`（旧文件自动迁移） |
| 默认场景 | `serene` | `lull.bamboo` |

### 2.1 浏览器存储键

| 旧 | 新 |
| --- | --- |
| `serene:window:locked` | `lull:window:locked` |
| `serene:flow-theme` | `lull:flow-theme` |
| `serene:liquid-player:v1` | `lull:player:v1` |
| `serene:liquid-pomodoro:v1` | `lull:pomodoro:v1` |
| `serene:ether:startup` | `lull:noise:startup` |

旧键不自动迁移：Lull 是新的安装标识，首启使用默认值，避免把 Serene 的窗口位置/音量误带过来。

## 3. 场景 id

| 旧 id | 新 id | 说明 |
| --- | --- | --- |
| `serene` | `lull.bamboo` | 默认场景，重做为竹影 |
| `aurora` | `lull.aurora` | 极光，保留并重新命名 |
| `dusk` | `lull.dusk` | 新增暮色场景 |
| 其它 | 原样保留 | 不破坏未来内容包 |

配置读取时自动映射；URL 哈希中的旧 id 由前端回退到默认场景（内置注册表不再含旧 id）。

## 4. 文件迁移

### 4.1 前端

| 旧路径 | 新路径 |
| --- | --- |
| `src/lib/wallpaper-params.ts` | `src/core/wallpaper/params.ts` |
| `src/lib/window-controls.ts` | `src/core/window/controls.ts` |
| `src/lib/window-fit.ts` | `src/core/window/fit.ts` |
| `src/lib/wallpaper-scenes.ts` | 删除，并入 `src/scenes/registry.ts` |
| `src/app/(wallpaper)/scenes.tsx` | `src/scenes/{bamboo,aurora,dusk}/index.tsx` + `registry.ts` |
| — | 新增 `src/sdk/{scene,widget,content}` |
| — | 新增 `src/scenes/host.tsx`（内置/外部场景宿主） |
| — | 新增 `src/content/catalog.ts`（目录加载） |
| — | 新增 `src/widgets/registry.ts`（工具窗元数据） |

### 4.2 Rust

| 旧路径 | 新路径 |
| --- | --- |
| `src/wallpaper.rs` | `src/wallpaper/{mod,runtime,windows,watchdog,protocol,topology,ffi}.rs` |
| `src/wallpaper_config.rs` | `src/config/mod.rs` |
| `src/windows.rs` | `src/window_host/{mod,spec}.rs` |
| `src/window_prefs.rs` | `src/window_host/prefs.rs` |
| `player_set_frame` | `window_set_frame`（通用原子窗口帧） |
| `greet` 命令 | 删除（模板残留） |

### 4.3 原生与工具

| 旧路径 | 新路径 |
| --- | --- |
| `src-tauri/probe/native/` | `src-tauri/native/` |
| `serene_probe_shim.cpp` | `lull_native_shim.cpp` |
| `serene_wallpaper/` | `lull_wallpaper/` |
| `src-tauri/probe/tools/` | `src-tauri/acceptance/` |
| `probe_check.py` | `check_desktop.py` |
| `src-tauri/probe/test-mode.ps1` | `scripts/test-mode.ps1` |
| `serene_probe.dll` | `lull_native.dll` |

## 5. 配置迁移

`src-tauri/src/config/mod.rs`：

- `CURRENT_VERSION = 2`；
- v1 → v2：`display.scene` 与每屏 `monitors.*.scene` 按场景映射表替换；
- 未知场景 id 保留；
- 高于当前版本的配置不解释、不覆盖，回退默认并记录警告；
- 写盘改为临时文件 + 原子替换；
- 启动时优先读 `display.json`，不存在则读旧 `wallpaper.json`，迁移后写回新文件。

测试：`cargo test` 覆盖 v1 迁移、未来版本、损坏文件、离线显示器键保留、原子写盘。

## 6. 有意保留的内部代号

以下名称仍出现在代码里，但不对用户展示，也不构成产品身份：

- `ether-bubbles/`（白噪音组件目录与 CSS Module）
- `liquid-player/`、`liquid-pomodoro/`（播放器/番茄钟组件）
- 音频探针变量 `probeTrackDuration`（读取媒体元数据，与旧项目无关）
- 验收工具内部的 `probe_chain`（命中测试辅助函数）

这些是组件/函数级命名，不影响二进制、配置或扩展协议。后续可在独立 PR 中清理，避免与功能改动混在一起。

## 7. 对用户可见的变化

- 窗口标题、托盘菜单、设置页品牌改为 Lull；
- 默认场景从抽象霓虹改为竹影；
- 白噪音工具从「以太母泡」改名「白噪音」；
- 设置页新增场景来源/版本/许可证、关于 Lull 卡片；
- 外部示例场景「雾岚」出现在场景下拉框；
- 配置路径、日志路径、存储键变化（见上表）。

## 8. 验证基线

重构完成时的结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 16 个文件 / 91 项通过 |
| `cargo test` | 37 项通过 |
| `pnpm lint` | Biome 通过 |
| `pnpm content:check` | 1 个外部场景通过 |
| `pnpm build:next` | 6 个静态路由导出成功 |
| `lull_native.dll` | 13 个 `lull_native_*` 导出 |
| `pnpm test-mode` | PASS：层序 / 命中 / 动画差分 1.83% / 桌面还原 |

> 数字会随测试增加变化；以当前 CI 输出为准。

## 9. 后续清理清单

- [ ] 评估是否把 `lull_wallpaper` 头文件独立为 `native-host` 子模块；
- [ ] 为内容包增加用户目录（不修改安装目录）；
- [ ] 为 Widget SDK 增加受限状态 API；
- [ ] 评估 `scene-sdk` / `widget-sdk` 是否值得独立发布；
- [ ] 真机复核混合 DPI 与 Explorer 重启路径；
- [ ] 安装包签名与素材授权复核。

## 10. 归属

Lull 是 Serene（Copyright © 2022 Kevin Xiao，MIT）的衍生重构项目。
原始版权声明保留在 [`LICENSE`](../LICENSE)；字体与依赖授权见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
