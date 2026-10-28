//! 逐包签名验证：内置公钥 → envelope 签名 → 声明 → 内容摘要。
//!
//! 宿主只信任编译进二进制的公钥；签名文件随包放在包根 `.lull-signature.json`。
//! 签名文件不在内容摘要范围内（widget 排除点号路径，scene 摘要只覆盖 entry 目录），
//! 所以「签名随包」不会改变安装器认的 digest。

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::envelope::{parse_envelope, MAX_ENVELOPE_BYTES};
use super::keys::{TrustStore, TrustedKey};
use super::policy::{decision_for, TrustPolicy};
use super::statement::PackageStatement;

/// 包内签名文件的标准文件名。
pub const SIGNATURE_FILE: &str = ".lull-signature.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageKind {
  Scene,
  Widget,
}

impl PackageKind {
  #[must_use]
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Scene => "scene",
      Self::Widget => "widget",
    }
  }
}

/// 被验证的包身份：调用方负责用与安装器相同的算法算出 `digest`。
#[derive(Debug, Clone)]
pub struct PackageClaim {
  pub kind: PackageKind,
  pub id: String,
  pub version: String,
  pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignatureStatus {
  Verified,
  Unsigned,
  UnknownKey,
  Invalid,
  Mismatch,
  Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignatureDecision {
  Allow,
  Warn,
  Block,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
  pub status: SignatureStatus,
  pub decision: SignatureDecision,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub key_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub key_label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub key_fingerprint: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub signed_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub release_seq: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
}

fn decision(status: SignatureStatus, policy: &TrustPolicy) -> SignatureDecision {
  match decision_for(
    match status {
      SignatureStatus::Verified => "verified",
      SignatureStatus::Unsigned => "unsigned",
      SignatureStatus::UnknownKey => "unknown-key",
      SignatureStatus::Invalid => "invalid",
      SignatureStatus::Mismatch => "mismatch",
      SignatureStatus::Revoked => "revoked",
    },
    policy,
  ) {
    "allow" => SignatureDecision::Allow,
    "block" => SignatureDecision::Block,
    _ => SignatureDecision::Warn,
  }
}

fn info(status: SignatureStatus, policy: &TrustPolicy, reason: Option<&str>) -> SignatureInfo {
  SignatureInfo {
    status,
    decision: decision(status, policy),
    key_id: None,
    key_label: None,
    key_fingerprint: None,
    signed_at: None,
    release_seq: None,
    reason: reason.map(str::to_string),
  }
}

impl SignatureInfo {
  #[must_use]
  pub fn unsigned(policy: &TrustPolicy, reason: &str) -> Self {
    info(SignatureStatus::Unsigned, policy, Some(reason))
  }

  #[must_use]
  pub fn invalid(reason: &str) -> Self {
    SignatureInfo {
      status: SignatureStatus::Invalid,
      decision: SignatureDecision::Block,
      key_id: None,
      key_label: None,
      key_fingerprint: None,
      signed_at: None,
      release_seq: None,
      reason: Some(reason.to_string()),
    }
  }

  fn unknown_key(key_id: &str, policy: &TrustPolicy) -> Self {
    let mut value = info(SignatureStatus::UnknownKey, policy, Some("unknown-key"));
    value.key_id = Some(key_id.to_string());
    value
  }

  fn revoked(key: &TrustedKey) -> Self {
    let mut value = info(
      SignatureStatus::Revoked,
      &TrustPolicy::default(),
      Some("revoked-key"),
    );
    value.key_id = Some(key.key_id().to_string());
    value.key_label = Some(key.label().to_string());
    value.key_fingerprint = Some(key.fingerprint().to_string());
    value
  }

  fn mismatch(key: &TrustedKey, statement: &PackageStatement, reason: &str) -> Self {
    let mut value = info(
      SignatureStatus::Mismatch,
      &TrustPolicy::default(),
      Some(reason),
    );
    value.key_id = Some(key.key_id().to_string());
    value.key_label = Some(key.label().to_string());
    value.key_fingerprint = Some(key.fingerprint().to_string());
    value.signed_at = Some(statement.signed_at.clone());
    value.release_seq = Some(statement.release_seq);
    value
  }

  fn verified(key: &TrustedKey, statement: &PackageStatement) -> Self {
    SignatureInfo {
      status: SignatureStatus::Verified,
      decision: SignatureDecision::Allow,
      key_id: Some(key.key_id().to_string()),
      key_label: Some(key.label().to_string()),
      key_fingerprint: Some(key.fingerprint().to_string()),
      signed_at: Some(statement.signed_at.clone()),
      release_seq: Some(statement.release_seq),
      reason: None,
    }
  }
}

fn verify_signature(key: &TrustedKey, payload: &[u8], signature: &[u8]) -> bool {
  let Ok(signature) = Signature::from_slice(signature) else {
    return false;
  };
  let verifying_key: &VerifyingKey = key.verifying_key();
  verifying_key.verify_strict(payload, &signature).is_ok()
}

fn verify_envelope(
  bytes: &[u8],
  claim: &PackageClaim,
  store: &TrustStore,
  policy: &TrustPolicy,
) -> SignatureInfo {
  let parsed = match parse_envelope(bytes) {
    Ok(parsed) => parsed,
    Err(error) => return SignatureInfo::invalid(&error),
  };
  let Some(key) = store.find(&parsed.key_id) else {
    return SignatureInfo::unknown_key(&parsed.key_id, policy);
  };
  if key.revoked() {
    return SignatureInfo::revoked(key);
  }
  if !verify_signature(key, &parsed.payload, &parsed.signature) {
    return SignatureInfo::invalid("bad-signature");
  }
  let statement = match PackageStatement::parse(&parsed.payload) {
    Ok(statement) => statement,
    Err(error) => return SignatureInfo::invalid(&error),
  };
  if statement.signed_by.key_id != parsed.key_id {
    return SignatureInfo::invalid("key-id-mismatch");
  }
  if statement.kind != claim.kind.as_str() {
    return SignatureInfo::mismatch(key, &statement, "kind-mismatch");
  }
  if statement.id != claim.id || statement.version != claim.version {
    return SignatureInfo::mismatch(key, &statement, "id-version-mismatch");
  }
  if statement.digest.value != claim.digest {
    return SignatureInfo::mismatch(key, &statement, "digest-mismatch");
  }
  if !key.usable_at(statement.signed_date()) {
    return SignatureInfo::invalid("key-not-valid-at-signed-at");
  }
  SignatureInfo::verified(key, &statement)
}

fn read_sidecar(path: &Path) -> Result<Vec<u8>, String> {
  let metadata = std::fs::metadata(path)
    .map_err(|error| format!("读不到签名文件 {}：{error}", path.display()))?;
  if metadata.len() > MAX_ENVELOPE_BYTES as u64 {
    return Err(format!(
      "签名文件超过 {} KiB 上限",
      MAX_ENVELOPE_BYTES / 1024
    ));
  }
  std::fs::read(path).map_err(|error| format!("读取签名文件失败：{error}"))
}

/// 外部 sidecar：`<source>.lull-signature.json`（zip 或目录旁）。
fn external_sidecar(source: &Path) -> PathBuf {
  PathBuf::from(format!("{}.lull-signature.json", source.display()))
}

fn store_for() -> Result<&'static TrustStore, String> {
  TrustStore::global()
}

/// 验证安装源（zip 或目录）的包内/旁边签名。
///
/// 返回签名信息与「需要复制进包根的外部 sidecar 字节」；
/// 包内已有的签名返回 `None`，调用方不需要再写。
pub fn verify_source(
  source: &Path,
  bundle: &Path,
  claim: &PackageClaim,
  policy: &TrustPolicy,
) -> (SignatureInfo, Option<Vec<u8>>) {
  let embedded = bundle.join(SIGNATURE_FILE);
  let external = external_sidecar(source);

  let external_bytes = if external.is_file() {
    match read_sidecar(&external) {
      Ok(bytes) => Some(bytes),
      Err(error) => return (SignatureInfo::invalid(&error), None),
    }
  } else {
    None
  };
  let embedded_bytes = if embedded.is_file() {
    match read_sidecar(&embedded) {
      Ok(bytes) => Some(bytes),
      Err(error) => return (SignatureInfo::invalid(&error), None),
    }
  } else {
    None
  };

  if let (Some(left), Some(right)) = (&external_bytes, &embedded_bytes) {
    if left != right {
      return (
        SignatureInfo::invalid("external-and-embedded-signature-differ"),
        None,
      );
    }
  }

  let bytes = external_bytes.as_ref().or(embedded_bytes.as_ref());
  let Some(bytes) = bytes else {
    return (
      SignatureInfo::unsigned(policy, "signature-file-missing"),
      None,
    );
  };
  let Ok(store) = store_for() else {
    return (SignatureInfo::invalid("trust-store-invalid"), None);
  };
  let signature = verify_envelope(bytes, claim, store, policy);
  let persist = if external_bytes.is_some() && embedded_bytes.is_none() {
    external_bytes
  } else {
    None
  };
  (signature, persist)
}

/// 验证已安装包根里的 `.lull-signature.json`。
#[must_use]
pub fn verify_installed(dir: &Path, claim: &PackageClaim, policy: &TrustPolicy) -> SignatureInfo {
  let path = dir.join(SIGNATURE_FILE);
  if !path.is_file() {
    return SignatureInfo::unsigned(policy, "signature-file-missing");
  }
  let bytes = match read_sidecar(&path) {
    Ok(bytes) => bytes,
    Err(error) => return SignatureInfo::invalid(&error),
  };
  let Ok(store) = store_for() else {
    return SignatureInfo::invalid("trust-store-invalid");
  };
  verify_envelope(&bytes, claim, store, policy)
}

/// 把外部 sidecar 复制到暂存包根，安装后仍可复验。
pub fn persist_sidecar(bundle: &Path, bytes: &[u8]) -> Result<(), String> {
  let path = bundle.join(SIGNATURE_FILE);
  if path.is_file() {
    return Ok(());
  }
  std::fs::write(&path, bytes).map_err(|error| format!("写入包内签名失败：{error}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::content_trust::keys::{fingerprint_of_raw, key_id_of_raw};
  use crate::content_trust::policy::TrustPolicy;
  use base64::engine::general_purpose::STANDARD;
  use base64::Engine;
  use ed25519_dalek::{Signer, SigningKey};

  const SEED: [u8; 32] = [7_u8; 32];

  fn store() -> TrustStore {
    let signing = SigningKey::from_bytes(&SEED);
    let raw = signing.verifying_key().to_bytes();
    let bundle = serde_json::json!({
        "schemaVersion": 1,
        "keys": [{
            "keyId": key_id_of_raw(&raw),
            "label": "Test Community",
            "algorithm": "ed25519",
            "publicKey": STANDARD.encode(raw),
            "notBefore": "2026-01-01",
            "retiredAt": null,
            "revoked": false,
            "fingerprint": fingerprint_of_raw(&raw),
        }]
    });
    match TrustStore::from_json(&bundle.to_string()) {
      Ok(store) => store,
      Err(_) => TrustStore::empty(),
    }
  }

  fn claim(digest: &str) -> PackageClaim {
    PackageClaim {
      kind: PackageKind::Widget,
      id: "community.test".to_string(),
      version: "1.0.0".to_string(),
      digest: digest.to_string(),
    }
  }

  fn envelope(claim: &PackageClaim, seed: [u8; 32], digest: &str, key_id: &str) -> Vec<u8> {
    let statement = serde_json::json!({
        "statementVersion": 2,
        "kind": "widget",
        "slug": "test",
        "id": claim.id.clone(),
        "version": claim.version.clone(),
        "digest": {"algorithm": "sha256", "scope": "package", "value": digest},
        "signedBy": {"keyId": key_id, "algorithm": "ed25519"},
        "releaseSeq": 1,
        "signedAt": "2026-10-28T09:20:30Z"
    });
    let payload = serde_json::to_vec(&statement).unwrap_or_default();
    let signature = SigningKey::from_bytes(&seed).sign(&payload);
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2,
        "algorithm": "ed25519",
        "keyId": key_id,
        "payload": STANDARD.encode(payload),
        "signature": STANDARD.encode(signature.to_bytes()),
    }))
    .unwrap_or_default()
  }

  #[test]
  fn verifies_matching_statement() {
    let store = store();
    let claim = claim("a".repeat(64).as_str());
    let key_id = store.keys()[0].key_id().to_string();
    let bytes = envelope(&claim, SEED, &claim.digest, &key_id);
    let result = verify_envelope(&bytes, &claim, &store, &TrustPolicy::default());
    assert_eq!(result.status, SignatureStatus::Verified);
    assert_eq!(result.decision, SignatureDecision::Allow);
  }

  #[test]
  fn detects_digest_mismatch_and_unknown_key() {
    let store = store();
    let claim = claim("a".repeat(64).as_str());
    let key_id = store.keys()[0].key_id().to_string();
    let bytes = envelope(&claim, SEED, &"b".repeat(64), &key_id);
    let result = verify_envelope(&bytes, &claim, &store, &TrustPolicy::default());
    assert_eq!(result.status, SignatureStatus::Mismatch);
    assert_eq!(result.decision, SignatureDecision::Block);

    let bytes = envelope(&claim, SEED, &claim.digest, "0000000000000000");
    let result = verify_envelope(&bytes, &claim, &store, &TrustPolicy::default());
    assert_eq!(result.status, SignatureStatus::UnknownKey);
    assert_eq!(result.decision, SignatureDecision::Warn);

    let strict = TrustPolicy {
      require_signature: true,
    };
    let result = verify_envelope(&bytes, &claim, &store, &strict);
    assert_eq!(result.decision, SignatureDecision::Block);
  }

  #[test]
  fn verifies_real_community_widget_sidecar() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/minimal-clock");
    let Ok(digest) = crate::widget_package::digest::compute(&dir, "community-clock", "1.0.0")
    else {
      return;
    };
    let claim = PackageClaim {
      kind: PackageKind::Widget,
      id: "community-clock".to_string(),
      version: "1.0.0".to_string(),
      digest,
    };
    let info = verify_installed(&dir, &claim, &TrustPolicy::default());
    assert_eq!(info.status, SignatureStatus::Verified);
    assert_eq!(info.decision, SignatureDecision::Allow);
    assert!(info
      .key_label
      .as_deref()
      .is_some_and(|label| label.contains("Lull Community")));
  }

  #[test]
  fn strict_policy_blocks_unsigned() {
    let policy = TrustPolicy {
      require_signature: true,
    };
    let value = SignatureInfo::unsigned(&policy, "missing");
    assert_eq!(value.decision, SignatureDecision::Block);
  }
}
