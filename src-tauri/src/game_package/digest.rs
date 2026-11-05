//! 游戏包完整性：旁路 `.lull-integrity.json` + 整包摘要。
//!
//! 与 widget 包同构：摘要不写进 `game.json`（否则写摘要会改变自身字节），
//! 也不服务点号路径。安装时生成/复核，加载时若有锁则复核。

use crate::package_hash;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write;
use std::path::Path;

pub const INTEGRITY_FILE: &str = ".lull-integrity.json";
const SCHEME: &[u8] = b"lull-game-package\0";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
  pub schema_version: u32,
  pub algorithm: String,
  pub scope: String,
  pub digest: String,
  /// `declared`（创作者写入）或 `computed`（安装时本地锁定）。
  pub source: String,
}

/// 计算摘要，返回 64 位小写十六进制。
pub fn compute(dir: &Path, id: &str, version: &str) -> Result<String, String> {
  if id.is_empty() || version.is_empty() {
    return Err("计算摘要需要 id 与 version".to_string());
  }
  package_hash::compute(SCHEME, &[id, version], dir, |relative| {
    relative.split('/').any(|segment| segment.starts_with('.'))
  })
}

/// 只哈希 `game.json` 本身，作为授权记录的清单指纹。
pub fn manifest_hash(dir: &Path) -> Result<String, String> {
  let bytes = std::fs::read(dir.join(super::manifest::MANIFEST_FILE))
    .map_err(|error| format!("读取 game.json 失败：{error}"))?;
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
  let Ok(text) = std::fs::read_to_string(path) else {
    return Ok(None);
  };
  let integrity: Integrity =
    serde_json::from_str(&text).map_err(|error| format!("解析 {INTEGRITY_FILE} 失败：{error}"))?;
  if integrity.schema_version != SCHEMA_VERSION
    || integrity.algorithm != "sha256"
    || integrity.scope != "package"
  {
    return Err(format!(
      "{INTEGRITY_FILE} 的 algorithm/scope/schemaVersion 不受支持"
    ));
  }
  Ok(Some(integrity))
}

/// 有锁则复核；无锁返回 `Ok(None)`。
pub fn check(dir: &Path, id: &str, version: &str) -> Result<Option<Integrity>, String> {
  let Some(integrity) = read(dir)? else {
    return Ok(None);
  };
  let actual = compute(dir, id, version)?;
  if actual != integrity.digest {
    return Err(format!(
      "包摘要不匹配（声明 {}，实际 {actual}）",
      integrity.digest
    ));
  }
  Ok(Some(integrity))
}

/// 写入本地计算的锁；已有锁不覆盖。
pub fn seal(dir: &Path, id: &str, version: &str, source: &str) -> Result<(), String> {
  if read(dir)?.is_some() {
    return Ok(());
  }
  let digest = compute(dir, id, version)?;
  let integrity = Integrity {
    schema_version: SCHEMA_VERSION,
    algorithm: "sha256".to_string(),
    scope: "package".to_string(),
    digest,
    source: source.to_string(),
  };
  let json = serde_json::to_vec_pretty(&integrity)
    .map_err(|error| format!("序列化 {INTEGRITY_FILE} 失败：{error}"))?;
  std::fs::write(dir.join(INTEGRITY_FILE), json)
    .map_err(|error| format!("写入 {INTEGRITY_FILE} 失败：{error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "lull-game-digest-{name}-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
  }

  #[test]
  fn digest_changes_with_content_and_ignores_dot_files() {
    let dir = temp_dir("digest");
    std::fs::write(dir.join("game.json"), b"{}").expect("write");
    let first = compute(&dir, "demo.game", "1.0.0").expect("digest");
    std::fs::write(dir.join(INTEGRITY_FILE), b"{}").expect("write lock");
    let second = compute(&dir, "demo.game", "1.0.0").expect("digest");
    assert_eq!(first, second);
    std::fs::write(dir.join("asset.bin"), b"x").expect("write");
    let third = compute(&dir, "demo.game", "1.0.0").expect("digest");
    assert_ne!(first, third);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn seal_then_check_detects_tampering() {
    let dir = temp_dir("seal");
    std::fs::write(dir.join("game.json"), b"{}").expect("write");
    seal(&dir, "demo.game", "1.0.0", "computed").expect("seal");
    assert!(check(&dir, "demo.game", "1.0.0").expect("check").is_some());
    std::fs::write(dir.join("game.json"), b"{\"x\":1}").expect("tamper");
    assert!(check(&dir, "demo.game", "1.0.0").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
