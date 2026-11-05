//! Authority 租约：token、心跳、epoch 与过期判定。
//!
//! Lease 只在宿主内存里；重启后靠存档里的 `authorityEpoch` 继续递增。
//! 任何提交都必须同时满足 instance / authority / epoch / token / lease 未过期。

use super::error::{codes, GameError, GameResult};

/// 租约 TTL 与心跳间隔（毫秒）。心跳由 Authority 宿主壳按这个间隔发送。
pub const LEASE_TTL_MS: u64 = 10_000;
#[allow(dead_code)]
pub const HEARTBEAT_INTERVAL_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityLease {
  pub instance_id: String,
  pub authority_id: String,
  pub epoch: u32,
  pub lease_id: String,
  pub token: String,
  pub expires_at_ms: u64,
}

#[must_use]
pub fn random_token() -> String {
  // 32 字节随机数的 hex：两个 UUIDv4 的 simple 形式拼接（各 32 位 hex）。
  format!(
    "{}{}",
    uuid::Uuid::new_v4().simple(),
    uuid::Uuid::new_v4().simple()
  )
}

#[must_use]
pub fn new_authority_id() -> String {
  uuid::Uuid::new_v4().to_string()
}

#[must_use]
pub fn new_lease_id() -> String {
  uuid::Uuid::new_v4().to_string()
}

impl AuthorityLease {
  #[must_use]
  pub fn issue(instance_id: &str, authority_id: &str, epoch: u32, now_ms: u64) -> Self {
    Self {
      instance_id: instance_id.to_string(),
      authority_id: authority_id.to_string(),
      epoch,
      lease_id: new_lease_id(),
      token: random_token(),
      expires_at_ms: now_ms.saturating_add(LEASE_TTL_MS),
    }
  }

  pub fn renew(&mut self, now_ms: u64) {
    self.expires_at_ms = now_ms.saturating_add(LEASE_TTL_MS);
  }

  #[must_use]
  pub fn is_expired(&self, now_ms: u64) -> bool {
    now_ms >= self.expires_at_ms
  }

  /// 提交前置校验的纯函数版本；窗口/实例存在性由调用方先校验。
  pub fn verify(&self, authority_id: &str, epoch: u32, token: &str, now_ms: u64) -> GameResult<()> {
    if self.authority_id != authority_id {
      return Err(GameError::new(
        codes::AUTHORITY_NOT_OWNER,
        "提交者不是当前 Authority",
      ));
    }
    if self.epoch != epoch {
      return Err(GameError::new(
        codes::AUTHORITY_EPOCH_MISMATCH,
        format!("authorityEpoch 不匹配：当前 {}，提交 {epoch}", self.epoch),
      ));
    }
    if self.token != token {
      return Err(GameError::new(
        codes::AUTHORITY_TOKEN_INVALID,
        "authority token 无效",
      ));
    }
    if self.is_expired(now_ms) {
      return Err(GameError::new(
        codes::AUTHORITY_LEASE_EXPIRED,
        "Authority 租约已过期",
      ));
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lease_renews_and_expires() {
    let mut lease = AuthorityLease::issue("i1", "a1", 3, 1_000);
    assert!(!lease.is_expired(5_000));
    assert!(lease.is_expired(LEASE_TTL_MS + 1_000));
    lease.renew(5_000);
    assert!(!lease.is_expired(10_000));
  }

  #[test]
  fn verify_rejects_wrong_owner_epoch_token_and_expiry() {
    let lease = AuthorityLease::issue("i1", "a1", 3, 1_000);
    assert!(lease.verify("a1", 3, &lease.token, 2_000).is_ok());
    assert_eq!(
      lease
        .verify("a2", 3, &lease.token, 2_000)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_NOT_OWNER)
    );
    assert_eq!(
      lease
        .verify("a1", 4, &lease.token, 2_000)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_EPOCH_MISMATCH)
    );
    assert_eq!(
      lease
        .verify("a1", 3, "wrong", 2_000)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_TOKEN_INVALID)
    );
    assert_eq!(
      lease
        .verify("a1", 3, &lease.token, 20_000)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_LEASE_EXPIRED)
    );
  }

  #[test]
  fn tokens_are_64_hex_chars_and_unique() {
    let first = random_token();
    let second = random_token();
    assert_eq!(first.len(), 64);
    assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_ne!(first, second);
  }
}
