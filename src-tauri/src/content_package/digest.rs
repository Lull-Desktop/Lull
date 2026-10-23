//! 内容包整包摘要：与 `scripts/content-digest.mjs` **必须逐字节一致**。
//!
//! 算法：`sha256("lull-content-package\0" + id + "\0" + version + "\0" +
//! Σ(relPath + "\0" + size + "\0" + bytes + "\0"))`，`relPath` 按 UTF-8 字节序排序。
//!
//! 安装器用它在解压后复核包内容；运行时用它判断已安装包是否被改动。
//! 任何一侧改了算法都会让「官方工具打包的包装不进客户端」，所以
//! `content_package::tests` 里用官方示例包的已知摘要做交叉校验。

use sha2::{Digest, Sha256};
use std::fmt::Write;
use std::path::Path;

const SCHEME: &[u8] = b"lull-content-package\0";

/// 计算整包摘要，返回 64 位小写十六进制。
pub fn compute(id: &str, version: &str, dir: &Path) -> Result<String, String> {
  if id.is_empty() || version.is_empty() {
    return Err("计算摘要需要 id 与 version".to_string());
  }
  let mut files: Vec<String> = Vec::new();
  collect(dir, dir, &mut files)?;
  if files.is_empty() {
    return Err(format!("内容包目录为空：{}", dir.display()));
  }
  files.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));

  let mut hash = Sha256::new();
  hash.update(SCHEME);
  for part in [id, version] {
    hash.update(part.as_bytes());
    hash.update([0_u8]);
  }
  for relative in &files {
    let bytes = std::fs::read(dir.join(relative))
      .map_err(|error| format!("读取 {relative} 失败：{error}"))?;
    hash.update(relative.as_bytes());
    hash.update([0_u8]);
    hash.update(bytes.len().to_string().as_bytes());
    hash.update([0_u8]);
    hash.update(&bytes);
    hash.update([0_u8]);
  }
  Ok(hex(&hash.finalize()))
}

/// 收集包内所有文件的相对路径（统一 `/` 分隔）；遇到符号链接直接失败。
fn collect(dir: &Path, base: &Path, out: &mut Vec<String>) -> Result<(), String> {
  let entries = std::fs::read_dir(dir)
    .map_err(|error| format!("读取目录 {} 失败：{error}", dir.display()))?;
  for entry in entries {
    let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
    let path = entry.path();
    let file_type = entry
      .file_type()
      .map_err(|error| format!("读取文件类型失败：{error}"))?;
    if file_type.is_symlink() {
      return Err(format!("内容包不允许符号链接：{}", path.display()));
    }
    if file_type.is_dir() {
      collect(&path, base, out)?;
    } else if file_type.is_file() {
      let relative = path
        .strip_prefix(base)
        .map_err(|error| format!("解析相对路径失败：{error}"))?;
      let mut segments: Vec<String> = Vec::new();
      for component in relative.components() {
        let segment = component
          .as_os_str()
          .to_str()
          .ok_or_else(|| format!("内容包文件名必须是 UTF-8：{}", path.display()))?;
        segments.push(segment.to_string());
      }
      out.push(segments.join("/"));
    }
  }
  Ok(())
}

fn hex(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    // 写 String 不会失败；用 `let _` 避免 unwrap_used 禁令。
    let _ = write!(out, "{byte:02x}");
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(tag: &str) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-digest-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  #[test]
  fn digest_is_stable_and_order_independent() {
    let Some(dir) = temp_dir("stable") else {
      return;
    };
    if std::fs::create_dir_all(dir.join("a")).is_err() {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    if std::fs::write(dir.join("index.html"), b"<html>ok</html>").is_err()
      || std::fs::write(dir.join("a/style.css"), b"body{}").is_err()
    {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let first = compute("community.test", "1.0.0", &dir);
    let second = compute("community.test", "1.0.0", &dir);
    let digest = match (first, second) {
      (Ok(left), Ok(right)) => {
        assert_eq!(left, right);
        left
      }
      _ => {
        let _ = std::fs::remove_dir_all(&dir);
        return;
      }
    };
    assert_eq!(digest.len(), 64);
    assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));

    // id/version 拌入摘要：改版本必须换摘要。
    let other = compute("community.test", "1.0.1", &dir).unwrap_or_default();
    assert_ne!(digest, other);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn digest_rejects_empty_package() {
    let Some(dir) = temp_dir("empty") else {
      return;
    };
    assert!(compute("community.empty", "1.0.0", &dir).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// 跨语言对照：官方示例包的摘要写在 `public/content/catalog.json` 里，
  /// 由 Node 侧的 `content-digest.mjs` 生成。Rust 这里必须算出同一个值，
  /// 否则「官方工具打包 → 客户端安装」会全部失败。
  #[test]
  fn digest_matches_official_mist_package() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/content/scenes/mist");
    let digest = compute("community.mist", "1.0.0", &dir).unwrap_or_default();
    assert_eq!(
      digest,
      "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb"
    );
  }
}
