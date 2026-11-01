//! Lull Media 平台根模块。
//!
//! - `video`：既有视频壁纸媒体运行时（Session/Surface、`media_pp`、素材库）。
//! - `api`：统一 Media API 命令、DTO、协议、快照与错误码。
//! - `engine`：隐藏 `media-engine` WebView 的命令/事件边界。
//! - `events`：`media:event` 订阅总线。
//! - `library`：音乐资料库（SQLite、扫描、曲目/艺术家/专辑读取）。
//! - `noise`：Noise 业务域（Asset/Track/Session/Preset；N2 先做内置 procedural）。
//! - `output`：Music + Noise 共享的全局输出音量。
//! - `playback`：音乐播放/队列与隐藏音频引擎协议。
//! - `repository`：SQLx 仓储层与数据库迁移。
//!
//! 歌单/喜欢/历史/标签与第三方媒体权限按阶段加入；不要把音乐服务塞进
//! `video`，也不要让 `video` 依赖音乐模块。

pub(crate) mod api;
pub(crate) mod engine;
pub(crate) mod events;
pub(crate) mod library;
pub(crate) mod noise;
pub(crate) mod output;
pub(crate) mod playback;
pub(crate) mod repository;
pub(crate) mod video;

/// 应用启动：初始化视频壁纸运行时与音乐资料库。
pub fn init(app: tauri::AppHandle) {
  video::init(app.clone());
  library::init(app);
}

/// 窗口销毁：先移除事件订阅；引擎窗口丢失时由 playback/noise 降级状态。
pub fn on_window_destroyed(app: &tauri::AppHandle, label: &str) {
  events::remove(label);
  playback::on_window_destroyed(app, label);
  if label == engine::ENGINE_LABEL {
    noise::on_engine_lost(app);
  }
}

/// 应用退出：先让引擎停止发声，再保存播放/Noise 偏好并关闭资料库/视频运行时。
pub fn shutdown(app: &tauri::AppHandle) {
  engine::send(app, engine::shutdown());
  if let Ok(pool) = library::pool() {
    let pool = pool.clone();
    let _ = tauri::async_runtime::block_on(output::persist(&pool));
  }
  noise::shutdown();
  playback::shutdown();
  library::shutdown();
  video::shutdown();
}
