//! Widget 包完整性：旁路 `.lull-integrity.json` + 整包摘要。
//!
//! 为什么不用 scene 的摘要：widget 的 `widget.json` 与 entry 都在包根，摘要必须覆盖
//! 清单本身；把摘要写进清单会改变自身字节，所以单独放一个不参与摘要的文件。
//!
//! 算法：`sha256("lull-widget-package\0" + id + "\0" + version + "\0" +
//! Σ(relPath + "\0" + size + "\0" + bytes + "\0"))`，排除 `.lull-integrity.json`
//! 与任何点号开头的路径（协议也不会服务它们）。

use crate::package_hash;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write;
use std::path::Path;

/// 旁路锁文件名；不参与摘要，协议层拒绝服务。
pub const INTEGRITY_FILE: &str = ".lull-integrity.json";
const SCHEME: &[u8] = b"lull-widget-package\0";
const SCHEMA_VERSION: u32 = 1;
const DIGEST_LEN: usize = 64;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
  pub schema_version: u32,
  pub algorithm: String,
  pub scope: String,
  pub digest: String,
  /// `declared`（创作者写入）或 `computed`（安装/启用时本地锁定）。
  pub source: String,
}

/// 计算摘要，返回 64 位小写十六进制。
pub fn compute(dir: &Path, id: &str, version: &str) -> Result<String, String> {
  if id.is_empty() || version.is_empty() {
    return Err("计算摘要需要 id 与 version".to_string());
  }
  package_hash::compute(SCHEME, &[id, version], dir, ignored)
}

/// 只哈希 `widget.json` 本身，作为启用时的能力快照依据。
pub fn manifest_hash(dir: &Path) -> Result<String, String> {
  let bytes = std::fs::read(dir.join("widget.json"))
    .map_err(|error| format!("读取 widget.json 失败：{error}"))?;
  let mut hash = Sha256::new();
  hash.update(&bytes);
  Ok(hex(&hash.finalize()))
}

fn hex(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    let _ = write!(out, "{byte:02x}");
  }
  out
}

/// 读取并校验锁文件；不存在时返回 `None`，格式非法时报错。
pub fn read(dir: &Path) -> Result<Option<Integrity>, String> {
  let path = dir.join(INTEGRITY_FILE);
  if !path.is_file() {
    return Ok(None);
  }
  let text = std::fs::read_to_string(&path)
    .map_err(|error| format!("读取 {INTEGRITY_FILE} 失败：{error}"))?;
  let record: Integrity = serde_json::from_str(&text)
    .map_err(|error| format!("{INTEGRITY_FILE} 不是合法 JSON：{error}"))?;
  validate(&record)?;
  Ok(Some(record))
}

/// 复核锁文件：有锁则复算并比对，无锁返回 `None`。
pub fn check(dir: &Path, id: &str, version: &str) -> Result<Option<Integrity>, String> {
  let Some(record) = read(dir)? else {
    return Ok(None);
  };
  let actual = compute(dir, id, version)?;
  if actual != record.digest {
    return Err(format!(
      "内容包摘要不匹配：声明 {}，实际 {actual}",
      record.digest
    ));
  }
  Ok(Some(record))
}

/// 计算并写入锁文件；安装器与“手动放置后首次启用”都走这里。
pub fn seal(dir: &Path, id: &str, version: &str, source: &str) -> Result<Integrity, String> {
  let digest = compute(dir, id, version)?;
  let record = Integrity {
    schema_version: SCHEMA_VERSION,
    algorithm: "sha256".to_string(),
    scope: "package".to_string(),
    digest,
    source: source.to_string(),
  };
  let json = serde_json::to_vec_pretty(&record)
    .map_err(|error| format!("序列化 {INTEGRITY_FILE} 失败：{error}"))?;
  let path = dir.join(INTEGRITY_FILE);
  let temp = dir.join(format!("{INTEGRITY_FILE}.tmp"));
  std::fs::write(&temp, json).map_err(|error| format!("写入 {INTEGRITY_FILE} 失败：{error}"))?;
  if path.exists() {
    std::fs::remove_file(&path).map_err(|error| format!("替换 {INTEGRITY_FILE} 失败：{error}"))?;
  }
  std::fs::rename(&temp, &path).map_err(|error| format!("落盘 {INTEGRITY_FILE} 失败：{error}"))?;
  Ok(record)
}

fn validate(record: &Integrity) -> Result<(), String> {
  if record.schema_version != SCHEMA_VERSION {
    return Err(format!(
      "{INTEGRITY_FILE}.schemaVersion 必须是 {SCHEMA_VERSION}"
    ));
  }
  if record.algorithm != "sha256" {
    return Err(format!("{INTEGRITY_FILE}.algorithm 只支持 sha256"));
  }
  if record.scope != "package" {
    return Err(format!("{INTEGRITY_FILE}.scope 只支持 package"));
  }
  if record.digest.len() != DIGEST_LEN || !record.digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
    return Err(format!("{INTEGRITY_FILE}.digest 必须是 64 位十六进制"));
  }
  if record.source != "declared" && record.source != "computed" {
    return Err(format!(
      "{INTEGRITY_FILE}.source 只能是 declared 或 computed"
    ));
  }
  Ok(())
}

/// 锁文件自身与所有点号路径都不参与摘要（协议也不会服务它们）。
fn ignored(relative: &str) -> bool {
  relative == INTEGRITY_FILE || relative.split('/').any(|segment| segment.starts_with('.'))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(tag: &str) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-widget-digest-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_widget(dir: &Path) -> Result<(), std::io::Error> {
    std::fs::write(dir.join("widget.json"), br#"{"id":"community.test"}"#)?;
    std::fs::write(dir.join("index.html"), b"<html></html>")?;
    Ok(())
  }

  #[test]
  fn seals_and_detects_tampering() {
    let Some(dir) = temp_dir("tamper") else {
      return;
    };
    if write_widget(&dir).is_err() {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let sealed = seal(&dir, "community.test", "1.0.0", "computed");
    assert!(sealed.is_ok(), "封包失败：{sealed:?}");
    let checked = check(&dir, "community.test", "1.0.0");
    assert!(checked.is_ok());
    assert_eq!(
      checked.ok().flatten().map(|record| record.source),
      Some("computed".to_string())
    );

    let _ = std::fs::write(dir.join("index.html"), b"<html>changed</html>");
    assert!(check(&dir, "community.test", "1.0.0").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn ignores_lock_and_dot_paths() {
    let Some(dir) = temp_dir("ignored") else {
      return;
    };
    if write_widget(&dir).is_err() || std::fs::create_dir_all(dir.join(".git")).is_err() {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let _ = std::fs::write(dir.join(".git/config"), b"x");
    let sealed = seal(&dir, "community.test", "1.0.0", "declared");
    assert!(sealed.is_ok());
    let first = sealed.map(|record| record.digest).unwrap_or_default();
    let _ = std::fs::write(dir.join(".git/config"), b"changed");
    let second = compute(&dir, "community.test", "1.0.0").unwrap_or_default();
    assert_eq!(first, second);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn rejects_bad_lock_shape() {
    let Some(dir) = temp_dir("shape") else {
      return;
    };
    if write_widget(&dir).is_err() {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let bad = r#"{"schemaVersion":1,"algorithm":"md5","scope":"package","digest":"00","source":"computed"}"#;
    let _ = std::fs::write(dir.join(INTEGRITY_FILE), bad);
    assert!(read(&dir).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
