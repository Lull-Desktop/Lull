//! 用户内容包：发现、卸载与 `lullcontent://` 资源服务。
//!
//! 安装统一走 `extension::install` 的共享管线（见 `extension/mod.rs`），本模块只保留
//! 场景适配器所需的清单/摘要/扫描能力，以及壁纸窗使用的只读列表命令。
//!
//! 与插件包（`widget_package`）的区别：
//! - 内容包只包含静态 HTML/CSS，运行在 `sandbox=""` 的 iframe 里，没有 JS 与 IPC；
//! - 不需要窗口、能力授权或状态 KV，只需要「装在哪、能不能加载、摘要是否对得上」；
//! - 目录扁平（`content/<id>/`），同时支持文件夹与 zip 两种安装源。

pub mod digest;
pub mod manifest;
mod protocol;
pub(crate) mod store;

pub use protocol::handle as handle_protocol;
pub use store::ContentPackageInfo;

use tauri::AppHandle;

/// 壁纸窗的只读场景列表。安装/卸载入口在 `extensions_*`，不要给壁纸窗扩大权限。
#[tauri::command]
#[must_use]
pub fn content_packages(app: AppHandle) -> Vec<ContentPackageInfo> {
  store::list(&app)
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
