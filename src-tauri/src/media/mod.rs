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

/// 视频场景 id；生命周期用它判断“是否仍在视频模式”。
pub(crate) const VIDEO_SCENE: &str = "lull.video";

/// 启动媒体运行时。纯内存初始化；依赖/后端的失败不得阻断应用启动。
pub fn init() {
  let _ = engine();
}

/// 应用退出：停止所有会话、清空 token。
pub fn shutdown() {
  lifecycle::shutdown();
}
