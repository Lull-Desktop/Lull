//! 用户内容包：发现、安装、卸载与 `lullcontent://` 资源服务。
//!
//! 与插件包（`widget_package`）的区别：
//! - 内容包只包含静态 HTML/CSS，运行在 `sandbox=""` 的 iframe 里，没有 JS 与 IPC；
//! - 不需要窗口、能力授权或状态 KV，只需要「装在哪、能不能加载、摘要是否对得上」；
//! - 目录扁平（`content/<id>/`），同时支持文件夹与 zip 两种安装源。

pub mod digest;
pub mod manifest;
mod protocol;
mod store;

pub use protocol::handle as handle_protocol;
pub use store::ContentPackageInfo;

use tauri::{AppHandle, Emitter};

/// 内容包增删后广播；设置页的场景下拉与内容包卡片据此刷新。
pub const CONTENT_CHANGED_EVENT: &str = "content-changed";

#[tauri::command]
#[must_use]
pub fn content_packages(app: AppHandle) -> Vec<ContentPackageInfo> {
  store::list(&app)
}

#[tauri::command]
pub fn content_package_install(app: AppHandle, path: String) -> Result<ContentPackageInfo, String> {
  let installed = store::install(&app, std::path::Path::new(&path))?;
  let _ = app.emit(CONTENT_CHANGED_EVENT, ());
  Ok(installed)
}

#[tauri::command]
pub fn content_package_remove(app: AppHandle, id: String) -> Result<(), String> {
  store::remove(&app, &id)?;
  let _ = app.emit(CONTENT_CHANGED_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn content_open_dir(app: AppHandle) -> Result<String, String> {
  store::open_dir(&app)
}

#[cfg(test)]
mod tests {
  use super::store;

  #[test]
  fn entry_url_is_package_scoped() {
    let url = store::entry_url("community.mist", "index.html");
    assert!(url.ends_with("/community.mist/index.html"));
  }
}
