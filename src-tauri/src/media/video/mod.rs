//! Lull Media Runtime。
//!
//! 默认交付 HTML `<video>` 路径：本地素材库、`display.media` 配置、会话/呈现面
//! 注册表、壁纸生命周期接线与诊断。`native-media` feature 打开后，同一会话模型
//! 额外接入 media-pp/WebView2 TextureStream；能力探测或运行时失败时自动回退。
//! 接入与达标证据见 `docs/media-runtime.md`。

pub(crate) mod assets;
#[cfg(feature = "native-media")]
pub(crate) mod backends;
pub(crate) mod commands;
pub(crate) mod config;
mod diagnostics;
mod engine;
pub(crate) mod events;
pub(crate) mod lifecycle;
#[cfg(feature = "native-media")]
mod native_bridge;

use engine::engine;

/// 应用句柄：原生丢帧路径需要它把“流已死”告诉对应壁纸窗口。
#[cfg(feature = "native-media")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 视频场景 id；生命周期用它判断“是否仍在视频模式”。
pub(crate) const VIDEO_SCENE: &str = "lull.video";

/// 启动媒体运行时。纯内存初始化；依赖/后端的失败不得阻断应用启动。
pub fn init(app: tauri::AppHandle) {
  #[cfg(feature = "native-media")]
  {
    let _ = APP.set(app);
  }
  #[cfg(not(feature = "native-media"))]
  {
    // 没有原生后端就没有“流已死”可上报；保留参数形状，避免调用方分叉。
    let _ = app;
  }
  let _ = engine();
}

/// 原生流已经不可能再呈现新帧：通知该壁纸窗口重建纹理流。
///
/// 这是丢帧路径上的唯一逃生口。C++ 桥在流离开 `Started` 后每帧都返回
/// “dropped”，Rust 若把它当成功，就只能等壁纸页 5 秒的 rVFC 看门狗——
/// 画面黑多久完全取决于那 5 秒窗口落在哪一帧上，用户看到的就是“不可预测地
/// 过一会儿才恢复”。
#[cfg(feature = "native-media")]
pub(crate) fn report_stream_stalled(
  session_id: &str,
  label: &str,
  stream_id: &str,
  reason: &str,
  state: i32,
  presented: u64,
  dropped: u64,
) {
  crate::wallpaper::wlog(&format!(
    "media: native stream stalled stream={stream_id} session={session_id} \
     label={label} reason={reason} state={state} presented={presented} dropped={dropped}"
  ));
  let Some(app) = APP.get() else {
    return;
  };
  events::emit_stream_stalled(
    app,
    &diagnostics::MediaStreamStalledEvent {
      session_id: session_id.to_string(),
      stream_id: stream_id.to_string(),
      label: label.to_string(),
      reason: reason.to_string(),
      state,
      presented,
      dropped,
    },
  );
}

/// 应用退出：停止所有会话、清空 token。
pub fn shutdown() {
  lifecycle::shutdown();
}
