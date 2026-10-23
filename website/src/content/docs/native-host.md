---
title: 原生桌面宿主
description: lull_native.dll 怎么把 WebView2 挂进 WorkerW / Progman，以及看门狗、日志与真机验收。
order: 9
group: 架构与运行时
source: docs/native-host.md
---

## 为什么需要它

Lull 的壁纸层不是普通置底窗口：它要把 WebView2 窗口挂进 Windows 桌面宿主
（`Progman` / `WorkerW`）的 Z 序里，并在 Explorer 重启、DPI 变化、分辨率切换后自愈。
这部分能力全部收敛在 `src-tauri/native/`，通过稳定的 C ABI 暴露给 Rust。

## 文件与职责

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

原则：C++ 不依赖 React、Tauri 命令或内容包；Rust 负责调度、配置与业务状态；
头文件是仓库内副本，不跨仓引用；DLL 与 Rust 必须一起构建、一起发布。

## 构建

需要 Visual Studio「使用 C++ 的桌面开发」、Windows 10/11 SDK 与 Git Bash：

```bash
# Git Bash
src-tauri/native/build-shim.sh
```

脚本会挑最高版本 MSVC 与最新 SDK，以 `/MT /LD /O2 /std:c++17` 编译，输出 DLL 与
`.lib` / `.exp` / `.obj`（后三者被 gitignore）。可用 `LULL_MSVC_ROOT`、
`LULL_WINSDK_ROOT`、`LULL_WINSDK_VERSION` 覆盖探测结果。

验证导出应看到 13 个 `lull_native_*` 符号：

```powershell
dumpbin /exports src-tauri/native/lull_native.dll
```

## C ABI 要点

| 导出 | 作用 |
| --- | --- |
| `lull_native_attach(hwnd, monitor_index)` | 挂载。`0` 成功，`-100`~`-105` 是各类失败（无效 HWND / 已挂载 / 探测失败 / 越界 / 挂载失败已回滚 / 槽位用尽） |
| `lull_native_detach(hwnd)` | 卸载并还原，`0` 成功 |
| `lull_native_ensure(hwnd)` | 修复位掩码：`1` 样式、`2` 层序、`4` 矩形、`8` WebView 覆盖 |
| `lull_native_status` / `set_visible` / `get_visible` | 状态查询与可见性 |
| `lull_native_monitor_count` / `monitor_info` | 显示器枚举 |
| `lull_native_topology_hash` | 拓扑指纹（数量 / 设备 / 矩形 / DPI / 主屏 / 宿主尺寸） |
| `lull_native_ensure_host` | 宿主缺失时补建 |
| `disable_dwm_frame` / `force_repaint` / `is_elevated` | 视觉硬化与提权查询 |

`monitor_index = -1` 表示铺满整个宿主客户区（单窗跨屏兜底），`>= 0` 表示只占该显示器矩形。

## 挂载流程

1. Rust 以无边框、`shadow(false)`、隐藏状态建窗，初始尺寸直接用目标显示器的物理矩形——
   否则 Tauri 默认 800×600 会让 WebView2 先按小视口加载，首帧就跳。
2. 取 `HWND`，先 `disable_dwm_frame`（WebView 创建前后各一次做硬化）。
3. `attach`：探测宿主布局 → 先装 `WM_ERASEBKGND` / `WM_DPICHANGED` 子类再挂载（闭合 DPI 竞态）
   → `SetParent` 到桌面宿主并调样式与 Z 序 → 摆好最终矩形后仍在隐藏状态补发 `WM_SIZE`
   并 `EnsureWebviewCover` → **不 `ShowWindow`**，显示时机交给页面首帧门 → 失败则回滚并释放槽位。
4. 页面 `Finished` 后用 `set_visible(SW_SHOWNA)` 显示（不激活，不抢设置窗焦点），另有 2.5s 兜底；
   显示前按当前开关与显示器配置复核，避免迟到回调把已关闭的壁纸弹回来。
5. Rust 在 120ms / 700ms / 1800ms / 3500ms 只改尺寸并 `ensure` + 强制重绘。第一个 120ms 复查
   专门接住 Tauri 在 attach 之后才处理的 `Resized`（125% 屏上可能缩成 0.8×）。

### 为什么吞 `WM_DPICHANGED`

tauri-runtime-wry 用 `size.to_logical(scale_factor())` 算 WebView bounds，壁纸窗被移到 125% 屏时
tao 的 scale 缓存可能被污染成 1.25，bounds 被除成 0.8×，表现就是「普通模式不全屏」。
壁纸窗永远占满整屏，吞掉该消息即可把缓存钉在 1.0。

### 白边与启动幕

关掉 DWM 非客户区渲染、子类化拦截 `WM_ERASEBKGND` 用页面底色填未绘制区、挂载后强制重绘、
`.shadow(false)` 避免阴影帧导致客户区内缩。首帧则靠三件事协同：建窗尺寸、隐藏状态同步
`WM_SIZE`、页面侧 `BootVeil`（场景 `onReady` 后淡出，另有 700ms 最短停留与 3s 兜底）。
两层职责不能互换：启动幕只能遮 WebView 内部的内容闪动，窗口尺寸跳变必须走原生路径。

## 看门狗

`wallpaper/watchdog.rs` 每 700ms 跑一轮：

1. 对每个壁纸窗 `ensure`，修复样式 / 层序 / 矩形 / WebView 覆盖；
2. 每 3 tick 比 `topology_hash`，变化则按配置重建；
3. 每 5 tick 调 `ensure_host`，WorkerW 缺失时补建；
4. 每 30 tick 打一行状态日志。

拓扑检测覆盖改分辨率、改缩放、换主屏、热插拔、Explorer 重启；窗口数为 0 时也继续检测，
保证新插入的显示器能自动开。

## 日志与排障

| 位置 | 内容 |
| --- | --- |
| `%TEMP%\lull\app.log` | Rust 壁纸子系统日志（启动、配置、attach、重建） |
| `%TEMP%\lull_wallpaper.log` | C++ 分阶段耗时与状态 |
| `%TEMP%\lull\test-mode.log` | `pnpm test-mode` 的 tauri dev 输出 |
| `%TEMP%\lull\verify_a.png` / `verify_b.png` | 动画差分截图 |

常见判断：`attach rc=0` 表示挂载成功；`ensure_fixed` 持续非 0 说明有框架层在抢窗口；
「壁纸宿主 WorkerW 缺失」表示系统壁纸为纯色或未设置，已请求补建；`加载后 url = ...` 可确认参数哈希到达 WebView。

## 真机验收

```powershell
pnpm test-mode
```

流程：构建 DLL → `LULL_WALLPAPER=1 pnpm tauri dev` → 等 `attach rc=0` → 层序 + 命中双视角 +
动画差分 → 关闭 → 等待桌面还原。需要 Python 3.10+ 与 Pillow，或有 `uv` 时自动准备临时环境。

手动检查清单：`Win+D` 看壁纸；桌面右键菜单、图标拖拽与任务栏正常；改分辨率 / 缩放 / 主屏后自动重建；
单屏关闭再打开；退出应用后桌面层级恢复。

## 已知风险

- Windows 桌面宿主不是公开稳定 API，Explorer 版本、任务栏设置、混合 DPI 都可能改变行为。
- 非管理员启动时部分窗口消息会被 UIPI 拦截，时序与管理员模式不同。
- 多屏 + 混合缩放最容易出问题，必须真机验收；不要用纯单元测试替代 `pnpm test-mode`。

## 改名前先读这一节

再次修改 DLL 名或导出前缀，必须同步：`build-shim.sh` 输出名、`lull_native_shim.cpp` 的导出名、
`wallpaper/ffi.rs` 的 `DLL_NAME` 与 `get(b"...")`、`tauri.conf.json` 的 `bundle.resources`、
`prebuild.mjs` / `test-mode.ps1` 的路径、验收脚本的进程名，以及文档、日志路径与 CI。
只改目录名而漏掉兼容路径，release 版会在无控制台环境下静默失败。

完整 ABI 表、错误码与挂载细节见仓库
[原生桌面宿主](https://github.com/Lull-Desktop/Lull/blob/main/docs/native-host.md)。
