//! Game Runtime 门面：模块装配、初始化、退出与窗口销毁钩子。
//!
//! 命令在 `api`，实例编排在 `lifecycle`，全局状态在 `manager`；本文件只做接线。

pub mod api;
pub mod authority;
pub mod config;
pub mod error;
pub mod instance;
pub mod journal;
pub mod lease;
pub mod lifecycle;
pub mod manager;
pub mod permissions;
pub mod protocol;
pub mod repository;
pub mod state;

use std::time::Duration;

use tauri::AppHandle;

/// 启动时调用：标记残留运行态、按偏好恢复实例、拉起 ticker。
pub fn init(app: &AppHandle) {
  // 必须在 mark_interrupted 之前取：它会把残留状态改成 interrupted。
  let resume_ids = if config::resume_on_launch(app) {
    repository::active_game_ids(app)
  } else {
    Vec::new()
  };
  repository::mark_interrupted(app);
  manager::spawn_ticker(app.clone());
  if !resume_ids.is_empty() {
    resume_instances(app.clone(), resume_ids);
  }
}

/// 恢复上次活动实例：逐个启动，单个失败不影响其余。启动是阻塞操作，
/// 放在后台线程，避免拖住 setup / 主线程。
fn resume_instances(app: AppHandle, game_ids: Vec<String>) {
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(1500));
    for game_id in game_ids {
      if !crate::game_package::store::is_enabled(&app, &game_id) {
        continue;
      }
      let _ = lifecycle::start(&app, &game_id);
      std::thread::sleep(Duration::from_millis(300));
    }
  });
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
