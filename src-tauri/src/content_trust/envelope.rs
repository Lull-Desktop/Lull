//! 逐包签名 envelope 的解析与结构校验。
//!
//! 签名对象是 `payload` 解码后的**原始字节**，不是解析后的 JSON；
//! 因此这里只做 base64/长度/算法校验，验签在 `verify.rs` 里对原始字节做。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;

/// 包内签名文件允许的最大字节数；正常 envelope 只有几百字节。
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
/// 当前包内签名格式版本。
pub const ENVELOPE_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEnvelope {
  schema_version: u32,
  algorithm: String,
  key_id: String,
  payload: String,
  signature: String,
}

/// 已通过结构校验的 envelope；签名尚未验证。
#[derive(Debug, Clone)]
pub struct ParsedEnvelope {
  pub key_id: String,
  pub payload: Vec<u8>,
  pub signature: Vec<u8>,
}

fn decode_base64(value: &str, label: &str) -> Result<Vec<u8>, String> {
  let bytes = STANDARD
    .decode(value)
    .map_err(|error| format!("{label} 不是标准 base64：{error}"))?;
  if bytes.is_empty() {
    return Err(format!("{label} 不能为空"));
  }
  Ok(bytes)
}

/// 解析并做结构校验；损坏的签名文件返回错误，不降级成「未签名」。
pub fn parse_envelope(bytes: &[u8]) -> Result<ParsedEnvelope, String> {
  if bytes.len() > MAX_ENVELOPE_BYTES {
    return Err(format!(
      "签名文件超过 {} KiB 上限",
      MAX_ENVELOPE_BYTES / 1024
    ));
  }
  let raw: RawEnvelope =
    serde_json::from_slice(bytes).map_err(|error| format!("签名文件不是合法 JSON：{error}"))?;
  if raw.schema_version != ENVELOPE_SCHEMA_VERSION {
    return Err(format!(
      "不支持的签名 schemaVersion：{}（只接受 v{ENVELOPE_SCHEMA_VERSION}）",
      raw.schema_version
    ));
  }
  if raw.algorithm != "ed25519" {
    return Err(format!("不支持的签名算法：{}", raw.algorithm));
  }
  if raw.key_id.len() != 16 || !raw.key_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
    return Err("签名文件的 keyId 必须是 16 位 hex".to_string());
  }
  let payload = decode_base64(&raw.payload, "payload")?;
  let signature = decode_base64(&raw.signature, "signature")?;
  if signature.len() != 64 {
    return Err(format!("签名必须是 64 字节，当前 {} 字节", signature.len()));
  }
  Ok(ParsedEnvelope {
    key_id: raw.key_id,
    payload,
    signature,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn envelope(schema: u32, signature_len: usize) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": schema,
        "algorithm": "ed25519",
        "keyId": "279aff591d2627ed",
        "payload": STANDARD.encode(b"{}"),
        "signature": STANDARD.encode(vec![0_u8; signature_len]),
    }))
    .unwrap_or_default()
  }

  #[test]
  fn accepts_current_envelope() {
    let parsed = parse_envelope(&envelope(2, 64));
    assert!(parsed.is_ok());
  }

  #[test]
  fn rejects_legacy_schema_and_bad_signature_length() {
    assert!(parse_envelope(&envelope(1, 64)).is_err());
    assert!(parse_envelope(&envelope(2, 63)).is_err());
  }

  #[test]
  fn rejects_oversized_file() {
    assert!(parse_envelope(&vec![b' '; MAX_ENVELOPE_BYTES + 1]).is_err());
  }
}
