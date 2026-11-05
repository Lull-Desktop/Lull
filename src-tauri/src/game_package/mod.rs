//! 游戏包：清单校验、目录/授权、`lullgame://` 资源服务。
//!
//! 与 `widget_package` 同构；运行时在 `game`。安装走 `extension` 的共享 staging，
//! 本模块不创建窗口、不持有实例状态。

pub mod digest;
pub mod manifest;
pub mod protocol;
pub mod store;

pub use protocol::handle as handle_protocol;
