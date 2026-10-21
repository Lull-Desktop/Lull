//! 壁纸子系统门面：对外只暴露生命周期与 IPC 命令。
//!
//! 内部模块依赖方向：
//! `runtime`（状态/命令） → `windows`（窗口） → `protocol` / `topology` → `ffi`
//! `watchdog` 只调用 `ffi` 与 `windows::rebuild`。
#![allow(unsafe_code)]

mod ffi;
mod protocol;
pub(crate) mod runtime;
mod topology;
mod watchdog;
mod windows;

pub(crate) use ffi::wlog;
pub use runtime::{autostart, enabled, shutdown};
