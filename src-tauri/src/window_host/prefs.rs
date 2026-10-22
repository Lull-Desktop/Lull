//! 全局窗口偏好：所有 Lull 窗口共用「是否显示在任务栏 + 是否允许最小化」。
//!
//! 持久化到 app config 目录的 `window-prefs.json`，修改后立即套用到已打开的所有窗口；
//! 新建窗口在 `window_host::open` 里读取同一份偏好。

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use super::{is_managed, DYNAMIC_WINDOW_PREFIX};

const FILE_NAME: &str = "window-prefs.json";

/// 前端顶栏监听该事件，重新读取 isMinimizable 决定是否渲染最小化按钮。
pub const CHANGED_EVENT: &str = "window-prefs-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPrefs {
  /// true = 所有窗口显示在任务栏且允许最小化；false = 都不显示、不允许最小化。
  pub taskbar_and_minimize: bool,
}

impl Default for WindowPrefs {
  fn default() -> Self {
    // 桌面应用的常规行为：进任务栏、可最小化。用户可在设置里关掉。
    Self {
      taskbar_and_minimize: true,
    }
  }
}

fn path(app: &AppHandle) -> PathBuf {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join(FILE_NAME))
    .unwrap_or_else(|_| PathBuf::from(FILE_NAME))
}

/// 读取偏好；文件缺失 / 损坏 → 默认值（首启不应是错误）。
pub fn load(app: &AppHandle) -> WindowPrefs {
  std::fs::read_to_string(path(app))
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

fn save(app: &AppHandle, prefs: WindowPrefs) -> Result<(), String> {
  let path = path(app);
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_string_pretty(&prefs).map_err(|error| error.to_string())?;
  std::fs::write(path, json).map_err(|error| error.to_string())
}

/// 把偏好套用到所有已打开的应用窗口，并广播给前端顶栏。
fn apply(app: &AppHandle, prefs: WindowPrefs) {
  let on = prefs.taskbar_and_minimize;
  for (label, window) in app.webview_windows() {
    if !is_managed(&label) && !label.starts_with(DYNAMIC_WINDOW_PREFIX) {
      continue;
    }
    let _ = window.set_minimizable(on);
    let _ = window.set_skip_taskbar(!on);
  }
  let _ = app.emit(CHANGED_EVENT, prefs);
}

#[tauri::command]
pub fn window_prefs_get(app: AppHandle) -> WindowPrefs {
  load(&app)
}

#[tauri::command]
pub fn window_prefs_set(app: AppHandle, taskbar_and_minimize: bool) -> Result<WindowPrefs, String> {
  let prefs = WindowPrefs {
    taskbar_and_minimize,
  };
  save(&app, prefs)?;
  apply(&app, prefs);
  Ok(prefs)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_is_taskbar_and_minimize_on() {
    assert!(WindowPrefs::default().taskbar_and_minimize);
  }

  #[test]
  fn serde_roundtrip_uses_camel_case() {
    let json = serde_json::to_string(&WindowPrefs {
      taskbar_and_minimize: false,
    })
    .unwrap();
    assert_eq!(json, r#"{"taskbarAndMinimize":false}"#);
    let parsed: WindowPrefs = serde_json::from_str(&json).unwrap();
    assert!(!parsed.taskbar_and_minimize);
  }

  #[test]
  fn corrupt_or_missing_prefs_fall_back_to_default() {
    // load() 依赖 AppHandle 取目录，这里只验证反序列化回退策略本身。
    let parsed: Option<WindowPrefs> = serde_json::from_str("not json").ok();
    assert_eq!(parsed.unwrap_or_default(), WindowPrefs::default());
  }
}
