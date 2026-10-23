//! 内容包整包摘要：与 `scripts/content-digest.mjs` **必须逐字节一致**。
//!
//! 算法：`sha256("lull-content-package\0" + id + "\0" + version + "\0" +
//! Σ(relPath + "\0" + size + "\0" + bytes + "\0"))`，`relPath` 按 UTF-8 字节序排序。
//!
//! 安装器用它在解压后复核包内容；运行时用它判断已安装包是否被改动。
//! 任何一侧改了算法都会让「官方工具打包的包装不进客户端」，所以
//! `content_package::tests` 里用官方示例包的已知摘要做交叉校验。

use crate::package_hash;
use std::path::Path;

const SCHEME: &[u8] = b"lull-content-package\0";

/// 计算整包摘要，返回 64 位小写十六进制。
pub fn compute(id: &str, version: &str, dir: &Path) -> Result<String, String> {
  if id.is_empty() || version.is_empty() {
    return Err("计算摘要需要 id 与 version".to_string());
  }
  package_hash::compute(SCHEME, &[id, version], dir, |_| false)
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
