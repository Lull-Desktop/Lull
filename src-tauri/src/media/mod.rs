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

/// 原生媒体依赖 WebView2 的 `msWebView2TextureStream` 实验特性。
///
/// WebView2 对同一 user-data-dir 的 environment options 很敏感：不同窗口如果
/// 使用不同的 AdditionalBrowserArguments，后建的窗口可能返回
/// `0x8007139F`。因此所有 Tauri WebView 窗口（壁纸、设置、工具）必须用同一份
/// 参数；`additional_browser_args` 会替换 wry 默认值，这里显式带回默认禁用项。
#[cfg(feature = "native-media")]
pub(crate) const NATIVE_MEDIA_BROWSER_ARGS: &str =
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
   --enable-features=msWebView2TextureStream";

/// 启动媒体运行时。纯内存初始化；依赖/后端的失败不得阻断应用启动。
pub fn init() {
  let _ = engine();
}

/// 应用退出：停止所有会话、清空 token。
pub fn shutdown() {
  lifecycle::shutdown();
}
