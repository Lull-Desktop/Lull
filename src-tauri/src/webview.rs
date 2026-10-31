//! 所有 WebView 共享的 Chromium 启动参数。
//!
//! 音乐引擎是隐藏窗口：自动播放策略与后台定时器节流必须显式关闭，否则
//! `AudioContext.resume()` 或氛围声调度会在窗口隐藏后停住。WebView2 对同一
//! user-data-dir 的 environment options 很敏感，所有窗口必须使用同一份参数，
//! 否则后建的设置/工具窗可能返回 `0x8007139F`。
//!
//! `native-media` 额外开启 WebView2 TextureStream；默认构建不启用，避免普通
//! 用户/CI 被 FFmpeg 依赖卡住。

#[cfg(not(feature = "native-media"))]
const BASE: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding";

#[cfg(feature = "native-media")]
const ARGS: &str = concat!(
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
   --autoplay-policy=no-user-gesture-required \
   --disable-background-timer-throttling \
   --disable-backgrounding-occluded-windows \
   --disable-renderer-backgrounding \
   --enable-features=msWebView2TextureStream"
);

#[cfg(not(feature = "native-media"))]
const ARGS: &str = BASE;

#[must_use]
pub fn browser_args() -> &'static str {
  ARGS
}
