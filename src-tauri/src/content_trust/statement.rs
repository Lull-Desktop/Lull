//! 包内签名声明的解析与校验。
//!
//! v2 声明只包含包身份与内容摘要，不含 zip 哈希；签名文件随包走，
//! zip 自身的完整性由批次清单负责。宿主只需要 digest。

use serde::Deserialize;

use super::keys::signed_date;

pub const STATEMENT_VERSION: u32 = 2;

const SHA256_HEX: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestRef {
  pub algorithm: String,
  pub scope: String,
  pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedBy {
  pub key_id: String,
  pub algorithm: String,
}

/// 已签名的包声明（payload 解码后的 JSON）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageStatement {
  pub statement_version: u32,
  pub kind: String,
  pub slug: String,
  pub id: String,
  pub version: String,
  pub digest: DigestRef,
  pub signed_by: SignedBy,
  pub release_seq: u64,
  pub signed_at: String,
}

fn is_hex64(value: &str) -> bool {
  value.len() == SHA256_HEX && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

impl PackageStatement {
  /// 解析并校验字段形状；签名必须先验证，再调用这里（顺序不能反）。
  pub fn parse(payload: &[u8]) -> Result<Self, String> {
    let statement: Self =
      serde_json::from_slice(payload).map_err(|error| format!("签名声明不是合法 JSON：{error}"))?;
    statement.validate()?;
    Ok(statement)
  }

  pub fn validate(&self) -> Result<(), String> {
    if self.statement_version != STATEMENT_VERSION {
      return Err(format!(
        "不支持的声明版本：{}（只接受 v{STATEMENT_VERSION}）",
        self.statement_version
      ));
    }
    if self.kind != "scene" && self.kind != "widget" {
      return Err(format!("签名声明的 kind 非法：{}", self.kind));
    }
    for (field, value) in [
      ("slug", self.slug.as_str()),
      ("id", self.id.as_str()),
      ("version", self.version.as_str()),
      ("signedAt", self.signed_at.as_str()),
    ] {
      if value.is_empty() {
        return Err(format!("签名声明缺 {field}"));
      }
    }
    if self.digest.algorithm != "sha256" || self.digest.scope != "package" {
      return Err("签名声明的 digest 必须是 sha256/package".to_string());
    }
    if !is_hex64(&self.digest.value) {
      return Err("签名声明的 digest 必须是 64 位 hex".to_string());
    }
    if self.signed_by.key_id.len() != 16
      || !self
        .signed_by
        .key_id
        .chars()
        .all(|ch| ch.is_ascii_hexdigit())
    {
      return Err("签名声明的 signedBy.keyId 必须是 16 位 hex".to_string());
    }
    if self.signed_by.algorithm != "ed25519" {
      return Err("签名声明的 signedBy.algorithm 必须是 ed25519".to_string());
    }
    if self.release_seq < 1 {
      return Err("签名声明的 releaseSeq 必须是 ≥1 的整数".to_string());
    }
    signed_date(&self.signed_at)?;
    Ok(())
  }

  #[must_use]
  pub fn signed_date(&self) -> &str {
    // validate() 已保证是 ASCII ISO；这里截取日期部分不会落在非边界。
    &self.signed_at[..10]
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn payload() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "statementVersion": 2,
        "kind": "widget",
        "slug": "breathing",
        "id": "community-breath",
        "version": "1.0.0",
        "digest": {"algorithm": "sha256", "scope": "package", "value": "a".repeat(64)},
        "signedBy": {"keyId": "279aff591d2627ed", "algorithm": "ed25519"},
        "releaseSeq": 4,
        "signedAt": "2026-10-28T09:20:30Z"
    }))
    .unwrap_or_default()
  }

  #[test]
  fn parses_v2_statement() {
    let statement = PackageStatement::parse(&payload());
    assert!(statement.is_ok());
    if let Ok(statement) = statement {
      assert_eq!(statement.signed_date(), "2026-10-28");
    }
  }

  #[test]
  fn rejects_legacy_zip_field_and_bad_digest() {
    let mut value: serde_json::Value = serde_json::from_slice(&payload()).unwrap_or_default();
    value["zip"] = serde_json::json!({"path": "/downloads/x.zip"});
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    assert!(PackageStatement::parse(&bytes).is_err());

    let mut value: serde_json::Value = serde_json::from_slice(&payload()).unwrap_or_default();
    value["digest"]["value"] = serde_json::json!("short");
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    assert!(PackageStatement::parse(&bytes).is_err());
  }
}
