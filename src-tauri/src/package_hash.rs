//! 包内容哈希：`content_package` 与 `widget_package` 共用的遍历与拼装。
//!
//! 两类包使用**不同的域分隔符**，但“按路径排序、写入大小与字节”的规则只保留一份，
//! 避免两边在排序、编码或空目录判断上漂移。
//!
//! 算法：`sha256(scheme + Σ(header + "\0") + Σ(relPath + "\0" + size + "\0" + bytes + "\0"))`，
//! 其中 `relPath` 按 UTF-8 字节序排序。

use sha2::{Digest, Sha256};
use std::fmt::Write;
use std::path::Path;

/// 计算摘要。`header` 是域分隔符之后的附加字段（例如 id、version）；
/// `skip` 返回 `true` 的相对路径及其子树不参与摘要。
pub fn compute<F>(scheme: &[u8], header: &[&str], dir: &Path, skip: F) -> Result<String, String>
where
  F: Fn(&str) -> bool,
{
  let mut files: Vec<String> = Vec::new();
  collect(dir, dir, &mut files, &skip)?;
  if files.is_empty() {
    return Err(format!("包目录为空：{}", dir.display()));
  }
  files.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));

  let mut hash = Sha256::new();
  hash.update(scheme);
  for part in header {
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

/// 源内容指纹：只用于“预览 → 安装”的一致性比对，不掺入 id/version。
pub fn source_digest(dir: &Path) -> Result<String, String> {
  compute(b"lull-source\0", &[], dir, |_| false)
}

/// 收集包内所有文件的相对路径（统一 `/` 分隔）；遇到符号链接直接失败。
fn collect<F>(dir: &Path, base: &Path, out: &mut Vec<String>, skip: &F) -> Result<(), String>
where
  F: Fn(&str) -> bool,
{
  let entries =
    std::fs::read_dir(dir).map_err(|error| format!("读取目录 {} 失败：{error}", dir.display()))?;
  for entry in entries {
    let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
    let path = entry.path();
    let relative = relative_path(&path, base)?;
    if skip(&relative) {
      continue;
    }
    let file_type = entry
      .file_type()
      .map_err(|error| format!("读取文件类型失败：{error}"))?;
    if file_type.is_symlink() {
      return Err(format!("包内不允许符号链接：{}", path.display()));
    }
    if file_type.is_dir() {
      collect(&path, base, out, skip)?;
    } else if file_type.is_file() {
      out.push(relative);
    }
  }
  Ok(())
}

fn relative_path(path: &Path, base: &Path) -> Result<String, String> {
  let relative = path
    .strip_prefix(base)
    .map_err(|error| format!("解析相对路径失败：{error}"))?;
  let mut segments: Vec<String> = Vec::new();
  for component in relative.components() {
    let segment = component
      .as_os_str()
      .to_str()
      .ok_or_else(|| format!("包内文件名必须是 UTF-8：{}", path.display()))?;
    segments.push(segment.to_string());
  }
  Ok(segments.join("/"))
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
      "lull-package-hash-{tag}-{}-{}",
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
  fn digest_is_stable_and_header_sensitive() {
    let Some(dir) = temp_dir("stable") else {
      return;
    };
    if std::fs::write(dir.join("index.html"), b"<html>ok</html>").is_err() {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let first = compute(b"test-package\0", &["id", "1.0.0"], &dir, |_| false);
    let second = compute(b"test-package\0", &["id", "1.0.0"], &dir, |_| false);
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
    let other = compute(b"test-package\0", &["id", "1.0.1"], &dir, |_| false).unwrap_or_default();
    assert_ne!(digest, other);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn skip_removes_file_and_subtree() {
    let Some(dir) = temp_dir("skip") else {
      return;
    };
    if std::fs::create_dir_all(dir.join(".git")).is_err()
      || std::fs::write(dir.join(".git/config"), b"x").is_err()
      || std::fs::write(dir.join("index.html"), b"ok").is_err()
    {
      let _ = std::fs::remove_dir_all(&dir);
      return;
    }
    let with_git = compute(b"test\0", &[], &dir, |_| false).unwrap_or_default();
    let without_git =
      compute(b"test\0", &[], &dir, |path| path.starts_with(".git")).unwrap_or_default();
    assert_ne!(with_git, without_git);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
