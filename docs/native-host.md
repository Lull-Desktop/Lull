# 原生桌面宿主（lull_native.dll）

> Lull 的壁纸层不是普通置底窗口：它要把 WebView2 窗口挂到 Windows 桌面宿主
> （`Progman` / `WorkerW`）的 Z 序里，并在 Explorer 重启、DPI 变化、分辨率切换后自愈。
> 这部分能力全部收敛在 `src-tauri/native/`，通过稳定的 C ABI 暴露给 Rust。

## 1. 文件与职责

```text
src-tauri/native/
  lull_native_shim.cpp        # C ABI 导出 + 槽位管理 + 视觉硬化
  build-shim.sh               # MSVC / Windows SDK 探测与编译
  lull_wallpaper/
    wallpaper_host.h          # 挂载 / 卸载 / 修复 / 状态
    monitors.h                # 显示器枚举、DPI、拓扑指纹
    timing.h                  # 分阶段耗时日志
    log_file.h                # %TEMP%\lull_wallpaper.log
```

原则：

- C++ 不依赖 React、Tauri 命令或内容包；
- Rust 负责调度、配置与业务状态，C++ 只做 Win32 宿主能力；
- 头文件是仓库内副本，不跨仓引用；
- DLL 与 Rust 必须一起构建、一起发布。

## 2. 构建

前置：

- Visual Studio 的「使用 C++ 的桌面开发」；
- Windows 10/11 SDK；
- Git Bash（提供 `bash`、`cygpath`）。

```bash
# Git Bash
src-tauri/native/build-shim.sh
```

脚本会：

1. 从 `LULL_MSVC_ROOT` 或 VS 安装目录中挑选最高版本 MSVC；
2. 从 `LULL_WINSDK_ROOT` / `Include` 中挑选最新 SDK；
3. 以 `/MT /LD /O2 /std:c++17` 编译 `lull_native.dll`；
4. 输出 DLL、`.lib`、`.exp`、`.obj`（后三者被 gitignore）。

可覆盖变量：

| 变量 | 作用 |
| --- | --- |
| `LULL_MSVC_ROOT` | 指定 MSVC 工具链根目录 |
| `LULL_WINSDK_ROOT` | 指定 Windows SDK 根目录 |
| `LULL_WINSDK_VERSION` | 指定 SDK 版本 |

验证导出：

```powershell
dumpbin /exports src-tauri/native/lull_native.dll
```

应看到 13 个 `lull_native_*` 符号。

## 3. C ABI

| 导出 | 参数 | 返回 / 错误 |
| --- | --- | --- |
| `lull_native_attach` | `HWND, monitor_index` | `0` 成功；`-100` 无效 HWND；`-101` 已挂载；`-102` 宿主探测失败；`-103` 下标越界；`-104` 挂载失败（已回滚）；`-105` 槽位用尽 |
| `lull_native_detach` | `HWND` | `0` 成功；`-1` 未挂载；`-2` 还原失败 |
| `lull_native_ensure` | `HWND` | 修复位掩码：`1` 样式、`2` 层序、`4` 矩形、`8` WebView 覆盖；`0` 正常；`<0` 错误 |
| `lull_native_status` | `HWND, buf, cap` | `0` 成功；`1` 目标已死；`-1` 参数无效 |
| `lull_native_set_visible` | `HWND, visible` | 应用后的可见性；`-1` 无效 |
| `lull_native_get_visible` | `HWND` | `0/1`；`-1` 无效 |
| `lull_native_monitor_count` | — | 显示器数量（`>= 1`） |
| `lull_native_monitor_info` | `index, buf, cap` | `0` 成功；`-1` 参数无效；`-2` 越界 |
| `lull_native_topology_hash` | — | 拓扑指纹（数量/设备/矩形/DPI/主屏/宿主尺寸） |
| `lull_native_ensure_host` | — | `0` 宿主存在；`1` 已请求补建；`-1` 找不到 Progman；`-2` Post 失败 |
| `lull_native_disable_dwm_frame` | `HWND` | `0` 成功；`-1` 无效 |
| `lull_native_force_repaint` | `HWND` | `0` 成功；`-1` 无效 |
| `lull_native_is_elevated` | — | `1/0` 提升状态；`-1` 查询失败（Rust 暂未绑定） |

`monitor_index = -1` 表示铺满整个宿主客户区（单窗跨屏兜底）；`>= 0` 表示只占该显示器矩形。

## 4. 挂载流程

1. Rust 以无边框、`shadow(false)`、隐藏状态创建 `WebviewWindow`；初始 `inner_size` 用目标显示器的物理矩形（按主屏 DPI 折算成逻辑尺寸），避免 Tauri 默认 800×600 让 WebView2 先按小视口加载/绘制；
2. 取 `HWND`，调用 `lull_native_disable_dwm_frame`（在 WebView 创建前/后都调用一次做硬化）；
3. `lull_native_attach(hwnd, index)`：
   - 探测宿主布局（`Progman` 子级 / 分层窗口）；
   - 先装 `WM_ERASEBKGND` / `WM_DPICHANGED` 子类，再挂载（闭合 DPI 竞态）；
   - `SetParent` 到桌面宿主、调整样式与 Z 序；
   - 摆好最终矩形后、`ShowWindow` 之前同步补发一次 `WM_SIZE`，让 wry 的父窗口子类把 WebView2 controller bounds 与 `WRY_WEBVIEW` 子窗一起设到最终尺寸；返回前再用 `EnsureWebviewCover` 兜底；
   - 失败时滚回原过程并释放槽位；
4. Rust 在 120ms / 700ms / 1800ms / 3500ms 复写 controller bounds 并强制重绘；第一个 120ms 复查专门接住 Tauri 在 `ShowWindow` 之后才处理的 `Resized`（125% 屏上可能缩成 0.8×），此时启动幕还盖着。**不再**在可见窗口上做 1px 收缩/回弹（那会让 WebView2 重新布局一帧，表现为另一次闪动）。

### 4.1 为什么吞 `WM_DPICHANGED`

tauri-runtime-wry 用 `size.to_logical(window.scale_factor())` 计算 WebView bounds。
壁纸窗被移动到 125% 屏幕时，tao 的 scale 缓存可能被污染成 1.25，bounds 被除成 0.8×，
表现为「普通模式不全屏」。壁纸窗永远占满整屏，吞掉该消息即可把缓存钉在 1.0。

### 4.2 白边与 DWM

- 关闭 DWM 非客户区渲染（圆角/边框/边框色）；
- 子类化拦截 `WM_ERASEBKGND`，用页面底色填未绘制区；
- 挂载后强制重绘，清掉首帧残留的浅色像素；
- `.shadow(false)` 避免 tao 阴影帧导致客户区内缩。

### 4.3 启动首帧与启动幕

- 原生侧的目标：第一帧可见画面就是最终尺寸。窗口创建尺寸、挂载时同步 `WM_SIZE`、显示前 `EnsureWebviewCover` 三者一起消除"小窗 → 全屏"跳变。
- 页面侧的目标：遮住"暗场 → 首帧"和"默认回退场景 → 目标场景"之间的内容空档。`BootVeil` 是第一份 HTML 就存在的静态层，场景 `onReady`（内置场景双 rAF / iframe 的 `ready` 或 `onLoad`）后淡出；另有 700ms 最短停留与 3s 兜底。
- 两层职责不能互换：启动幕在 WebView 内部，只能遮内容闪动；窗口/子窗尺寸跳变必须走上面的原生路径。

## 5. 看门狗

`src-tauri/src/wallpaper/watchdog.rs` 每 700ms：

1. 对每个壁纸窗调用 `ensure`，修复样式 / 层序 / 矩形 / WebView 覆盖；
2. 每 3 tick（约 2.1s）比较 `topology_hash`，变化则按配置重建；
3. 每 5 tick（约 3.5s）调用 `ensure_host`，WorkerW 缺失时补建；
4. 每 30 tick 打一行状态日志。

拓扑检测覆盖：改分辨率、改缩放、换主屏、热插拔、Explorer 重启。
窗口数为 0 时也继续检测，保证新插入的显示器能自动开。

## 6. 日志与排障

| 位置 | 内容 |
| --- | --- |
| `%TEMP%\lull\app.log` | Rust 壁纸子系统日志（启动、配置、attach、重建） |
| `%TEMP%\lull_wallpaper.log` | C++ 分阶段耗时 / 状态 |
| `%TEMP%\lull\test-mode.log` | `pnpm test-mode` 的 tauri dev 输出 |
| `%TEMP%\lull\verify_a.png` / `verify_b.png` | 动画差分截图 |

常见判断：

- `attach rc=0`：挂载成功；
- `ensure_fixed=...`：框架层在抢窗口，持续非 0 需要排查；
- `壁纸宿主 WorkerW 缺失`：系统壁纸为纯色/未设置，已请求补建；
- `加载后 url = ...`：确认参数哈希到达 WebView。

## 7. 真机验收

前置：Python 3.10+ 与 Pillow；或安装 [uv](https://docs.astral.sh/uv/)（脚本会自动
`uv run --with pillow`）。也可用 `LULL_PYTHON` 指定解释器。

```powershell
pnpm test-mode
```

流程：构建 DLL → `LULL_WALLPAPER=1 pnpm tauri dev` → 等 `attach rc=0` → 层序 + 命中双视角 + 动画差分 → 关闭 → 等待桌面还原。

手动检查：

- `Win+D` 看壁纸；
- 桌面右键菜单、图标拖拽、任务栏正常；
- 改分辨率 / 缩放 / 主屏后自动重建；
- 关闭某屏壁纸再打开；
- 退出应用后桌面层级恢复。

## 8. 已知风险

- Windows 桌面宿主不是公开稳定 API；Explorer 版本、任务栏设置、混合 DPI 都可能改变行为。
- 非管理员启动时，部分窗口消息会被 UIPI 拦截，时序与管理员模式不同。
- 多屏 + 混合缩放是最容易出问题的组合，必须真机验收。
- 不要用纯单元测试替代 `pnpm test-mode`。

## 9. 重命名 / ABI 变更清单

如果再次修改 DLL 名或导出前缀，必须同步：

1. `src-tauri/native/build-shim.sh` 输出名；
2. `lull_native_shim.cpp` 的 `__declspec(dllexport)` 函数名；
3. `src-tauri/src/wallpaper/ffi.rs` 的 `DLL_NAME` 与 `lib.get(b"...")`；
4. `src-tauri/tauri.conf.json` 的 `bundle.resources`；
5. `scripts/prebuild.mjs` / `scripts/test-mode.ps1` 路径；
6. `src-tauri/acceptance/*.py` 的进程名与 artifacts 目录；
7. 文档、日志路径、CI。

只改目录名而漏掉兼容路径，会让 release 版在无控制台环境下静默失败。
