//! 音乐资料库的 SQLx 仓储层。
//!
//! 这里只做 SQL、事务与行映射；业务优先级（用户覆盖、重扫保护、实体合并）
//! 放在 `media::library` / `media::services`。

pub mod artists;
pub mod db;
pub mod sources;
pub mod tracks;

use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

/// 当前 Unix 毫秒。系统时间异常时回退 0，而不是 panic。
#[must_use]
pub fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_or(0, |duration| {
      i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
    })
}

/// 生成带前缀的稳定字符串 ID（UUIDv7，按时间有序）。
#[must_use]
pub fn new_id(prefix: &str) -> String {
  format!("{prefix}_{}", Uuid::now_v7())
}
