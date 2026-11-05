//! Game Runtime 门面：模块装配、初始化、退出与窗口销毁钩子。
//!
//! 命令在 `api`，实例编排在 `lifecycle`，全局状态在 `manager`；本文件只做接线。

pub mod api;
pub mod authority;
pub mod config;
pub mod error;
pub mod instance;
pub mod lease;
pub mod lifecycle;
pub mod manager;
pub mod permissions;
pub mod protocol;
pub mod repository;
pub mod state;

use tauri::AppHandle;

/// 启动时调用：标记残留运行态、拉起 ticker。
pub fn init(app: &AppHandle) {
  repository::mark_interrupted(app);
  manager::spawn_ticker(app.clone());
}

/// 退出时调用：有界落盘。
pub fn shutdown(app: &AppHandle) {
  manager::shutdown(app);
}

/// 窗口销毁：移除参与者、权威窗触发 failover 或停止收尾。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
  manager::on_window_destroyed(app, label);
}

/// 扩展中心/安装器使用：实例是否占用运行名额。
#[must_use]
pub fn instance_active(game_id: &str) -> bool {
  manager::manager()
    .instances
    .get(game_id)
    .is_some_and(|instance| instance.status.is_active())
}

/// 供壁纸窗注入的顶层帧 token（壁纸窗创建时调用）。
pub fn issue_wallpaper_token(label: &str) -> String {
  permissions::issue_window_token(label)
}
