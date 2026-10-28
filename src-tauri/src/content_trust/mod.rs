//! 社区发布者签名：信任根、envelope、声明、验证与策略。
//!
//! 宿主只信任编译进二进制的公钥；签名文件随包放在包根 `.lull-signature.json`。
//! 这里只回答「这个包是不是由持钥方签发、字节有没有被换」，
//! 不参与权限判断，也不替代内容 digest 检查。

pub mod envelope;
pub mod keys;
pub mod policy;
pub mod statement;
pub mod verify;

pub use policy::TrustPolicy;
pub use verify::{
  persist_sidecar, verify_installed, verify_source, PackageClaim, PackageKind, SignatureDecision,
  SignatureInfo,
};
