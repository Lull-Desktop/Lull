//! `lullwidget://` 自定义协议：只读服务用户插件包，并按插件生成 CSP。
//!
//! 安全基线：
//! - 路径只允许包内相对路径，拒绝 `..`、反斜杠、百分号编码与绝对路径；
//! - 规范化后必须仍在包目录内（防符号链接逃逸）；
//! - HTML 注入 nonce 后才能执行脚本；插件文档的 CSP 不依赖 opaque origin 的 `'self'`；
//! - 返回 `Access-Control-Allow-Origin: *`，让不透明源 iframe 能加载 ES module。

use super::manifest::valid_id;
use super::manifest::PackageManifest;
use super::store;
use std::path::{Path, PathBuf};
use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, Wry};

type Failure = (StatusCode, String);

/// 注册到 Tauri 的协议处理器。
pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  match serve(ctx.app_handle(), &request) {
    Ok(response) => response,
    Err((status, message)) => text_response(status, &message),
  }
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Failure> {
  let raw = request.uri().path().trim_start_matches('/');
  if raw.is_empty() {
    return Err((StatusCode::NOT_FOUND, "missing widget id".to_string()));
  }
  let mut parts = raw.splitn(2, '/');
  let id = parts.next().unwrap_or_default();
  let rest = parts.next().unwrap_or_default();
  if !valid_id(id) {
    return Err((StatusCode::BAD_REQUEST, "invalid widget id".to_string()));
  }
  let dir =
    store::package_dir(app, id).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
  let manifest = PackageManifest::load(&dir, id).map_err(|error| (StatusCode::NOT_FOUND, error))?;
  let relative = if rest.is_empty() || rest.ends_with('/') {
    manifest.entry.clone()
  } else {
    rest.to_string()
  };
  let path = safe_join(&dir, &relative)?;
  let bytes = std::fs::read(&path)
    .map_err(|error| (StatusCode::NOT_FOUND, format!("读取插件资源失败：{error}")))?;
  let content_type = mime_for(&path);
  if content_type.starts_with("text/html") {
    return Ok(html_response(&manifest, bytes, content_type));
  }
  Ok(binary_response(bytes, content_type))
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, Failure> {
  if relative.starts_with('/')
    || relative.contains('\\')
    || relative.contains('%')
    || relative.contains('\0')
  {
    return Err((StatusCode::BAD_REQUEST, "unsafe path".to_string()));
  }
  let mut path = root.to_path_buf();
  for segment in relative.split('/') {
    if segment.is_empty() || segment == "." || segment == ".." {
      return Err((StatusCode::BAD_REQUEST, "unsafe path".to_string()));
    }
    path.push(segment);
  }
  let canonical_root =
    std::fs::canonicalize(root).map_err(|error| (StatusCode::NOT_FOUND, error.to_string()))?;
  let canonical =
    std::fs::canonicalize(&path).map_err(|error| (StatusCode::NOT_FOUND, error.to_string()))?;
  if !canonical.starts_with(&canonical_root) {
    return Err((
      StatusCode::FORBIDDEN,
      "path escaped widget root".to_string(),
    ));
  }
  Ok(canonical)
}

fn html_response(
  manifest: &PackageManifest,
  bytes: Vec<u8>,
  content_type: &'static str,
) -> Response<Vec<u8>> {
  let nonce = nonce();
  let html = String::from_utf8_lossy(&bytes);
  // 只给 HTML 中已有的 <script> 打 nonce；插件不应自带 nonce。
  let html = html.replace("<script", &format!("<script nonce=\"{nonce}\""));
  let csp = plugin_csp(manifest, &nonce);
  let mut response = binary_response(html.into_bytes(), content_type);
  set_header(&mut response, "Content-Security-Policy", &csp);
  response
}

fn plugin_csp(manifest: &PackageManifest, nonce: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullwidget.localhost";
  #[cfg(not(windows))]
  let origin = "lullwidget://localhost";
  let mut connect = origin.to_string();
  for source in &manifest.network {
    connect.push(' ');
    connect.push_str(source);
  }
  format!(
    "default-src {origin}; script-src {origin} 'nonce-{nonce}'; style-src {origin} 'unsafe-inline'; \
     img-src {origin} data: blob:; media-src {origin} blob: data:; font-src {origin} data:; \
     connect-src {connect}; worker-src {origin} blob:; frame-src 'none'; object-src 'none'; \
     base-uri 'none'; form-action 'none'"
  )
}

fn binary_response(bytes: Vec<u8>, content_type: &'static str) -> Response<Vec<u8>> {
  let mut response = Response::new(bytes);
  *response.status_mut() = StatusCode::OK;
  set_header(&mut response, header::CONTENT_TYPE.as_str(), content_type);
  set_header(&mut response, "Access-Control-Allow-Origin", "*");
  set_header(
    &mut response,
    "Cross-Origin-Resource-Policy",
    "cross-origin",
  );
  set_header(&mut response, "X-Content-Type-Options", "nosniff");
  set_header(&mut response, "Cache-Control", "no-store");
  response
}

fn text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
  let mut response = Response::new(message.as_bytes().to_vec());
  *response.status_mut() = status;
  set_header(
    &mut response,
    header::CONTENT_TYPE.as_str(),
    "text/plain; charset=utf-8",
  );
  set_header(&mut response, "Access-Control-Allow-Origin", "*");
  set_header(&mut response, "X-Content-Type-Options", "nosniff");
  response
}

fn set_header(response: &mut Response<Vec<u8>>, name: &str, value: &str) {
  let Ok(name) = header::HeaderName::from_bytes(name.as_bytes()) else {
    return;
  };
  let Ok(value) = HeaderValue::from_str(value) else {
    return;
  };
  response.headers_mut().insert(name, value);
}

fn mime_for(path: &Path) -> &'static str {
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

/// CSP nonce 只用于同一响应内的脚本；不承担密码学用途，但要求不可预测。
fn nonce() -> String {
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

#[cfg(test)]
mod tests {
  use super::*;

  fn manifest() -> PackageManifest {
    PackageManifest {
      schema_version: 2,
      kind: "widget".to_string(),
      id: "community-pomodoro".to_string(),
      name: "番茄钟".to_string(),
      version: "1.0.0".to_string(),
      description: None,
      author: None,
      license: None,
      builtin: false,
      host_api: 1,
      entry: "index.html".to_string(),
      capabilities: vec!["widget.network".to_string()],
      window: Default::default(),
      network: vec!["https://api.example.com".to_string()],
    }
  }

  #[test]
  fn csp_contains_origin_nonce_and_network() {
    let csp = plugin_csp(&manifest(), "abc");
    assert!(csp.contains("script-src"));
    assert!(csp.contains("'nonce-abc'"));
    assert!(csp.contains("https://api.example.com"));
    assert!(csp.contains("frame-src 'none'"));
  }

  #[test]
  fn mime_covers_plugin_assets() {
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
  fn safe_join_rejects_traversal_and_allows_package_files() {
    let root = std::env::temp_dir().join(format!("lull-widget-test-{}", nonce()));
    if std::fs::create_dir_all(&root).is_err() {
      return;
    }
    if std::fs::write(root.join("index.html"), b"ok").is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    assert!(safe_join(&root, "../secret").is_err());
    assert!(safe_join(&root, "a/../../b").is_err());
    assert!(safe_join(&root, "a%2e%2e/b").is_err());
    assert!(safe_join(&root, "a\\b").is_err());
    assert!(safe_join(&root, "index.html").is_ok());
    let _ = std::fs::remove_dir_all(&root);
  }
}
