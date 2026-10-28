//! 宿主内置的发布者公钥信任根。
//!
//! 信任包由社区仓库的 `scripts/export-host-trust.mjs` 生成，随宿主版本编译进二进制；
//! 运行时**不**从网络或磁盘读取信任根，避免「站点被换钥」把签名变成自证。
//!
//! 公钥以 raw 32 字节 base64 保存；keyId / fingerprint 仍按社区约定从
//! Ed25519 SPKI DER 推导，保证两边算出来的是同一个值。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::OnceLock;

/// Ed25519 SubjectPublicKeyInfo 的固定 DER 前缀（RFC 8410）。
const SPKI_PREFIX: [u8; 12] = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

const TRUST_BUNDLE: &str = include_str!("../../trust/publisher-keys.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBundle {
  schema_version: u32,
  keys: Vec<RawKey>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawKey {
  key_id: String,
  label: String,
  algorithm: String,
  public_key: String,
  #[serde(default)]
  not_before: Option<String>,
  #[serde(default)]
  retired_at: Option<String>,
  #[serde(default)]
  revoked: bool,
  fingerprint: String,
}

/// 一把已校验的内置发布者公钥。
#[derive(Debug, Clone)]
pub struct TrustedKey {
  key_id: String,
  label: String,
  not_before: Option<String>,
  retired_at: Option<String>,
  revoked: bool,
  fingerprint: String,
  verifying_key: VerifyingKey,
}

/// 宿主信任根：只包含随版本发布的公钥。
#[derive(Debug, Clone)]
pub struct TrustStore {
  keys: Vec<TrustedKey>,
}

fn hex(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    let _ = write!(out, "{byte:02x}");
  }
  out
}

fn spki_der(raw: &[u8; 32]) -> [u8; 44] {
  let mut der = [0_u8; 44];
  der[..12].copy_from_slice(&SPKI_PREFIX);
  der[12..].copy_from_slice(raw);
  der
}

/// keyId = SPKI DER 的 sha256 前 16 位 hex，与社区 `signing.mjs` 一致。
#[must_use]
pub fn key_id_of_raw(raw: &[u8; 32]) -> String {
  let der = spki_der(raw);
  let digest = Sha256::digest(der);
  let full = hex(&digest);
  full[..16].to_string()
}

/// fingerprint = SPKI DER 的 sha256 全量 hex。
#[must_use]
pub fn fingerprint_of_raw(raw: &[u8; 32]) -> String {
  let der = spki_der(raw);
  hex(&Sha256::digest(der))
}

fn valid_date(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 10
    && bytes[4] == b'-'
    && bytes[7] == b'-'
    && bytes[..4].iter().all(u8::is_ascii_digit)
    && bytes[5..7].iter().all(u8::is_ascii_digit)
    && bytes[8..].iter().all(u8::is_ascii_digit)
}

/// 从 `signedAt` 取日期部分并校验 ISO 形状；验签层用日期窗口判断密钥是否可用。
pub fn signed_date(signed_at: &str) -> Result<&str, String> {
  if signed_at.len() < 20 || !signed_at.is_ascii() || signed_at.as_bytes()[10] != b'T' {
    return Err(format!("signedAt 不是 ISO 时间：{signed_at}"));
  }
  if !signed_at.ends_with('Z') {
    return Err(format!("signedAt 必须是 UTC（以 Z 结尾）：{signed_at}"));
  }
  let date = &signed_at[..10];
  if !valid_date(date) {
    return Err(format!("signedAt 日期非法：{signed_at}"));
  }
  Ok(date)
}

impl TrustedKey {
  /// 从信任包条目构造；所有派生字段在这里一次性校验，坏条目直接拒绝。
  fn from_raw(entry: RawKey) -> Result<Self, String> {
    let at = format!("publisher-keys/{}", entry.key_id);
    if entry.algorithm != "ed25519" {
      return Err(format!("{at}: 只支持 ed25519，当前 {}", entry.algorithm));
    }
    if entry.key_id.len() != 16 || !entry.key_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
      return Err(format!("{at}: keyId 必须是 16 位 hex"));
    }
    let raw = STANDARD
      .decode(&entry.public_key)
      .map_err(|error| format!("{at}: publicKey 不是标准 base64：{error}"))?;
    let raw: [u8; 32] = raw
      .try_into()
      .map_err(|_| format!("{at}: publicKey 必须是 32 字节 raw key"))?;
    if key_id_of_raw(&raw) != entry.key_id {
      return Err(format!(
        "{at}: keyId 与公钥不匹配，实际 {}",
        key_id_of_raw(&raw)
      ));
    }
    if fingerprint_of_raw(&raw) != entry.fingerprint {
      return Err(format!(
        "{at}: fingerprint 与公钥不匹配，实际 {}",
        fingerprint_of_raw(&raw)
      ));
    }
    if let Some(value) = entry.not_before.as_deref() {
      if !valid_date(value) {
        return Err(format!("{at}: notBefore 必须是 YYYY-MM-DD"));
      }
    }
    if let Some(value) = entry.retired_at.as_deref() {
      if !valid_date(value) {
        return Err(format!("{at}: retiredAt 必须是 YYYY-MM-DD"));
      }
    }
    let verifying_key =
      VerifyingKey::from_bytes(&raw).map_err(|error| format!("{at}: 公钥不可用：{error}"))?;
    Ok(Self {
      key_id: entry.key_id,
      label: entry.label,
      not_before: entry.not_before,
      retired_at: entry.retired_at,
      revoked: entry.revoked,
      fingerprint: entry.fingerprint,
      verifying_key,
    })
  }

  #[must_use]
  pub fn key_id(&self) -> &str {
    &self.key_id
  }

  #[must_use]
  pub fn label(&self) -> &str {
    &self.label
  }

  #[must_use]
  pub fn fingerprint(&self) -> &str {
    &self.fingerprint
  }

  #[must_use]
  pub fn revoked(&self) -> bool {
    self.revoked
  }

  #[must_use]
  pub fn verifying_key(&self) -> &VerifyingKey {
    &self.verifying_key
  }

  /// 某个签名日期是否还落在这把钥匙的有效期内。
  #[must_use]
  pub fn usable_at(&self, date: &str) -> bool {
    if self.revoked {
      return false;
    }
    if let Some(not_before) = self.not_before.as_deref() {
      if date < not_before {
        return false;
      }
    }
    if let Some(retired_at) = self.retired_at.as_deref() {
      if date >= retired_at {
        return false;
      }
    }
    true
  }
}

impl TrustStore {
  /// 解析信任包；**只用于测试与启动自检**，生产路径走 [`TrustStore::global`]。
  pub fn from_json(text: &str) -> Result<Self, String> {
    let bundle: RawBundle =
      serde_json::from_str(text).map_err(|error| format!("信任包不是合法 JSON：{error}"))?;
    if bundle.schema_version != 1 {
      return Err(format!(
        "信任包 schemaVersion 必须是 1，当前 {}",
        bundle.schema_version
      ));
    }
    let mut keys = Vec::with_capacity(bundle.keys.len());
    let mut seen = std::collections::HashSet::new();
    for entry in bundle.keys {
      let key = TrustedKey::from_raw(entry)?;
      if !seen.insert(key.key_id.clone()) {
        return Err(format!("信任包 keyId 重复：{}", key.key_id));
      }
      keys.push(key);
    }
    if keys.is_empty() {
      return Err("信任包没有任何公钥".to_string());
    }
    Ok(Self { keys })
  }

  /// 编译进二进制的信任根；解析失败返回错误，验签层会把它当作「无法验签」。
  pub fn global() -> Result<&'static Self, String> {
    static STORE: OnceLock<Result<TrustStore, String>> = OnceLock::new();
    match STORE.get_or_init(|| TrustStore::from_json(TRUST_BUNDLE)) {
      Ok(store) => Ok(store),
      Err(error) => Err(error.clone()),
    }
  }

  /// 测试用空信任根；生产不会走这里（`global()` 要求至少一把公钥）。
  #[cfg(test)]
  pub(crate) fn empty() -> Self {
    Self { keys: Vec::new() }
  }

  #[must_use]
  pub fn find(&self, key_id: &str) -> Option<&TrustedKey> {
    self.keys.iter().find(|key| key.key_id == key_id)
  }

  #[cfg(test)]
  #[must_use]
  pub fn keys(&self) -> &[TrustedKey] {
    &self.keys
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn community_key_derives_expected_ids() {
    let raw: [u8; 32] = STANDARD
      .decode("uXEeCgcI7Tn16mfAA8X7JXtCsSUSsuWRjOcNEvPlCZs=")
      .unwrap_or_default()
      .try_into()
      .unwrap_or_default();
    assert_eq!(key_id_of_raw(&raw), "279aff591d2627ed");
    assert_eq!(
      fingerprint_of_raw(&raw),
      "279aff591d2627ed6c5f78fafcdffaae1dc5362c97c9fc1d2efb71035fe22eb8"
    );
  }

  #[test]
  fn embedded_trust_bundle_is_valid_and_labelled() {
    assert!(TrustStore::global().is_ok());
    let Ok(store) = TrustStore::global() else {
      return;
    };
    let Some(key) = store.find("279aff591d2627ed") else {
      return;
    };
    assert!(key.label().contains("Lull Community"));
    assert!(!key.revoked());
    assert_eq!(key.fingerprint().len(), 64);
  }

  #[test]
  fn signed_date_requires_utc_iso() {
    assert_eq!(
      signed_date("2026-10-28T07:30:19Z").unwrap_or_default(),
      "2026-10-28"
    );
    assert!(signed_date("2026-10-28 07:30:19").is_err());
    assert!(signed_date("2026-10-28T07:30:19+08:00").is_err());
  }
}
