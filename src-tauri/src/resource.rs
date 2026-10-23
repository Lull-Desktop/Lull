//! 静态资源服务的公共工具：路径校验与 MIME 推断。
//!
//! 内容包（`lullcontent://`）与插件包（`lullwidget://`）都从用户目录读文件，
//! 路径校验必须是**同一份实现**——任何一处放宽都是目录逃逸。

use std::path::{Path, PathBuf};

/// 把包内相对路径解析为可读的绝对路径。
///
/// 拒绝：绝对路径、反斜杠、百分号编码、`\0`、空段、`.`、`..`；
/// 解析后再 `canonicalize` 校验是否仍在 `root` 内（防符号链接逃逸）。
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
  if relative.starts_with('/')
    || relative.contains('\\')
    || relative.contains('%')
    || relative.contains('\0')
  {
    return Err("不安全的相对路径".to_string());
  }
  let mut path = root.to_path_buf();
  for segment in relative.split('/') {
    if segment.is_empty() || segment == "." || segment == ".." {
      return Err("不安全的相对路径".to_string());
    }
    path.push(segment);
  }
  let canonical_root =
    std::fs::canonicalize(root).map_err(|error| format!("内容目录不可用：{error}"))?;
  let canonical = std::fs::canonicalize(&path)
    .map_err(|error| format!("资源不存在：{error}"))?;
  if !canonical.starts_with(&canonical_root) {
    return Err("路径逃逸出包目录".to_string());
  }
  Ok(canonical)
}

/// 一次性 CSP nonce：只要求同一响应内不可预测，不承担密码学用途。
pub fn nonce() -> String {
  use std::collections::hash_map::RandomState;
  use std::hash::{BuildHasher, Hasher};

  let mut hasher = RandomState::new().build_hasher();
  if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
    hasher.write_u64(now.as_secs());
    hasher.write_u32(now.subsec_nanos());
  }
  format!(
    "{:016x}{:016x}",
    hasher.finish(),
    RandomState::new().build_hasher().finish()
  )
}

/// 给 HTML 里已有的 `<script` 注入 nonce；插件/场景作者不应自带 nonce。
/// 内联事件处理器（`onclick=`）不在 nonce 覆盖范围，CSP 会拒绝。
pub fn html_with_script_nonce(html: &str, nonce: &str) -> String {
  html.replace("<script", &format!("<script nonce=\"{nonce}\""))
}

/// 按扩展名推断 MIME；未知类型给 `application/octet-stream`。
pub fn mime_for(path: &Path) -> &'static str {
  match path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(str::to_ascii_lowercase)
    .as_deref()
  {
    Some("html") | Some("htm") => "text/html; charset=utf-8",
    Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
    Some("css") => "text/css; charset=utf-8",
    Some("json") | Some("map") => "application/json",
    Some("svg") => "image/svg+xml",
    Some("png") => "image/png",
    Some("jpg") | Some("jpeg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    Some("avif") => "image/avif",
    Some("ico") => "image/x-icon",
    Some("woff2") => "font/woff2",
    Some("woff") => "font/woff",
    Some("ttf") => "font/ttf",
    Some("otf") => "font/otf",
    Some("wasm") => "application/wasm",
    Some("mp3") => "audio/mpeg",
    Some("wav") => "audio/wav",
    Some("ogg") | Some("oga") => "audio/ogg",
    Some("m4a") | Some("aac") => "audio/mp4",
    Some("webm") => "video/webm",
    Some("txt") => "text/plain; charset=utf-8",
    _ => "application/octet-stream",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-resource-{tag}-{}-{}",
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
  fn safe_join_rejects_traversal_and_allows_package_files() {
    let Some(root) = temp_dir("join") else {
      return;
    };
    if std::fs::write(root.join("index.html"), b"ok").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    assert!(safe_join(&root, "../secret").is_err());
    assert!(safe_join(&root, "a/../../b").is_err());
    assert!(safe_join(&root, "a%2e%2e/b").is_err());
    assert!(safe_join(&root, "a\\b").is_err());
    assert!(safe_join(&root, "index.html").is_ok());
    assert!(safe_join(&root, "missing.html").is_err());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn mime_covers_package_assets() {
    assert!(mime_for(Path::new("index.html")).starts_with("text/html"));
    assert!(mime_for(Path::new("main.js")).starts_with("text/javascript"));
    assert_eq!(mime_for(Path::new("x.wasm")), "application/wasm");
    assert_eq!(mime_for(Path::new("x.bin")), "application/octet-stream");
  }

  #[test]
  fn nonce_is_hex_and_unique() {
    let first = nonce();
    let second = nonce();
    assert_eq!(first.len(), 32);
    assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_ne!(first, second);
  }

  #[test]
  fn script_tags_get_the_nonce() {
    let html = html_with_script_nonce(
      "<html><script src=\"./main.js\"></script><script>1</script></html>",
      "abc",
    );
    assert_eq!(html.matches("<script nonce=\"abc\"").count(), 2);
  }
}
