# Lull Media Runtime

> 状态（本次提交）：默认构建仍交付 **HTML `<video>` 回退**；启用
> `--features native-media` 且 WebView2 运行时支持 `msWebView2TextureStream`
> 时，原生共享解码路径可用。本轮已在双 4K 显示器上验证两屏原生 attach 与首帧。
> 本文记录会话/素材/配置/安全边界、原生后端契约，以及这次定位到的两个运行时门。

## 1. 为什么会话不是“每个显示器一个”

Lull 的媒体模型是：

```text
一个视频资源 + 播放参数 = 一个 MediaSession
一个 MediaSession = 0..N 个 Surface（每个壁纸 WebView 一个）
```

- mirror / span：同一场景、同一资源，默认共享一个 Session；
- independent：默认每个显示器独立 Session（允许不同相位/seek）；
- `display.media.share = "shared"` 时 independent 也共享一个 Session；
- 共享不改变“每个 WebView 各自有一块输出纹理”的事实；原生路径是**一次解码、
  每屏一次 GPU 复制**，不是把解码 Surface 直接交给多个 WebView。

`SessionKey` 由 `sceneId + assetId + loop + rate + hardwareDecode + 共享分组`
决定，显示器数量不进入 key。实现见 `src-tauri/src/media/engine.rs`。

## 2. 当前路径

```text
MediaSurface (src/scenes/media-surface.tsx)
  → media_config_get / media_open / media_attach
  → Rust media engine
      ├─ 原生可用：NativeSession（media-pp 一次解码）
      │    → Tee → 每屏 Queue(DropNewest)
      │    → D3d11Renderer → C++ WebView2 TextureStream
      └─ 原生不可用：HTML <video src="http://asset.localhost/...">
```

- Rust 侧维护 Session/Surface 注册表、素材库、配置、诊断与生命周期；
- 原生路径的 `media_attach` 先在 `with_webview` 里探测 Environment12 与
  `RenderAdapterLUID`，再按该 LUID 创建 D3D11 Device；任一步失败都返回 HTML 结果，
  不会把失败伪装成原生成功；
- 文件通过 Tauri asset protocol 提供，支持 Range，不把视频读进内存；
- 前端永远拿不到任意路径；`media.json` 只登记文件对话框选中的绝对路径；
- 壁纸顶层页面由 Rust 注入 per-window token，外部 sandbox iframe 不能读取父 DOM，
  因而不能调用媒体命令；
- 隐藏全部壁纸时暂停原生管线或 HTML video；显示时恢复（`media-master-visible`）。

### 2.1 配置

`display.json` 的可选 `display.media`：

```json
{
  "assetId": "m_7f3a...",
  "loop": true,
  "muted": true,
  "rate": 1.0,
  "fit": "cover",
  "position": "center",
  "preferredFps": 30,
  "hardwareDecode": "auto",
  "share": "auto"
}
```

默认配置不写盘，旧配置无需迁移；非法字段单字段归一化，不整文件回退。

### 2.2 素材库

`%APPDATA%\app.lull.desktop\media.json`：

```json
{
  "version": 1,
  "assets": [
    {
      "id": "m_7f3a...",
      "path": "D:\\Videos\\night.mp4",
      "name": "night.mp4",
      "kind": "video",
      "sizeBytes": 12345678,
      "addedAt": 0
    }
  ]
}
```

不复制素材；文件移动/删除后前端显示“需要重新选择”。`kind` 由扩展名判定：

- 图片：`png/jpg/jpeg/gif/webp/avif/bmp`，直接 `<img src=assetUrl>`，**不创建 MediaSession**；
- 视频：`mp4/m4v/webm/mov`，走原生或 HTML 播放。

旧库没有 `kind` 时按 `path` 扩展名补算，不提升 `MEDIA_STORE_VERSION`，避免整库回退空库。

### 2.3 安全边界

| 入口 | 规则 |
| --- | --- |
| `media_asset_pick` / `media_config_set` / `media_activate` | 只允许 `settings` 窗口 |
| `media_open` / `media_attach` / `media_detach` / `media_degrade` | 壁纸窗口必须带顶层帧 token，且 `origin` 在白名单 |
| 外部脚本 iframe | 运行在 opaque-origin sandbox；拿不到父页面 token；不新增媒体 ACL |
| `media.json` 路径 | 只来自 Rust 文件对话框；JS 只传 assetId |
| asset protocol | 动态 `allow_file`，只开放已登记文件；不是目录级暴露 |

## 3. 生命周期

| 事件 | 行为 |
| --- | --- |
| 新显示器/新壁纸窗口 | JS 挂载 `MediaSurface` → `media_open` → `media_attach` |
| 单屏关闭 / 窗口销毁 | `remove_window(label)`：清 token、解绑 Surface；**Session 保留** |
| Explorer 重启 / 拓扑重建 | `on_topology_rebuild()`：只解绑 Surface；新窗口重新 attach，不重开解码 |
| 全局隐藏壁纸 | Session 置 Paused；原生 `pipeline.pause()`；HTML video 暂停 |
| 全局显示 | Session 恢复；原生 `pipeline.resume()`；HTML video 重新播放 |
| 切到非视频场景（全局或单屏） | `retain_video_devices(video_devices)`：只保留仍有 surface 落在视频显示器上的 Session；切走的屏幕停 native pipeline、释放 TextureStream/解码器，HTML `<video>` 在组件卸载 + `pagehide` 中清 `src`/轨道 |
| 仍留在视频的其它屏幕 | 不重建 Session/解码器；independent 模式互不误停 |
| 显示模式/同步变化 | `on_display_layout_changed()` 全停并按新共享分组重建 |
| 场景参数变化（仍在视频） | Session 保留，不因无关参数触发重新解码 |
| 页面重载 | `on_page_loaded(label)` 清旧 Surface；新页面重新 attach |
| 应用退出 | `media::shutdown()` → 停 Session、清 token |

`Display Detach` 不等于 `Session Destroy`；但**切到非视频场景等于释放**。这是为了避免离开视频后仍持有解码线程/纹理流/HTML 解码器。

> **场景解析必须与 `monitor_url` 同源**：判断“这块屏还在不在视频场景”要用
> `WallpaperConfig::effective_scene`——只有 independent 模式消费每屏覆盖，
> mirror / span 一律用全局场景。2026-10-31 修复的“关一屏、另一屏黑屏”就是
> 这里用了 `resolved_scene`：mirror 下 DISPLAY1 残留了 `lull.aurora` 覆盖，
> 关掉 DISPLAY2 后它被判成非视频屏，正在放视频的共享 Session 被整条回收；
> 另一屏随后由 5 秒 rVFC 看门狗重新 attach（新解码器），表现为不可预测的黑屏。

### 3.1 HTML 回退的相位对齐

HTML 回退由每个壁纸窗独立解码，因此需要场景层同步：

- 目标相位 = `(Date.now()/1000 × rate) % duration`，所有壁纸窗共享同一墙钟；
- `loadedmetadata` 后按 0.5s 容差 seek 一次，再 `play()`；
- 恢复可见时按 2s 容差重新对齐；
- 每 60s 做一次“偏差 > 2s 才纠正”的兜底，正常播放不触发；
- `loop=false` 或图片素材不参与相位对齐；
- 原生 `srcObject` 是实时流，**不 seek**；原生时间轴由共享 Session/PTS 负责。

实现见 `src/core/media/phase.ts` 与 `src/scenes/media-surface.tsx`。

## 4. 原生后端实现

### 4.1 依赖与构建

```toml
[target.'cfg(windows)'.dependencies]
media-pp = { version = "=0.4.1", features = ["d3d11"], optional = true }

[features]
native-media = ["dep:media-pp"]
```

- 默认构建（`cargo build`）不编译 `media-pp`，不需要 FFmpeg/libclang，安装包仍走
  HTML 回退；原生预览必须显式 `--features native-media`；
- `media-pp` 0.4.1，Rust 1.88+，edition 2024；**不要**同时引入 `Player`；
- FFmpeg **8.0.1**（精确 8.0.x；8.1 头文件会被 media-pp 拒绝）；需要
  `LIBCLANG_PATH` 指向 `libclang.dll`；
- `d3d11` feature 会启用 `windows`/`raw-window-handle`；没有启用
  `wasapi-renderer`（首版视频静音）；
- FFmpeg DLL 必须与 `lull.exe` 同目录（Windows 在进程启动时解析导入表）；
- `lull_native.dll` 由 `src-tauri/native/build-shim.sh` 构建；需要 MSVC
  `cl.exe`、`rc.exe`（Windows SDK）和 Git Bash。构建前设置
  `LULL_MSVC_ROOT`（可选）与 `FFMPEG_DIR`/`LIBCLANG_PATH`。

最小构建命令（在 `src-tauri` 下）：

```powershell
$env:FFMPEG_DIR = "C:\deps\ffmpeg-8.0.1-shared"
$env:LIBCLANG_PATH = "C:\deps\libclang\native"
$env:PATH = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64;$env:FFMPEG_DIR\bin;$env:PATH"
cargo build --bin lull --features native-media
Copy-Item "$env:FFMPEG_DIR\bin\*.dll" target\debug\ -Force
```

### 4.2 管线

```text
FileDemuxer
  → VideoDecodeBin(DecodeTarget::D3d11 { gpu, downstream_hw_frames: 16 })
  → Queue("decode", 8, Block(500ms))
  → Pacer
  → Tee (TeeBuilder::build_dynamic → TeeHandle)
       ├─ Queue("display:<label>", 2, DropNewest) → D3d11Renderer(WebView A)
       └─ Queue("display:<label>", 2, DropNewest) → D3d11Renderer(WebView B)
```

- 第一个 Surface 创建 `NativeSession`：`FileDemuxer`、`VideoDecodeBin`、`Pacer`、
  `Tee` 只建一次；后续 Surface 通过 `TeeHandle::branch()` + `attach()` 动态挂分支；
- 每个显示分支第一个元素是 `Queue(DropNewest)`，慢屏只丢自己的帧；
- 原生首版只接受 NV12；`VideoDecodeBin::output_format()!=NV12` 时返回错误并回退
  HTML；
- `D3d11Renderer` + `D3d11FrameRenderer` 是 media-pp 支持的终端；`submit_nv12_texture`
  同步调用 C++ 桥，复制完成才返回，不在 Rust 里重复实现 D3D11VA 纹理提取；
- **当前未实现** `FrameThrottle`：原生分支暂不按 `preferredFps` 丢帧，由 Pacer
  控制节奏；这是原生路径恢复前要补的项，不能在文档里宣称已生效；
- 关闭最后一个 Surface 时 `pipeline.pause()`，但 `NativeSession`/解码器不销毁；
  detach 后重新 attach 只加分支，不重开解码器。

### 4.3 呈现时间戳

TextureStream 的 `put_Timestamp` 要求严格递增，而 seek/loop 后媒体 PTS 会回退。
因此每个 `WebViewStreamRenderer` 单独维护 `last_timestamp`，每次取
`max(last+1, elapsed_micros)`；**不把媒体 PTS 直接写进 `put_Timestamp`**。
媒体时间轴仍由 `Pacer`/`pipeline.position()` 提供。

### 4.4 D3D11 / WebView2 所有权

- 先 `probe` 得到 WebView2 `RenderAdapterLUID`，再在 `NativeContext::for_luid`
  中用 `CreateDXGIFactory1` 枚举同名适配器并 `D3D11CreateDevice`
  （`BGRA_SUPPORT | VIDEO_SUPPORT`）；
- `D3d11Gpu::from_device` 交给 media-pp；同一 LUID 的 Session 复用缓存的 Context；
- C++ 只消费同一个 Device，负责 TextureStream、每 WebView 目标纹理池、复制、Present；
- 不在 FFI 传 `AVFrame*`/`ComPtr`；stream 用 u64 handle，target texture 由 WebView2
  的 `GetAvailableTexture` 池管理；
- 解码源纹理只在 `D3d11FrameRenderer::submit_*` 调用期间借用；C++ 同步
  `CopySubresourceRegion` 后返回，不长期持有源帧。因此**不需要** `MediaFrameRef`
  注册表或跨显示器的帧生命周期协议。

实现落点：

- `src-tauri/src/media/backends/media_pp.rs`：`NativeContext`、`NativeSession`、
  `WebViewStreamRenderer`；
- `src-tauri/src/media/native_bridge.rs`：DLL 加载、`NativeStream` RAII、FFI；
- `src-tauri/native/lull_media/media_bridge.cpp`：WebView2 流/纹理池/复制/Present；
- `src-tauri/native/lull_media/webview2_texture_stream.h`：从
  `Microsoft.Web.WebView2 1.0.4312-prerelease` 提取的最小接口头文件。

### 4.5 C ABI（已实现）

```c
typedef uint64_t lull_media_stream_t;

struct lull_media_probe_result {
  uint32_t abi_version;
  uint32_t flags;          /* bit0 Environment12, bit1 adapter LUID */
  uint64_t adapter_luid;
};

int  lull_media_probe(void* environment, struct lull_media_probe_result* out);
lull_media_stream_t lull_media_stream_create(
    void* environment, void* d3d_device,
    const wchar_t* stream_id, const wchar_t* origin,
    int* out_hresult);
int  lull_media_stream_state(lull_media_stream_t s);
int  lull_media_stream_take_error(lull_media_stream_t s, int* code);
int  lull_media_stream_submit_nv12(
    lull_media_stream_t s, void* texture, uint32_t array_index,
    uint32_t width, uint32_t height, uint64_t timestamp_us);
void lull_media_stream_stop(lull_media_stream_t s);
void lull_media_stream_destroy(lull_media_stream_t s);
```

编入现有 `lull_native.dll`；构建脚本追加 `d3d11.lib dxgi.lib ole32.lib`。
WebView2 预发布接口只从固定版 SDK 提取最小头文件，不手写猜测 IID。

### 4.6 WebView2 TextureStream 的限制与实测

- `ICoreWebView2ExperimentalEnvironment12` / TextureStream 仍是预发布实验接口；
- **必须打开 `msWebView2TextureStream` 浏览器特性**。Tauri 壁纸窗在
  `--features native-media` 下通过 `additional_browser_args` 传入：
  `--enable-features=msWebView2TextureStream`；未打开时 `CreateTextureStream`
  返回 `0x80070032`（`ERROR_NOT_SUPPORTED`）。该参数必须在 WebView2 启动前设置，
  见 `src-tauri/src/media/mod.rs` 的 `NATIVE_MEDIA_BROWSER_ARGS`；
- **同一进程内所有 WebView2 窗口必须使用同一份 AdditionalBrowserArguments**。
  壁纸窗带实验特性、设置/工具窗使用默认参数时，后建窗口会返回
  `0x8007139F`（组或资源状态不正确），表现为“设置面板无法弹出”。因此
  `window_host` 与 `widget_package` 的 builder 也统一应用同一常量；
- **TextureStream 是 WebView2 STA 对象，只能在创建它的 UI 线程调用**。
  media-pp 的 `submit_nv12` 在解码线程触发；C++ 桥通过 message-only window 把
  `GetAvailableTexture/CreateTexture/CopySubresourceRegion/PutTimestamp/PresentTexture`
  marshal 回 UI 线程，解码线程等待复制完成。直接跨线程调用会在
  `EmbeddedBrowserWebView.dll` 触发 `0x80000003`（STATUS_BREAKPOINT）；
- **WebView2 返回的目标纹理带 keyed mutex**（`MiscFlags=0x900`）。复制前必须
  `IDXGIKeyedMutex::AcquireSync(0, timeout)`，复制后 `ReleaseSync(0)`；否则
  `CopySubresourceRegion` 会静默写不进去，画面表现为全黑/绿屏；
- keyed mutex 只保证互斥，不保证 GPU 复制已落地。新 Stream / 新目标纹理的
  前 4 帧在 `ReleaseSync` 前 `Flush()`，避免显示器重新打开时浏览器先采样到
  未写完的 NV12（UV=0 → 偶发绿屏闪烁）；
- **显示器全关会销毁全部壁纸窗**：`wallpaper_set_monitor_visible` 成功后要按
  新 `video_devices` 回收 Session；拓扑重建同理。只 detach 并保留 pause 的
  Session，重新打开时可能 resume 不出帧（independent 双屏全关再开黑屏）；
- 全屏关闭后进程不能被 last-window-close 自动退出：`RunEvent::ExitRequested`
  且 `code=None` 时 `prevent_exit()`；托盘 `app.exit(0)` 带 `Some(0)`，仍可退出；
- 无法启动的 TextureStream 先 retire 到进程退出；重新打开显示器时，前端对
  首帧失败做一次重新 attach + 取流再降级，避免一次竞态就永久回退 HTML；
- 首帧之后仍用 `requestVideoFrameCallback` 做健康检查：超过 5 秒没有新呈现帧
  就重挂一次，连续两次无帧才降级 HTML；浏览器不支持 rVFC 时不启用该检查；
- **流离开 `Started` 后不会再自己出帧**：浏览器触发 `Stopped`、渲染侧报错或
  适配器丢失之后，`PresentTexture` 一律失败，C++ 桥此前把每一帧都返回成
  “已丢弃”，Rust 当成成功，只能等 5 秒 rVFC 看门狗重挂。现在分原因返回并
  由 Rust 立刻发 `media-stream-stalled`，见 4.8；
- 未 `StartRequested` 前释放 TextureStream 也会触发同一断言；页面
  StrictMode/重载产生的旧 detach 以 stream id 校验，不能误删新 Surface；
- 本轮实测（2026-10-31）：
  - OS：Windows 10 Enterprise 26H2，build `26300.9711`；
  - WebView2 Runtime：`156.0.4314.50`；
  - 双 4K（3840×2160）mirror：两屏原生 attach 成功，均打印
    `native first frame ... 3840x2160`；手动桌面截屏可见视频画面；
  - independent 双屏全关再开：旧 Session 被回收，新窗口重新 attach；
    实测两屏都在重开后收到新 stream 首帧，截屏均有画面（第二次 attach
    成功前会先走一次短重试，日志可见两个 stream id）；
  - 显示器重新打开时偶发绿屏：前 4 帧在释放 keyed mutex 前 `Flush()`；
    实测重开截屏无绿帧；
  - `check_desktop.py verify` 会先 `show_desktop`，壁纸窗被隐藏/遮挡，
    其像素差分不适用于 native TextureStream，需用 `-SkipVerify` 看 attach 日志；
- 已知只接受 NV12；HDR/10-bit/alpha/奇数尺寸首版回退；
- `StartRequested` 后 10 秒内必须 `PresentTexture`，前端另设 12 秒首帧看门狗；
- `RenderAdapterLUIDChanged`/设备丢失：标记该 Surface 回退，不在原地硬恢复；
- 物理扫描同步不保证，只保证同一媒体时间轴与同一帧 PTS。

### 4.7 手动重新同步播放

设置页「媒体壁纸」底部提供 **重新同步播放** 按钮：

- 前端调用 `media_resync(positionMs = 0)`；
- Rust 对所有原生 Session 调 `seek(0)`，主开关可见时恢复播放；
- 再广播 `media-resync` 事件，HTML 壁纸页把 `<video>` seek 到同一点并 play；
- 返回被同步的会话数，设置页显示“已重新同步 N 个会话”。

这样不区分 mirror / independent / 共享 / 独立解码，所有显示器都从同一起点重新开始；
原生流本身不能由 JS seek，所以原生路径以 Rust 端 seek 为准。

### 4.8 流生命周期与自愈

多屏“共享”的只有解码器与 D3D11 设备，**不是一块跨窗口的渲染目标**：

```text
一次解码 → Tee → 每屏一条分支 → 每屏自己的 D3D11Renderer
        → 每屏自己的 WebView2 TextureStream（浏览器持有纹理池）
```

宿主只往浏览器给的目标纹理里写，`keyed mutex` 负责互斥、`put_Timestamp` 负责
顺序。它没有“两个窗口内容必须一致才能共享”的约束：independent 模式下两屏本就
可以播不同相位，各自出帧互不影响。所以“双方播放内容不同步导致无法共享”不是
黑屏的成因。

真正的黑屏来自流的**终态**——浏览器停止（`Stopped`）、渲染侧
`ErrorReceived`、适配器丢失之后，TextureStream 不会自己回到 `Started`，之后
每次提交都不再产生画面。此前 C++ 把这些帧统一返回 `1`，Rust 记一个 `dropped`
就继续，壁纸页只能靠 5 秒一轮的 rVFC 看门狗发现“很久没有新帧”，恢复时间因此
不可预测。当前实现：

- `lull_media_stream_stats` 暴露 `state` / `presented` / `dropped_not_started` /
  `dropped_no_texture` / `created_textures` / 瞬时错误数，Rust 侧用于判活；
- `submit_nv12` 区分返回码：`0` 呈现、`1` 流未启动、`2` 本轮没有可写目标；
- Rust 在“已经出过帧、现在连续丢帧且 state 是 stopped / error / adapter-lost”
  时立刻发 `media-stream-stalled`，壁纸页收到即走同一套重挂流程（新 stream id
  并重新 `getTextureStream`），连续两次救不回来才降级 HTML；
- 目标纹理由 `GetAvailableTexture` 复用；只有池未满时才 `CreateTexture`，
  上限 8 张（4K NV12 约 12.4 MiB/张）。此前池满时每帧新建一张，窗口被遮挡或
  首帧门期间会把显存堆到不可预测的量级，表现为卡顿、掉帧乃至设备丢失；
- `ErrorReceived` 按 kind 区分：`BUFFER_NOT_FOUND` / `BUFFER_IN_USE` 是渲染队列
  的瞬时状态，只计数不杀流；只有真正的流错误才进入 `Error`；
- 暂停/恢复不会把暂停时长算成“渲染侧不消费”：持续 3 秒没有可用目标纹理才
  判定渲染侧停摆。

本地真机验证（2026-10-31，双屏 4K）：连续播放 150 秒、约 9000 帧呈现、丢帧 1 次；
关闭壁纸窗口时浏览器触发 `Stopped`，Rust 在下一帧即记录并上报（前端已卸载，
不会重挂）。日志形如：

```text
media: native stream stats stream=... abi=1 state=2 textures=0 created=4 transient=0 ...
media: native stream stalled stream=... session=media-... label=wallpaper-0 reason=stopped state=2 presented=9022 dropped=1
```

## 5. 验收

### 5.1 已通过

- 默认 `cargo check --lib` / `cargo test --lib` 不依赖 FFmpeg；
- `cargo check --lib --features native-media`、`cargo clippy --all-targets
  --features native-media`、`cargo build --bin lull --features native-media`
  在 FFmpeg 8.0.1 + libclang 18.1.1 环境下通过；
- `lull_native.dll` 导出 `lull_media_probe` / `lull_media_stream_create` /
  `lull_media_stream_submit_nv12` 等符号；
- 原生解码 smoke test（GPU + FFmpeg DLL + 样例文件）：
  `cargo test --features native-media --test media_native_smoke -- --ignored`；
  本轮 `decodes_a_file_to_d3d11_frames` 与 `tee_attaches_first_branch_before_run`
  各解码 44 帧，验证了“Tee 在 `pipeline.run()` 之前挂首个显示分支”的实际路径；
- 真机验收模式已支持原生预览：
  `pnpm test-mode -NativeMedia` 会设置 FFmpeg/libclang、重建含 `lull_media_*` 的
  DLL、复制 FFmpeg DLL，并以 `tauri dev --features native-media` 启动；
  `-RequireNative` 会在没有成功原生 attach 时返回非 0。本轮双 4K mirror 已通过；
- 双屏实际启动：两个壁纸 WebView 都原生 attach 成功，两屏均收到首帧；
  应用持续运行、正常关闭，不再触发 `0x80000003`；
- HTML 路径：选择本地 MP4 → 壁纸播放；循环、fit/position、静音、重建后保留；
  关闭/显示全部壁纸暂停/恢复；关闭单屏不影响其它屏；文件缺失有提示。

### 5.2 原生路径验收（本轮已通过首帧门）

- G1：单屏原生首帧成功（已观察到 `native first frame ... 3840x2160`）；
  `media_stats.cpuReadbackBytes` 字段尚未接线，不能作为验收证据；
- G2：双屏 mirror 共享同一 Session/解码器，两个 Surface 均 attach 成功；
  逐 Surface `presented`/`dropped` 已由 `lull_media_stream_stats` 接线到
  `media_stats`（`dropped` = `dropped_not_started + dropped_no_texture`），
  150 秒连续播放实测约 9000 帧呈现、1 次丢弃；
- G3：4K/30 分钟 soak、多 GPU 不匹配屏自动 HTML、无界队列检查仍待执行。

原生路径的前置条件已经从“运行时拒绝”变为“运行时开启
`msWebView2TextureStream` 且调用发生在 WebView2 UI 线程”。任一条件不满足时，
`media_attach` 仍回退 HTML，不伪装成原生成功。

## 6. 已知边界

- 首版无音频；`muted` 恒为 true；
- 一个全局媒体源（图片或视频），无每屏独立素材；图片不创建 Session；
- 原生路径需要 `native-media` feature 且 WebView2 开启
  `msWebView2TextureStream`；默认构建/不支持该特性的运行时仍走 HTML；
- 原生 TextureStream 的调用必须 marshal 到 WebView2 UI 线程；
- 原生分支尚未实现 `FrameThrottle`，`preferredFps` 在原生路径暂不生效；
- 外部内容包视频未开放（包体积/摘要/透明 iframe/CSP 都需单独设计）；
- HTML 回退由每个 WebView 自行解码，不承诺单解码器；
- HTML 回退的同步是墙钟近似（起播/恢复 seek，60s 兜底），不保证逐帧对齐；
- 图片走 asset 协议的 `<img>`，需要 CSP `img-src` 放行 `asset:` /
  `http://asset.localhost`；
- 原生组件崩溃无法被 Rust 完全捕获；提供 `LULL_MEDIA_DISABLE=1` /
  `LULL_MEDIA_FORCE_FALLBACK=1` 安全开关；
- 素材只登记不复制，移动/删除后需重新选择；
- HTML 回退只登记浏览器可播放的容器（`mp4/m4v/webm/mov`）；`mkv/avi` 等要等原生
  路径在支持 TextureStream 的运行时上通过门禁。
