//! Lull Media 平台根模块。
//!
//! - `video`：既有视频壁纸媒体运行时（Session/Surface、`media_pp`、素材库）。
//! - `api`：统一 Media API 命令、DTO、协议与错误码。
//! - `library`：音乐资料库（SQLite、扫描、曲目/艺术家/专辑读取）。
//! - `repository`：SQLx 仓储层与数据库迁移。
//!
//! 后续播放服务、音频引擎与权限模块在这里按阶段加入；不要把音乐服务塞进
//! `video`，也不要让 `video` 依赖音乐模块。

pub(crate) mod api;
pub(crate) mod library;
pub(crate) mod repository;
pub(crate) mod video;

/// 应用启动：初始化视频壁纸运行时与音乐资料库。
pub fn init(app: tauri::AppHandle) {
  video::init(app.clone());
  library::init(app);
}

/// 应用退出：关闭数据库连接池；视频运行时沿用原有关闭顺序。
pub fn shutdown() {
  library::shutdown();
  video::shutdown();
}
