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

use std::path::PathBuf;
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

/// 用系统文件对话框选包再安装。`folder=true` 选目录，否则选 `.zip`。
///
/// 拖拽是「锦上添花」的入口：某些环境（远程会话、被别的 DnD 处理器接管、
/// 从压缩包视图里拖出）拿不到文件路径，这里提供一条永远可用的通道。
/// 对话框跑在阻塞线程：rfd 会自己建消息循环，不能占住主线程。
#[tauri::command]
pub async fn content_package_pick_and_install(
  app: AppHandle,
  folder: bool,
) -> Result<Option<ContentPackageInfo>, String> {
  let picked = tauri::async_runtime::spawn_blocking(move || pick_source(folder))
    .await
    .map_err(|error| format!("打开文件选择器失败：{error}"))?;
  let Some(path) = picked else {
    return Ok(None);
  };
  let installed = store::install(&app, &path)?;
  let _ = app.emit(CONTENT_CHANGED_EVENT, ());
  Ok(Some(installed))
}

fn pick_source(folder: bool) -> Option<PathBuf> {
  let dialog = rfd::FileDialog::new().set_title("选择 Lull 内容包");
  if folder {
    dialog.pick_folder()
  } else {
    dialog
      .add_filter("Lull 内容包 (*.zip)", &["zip"])
      .add_filter("所有文件", &["*"])
      .pick_file()
  }
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
