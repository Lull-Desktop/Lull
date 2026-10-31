//! Lull Media 平台根模块。
//!
//! - `video`：既有视频壁纸媒体运行时（Session/Surface、`media_pp`、素材库）。
//! - `api`：统一 Media API 命令、DTO、协议与错误码。
//! - `library`：音乐资料库（SQLite、扫描、曲目/艺术家/专辑读取）。
//! - `playback`：播放/队列/白噪音状态与隐藏音频引擎协议。
//! - `repository`：SQLx 仓储层与数据库迁移。
//!
//! 歌单/喜欢/历史/标签与第三方媒体权限按阶段加入；不要把音乐服务塞进
//! `video`，也不要让 `video` 依赖音乐模块。

pub(crate) mod api;
pub(crate) mod library;
pub(crate) mod playback;
pub(crate) mod repository;
pub(crate) mod video;

/// 应用启动：初始化视频壁纸运行时与音乐资料库。
pub fn init(app: tauri::AppHandle) {
  video::init(app.clone());
  library::init(app);
}

/// 应用退出：尽量保存播放状态，再关闭数据库连接池与视频运行时。
pub fn shutdown() {
  playback::shutdown();
  library::shutdown();
  video::shutdown();
}
