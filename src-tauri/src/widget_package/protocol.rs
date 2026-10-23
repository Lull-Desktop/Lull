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
use crate::resource::{html_with_script_nonce, mime_for, nonce, safe_join};
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
    store::resolve_dir(app, id).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
  let manifest = store::load_manifest(app, id).map_err(|error| (StatusCode::NOT_FOUND, error))?;
  let granted = store::granted(app, id);
  // 点号路径（含旁路摘要锁、.git 等）不提供服务，避免摘要范围与可服务范围不一致。
  if rest.split('/').any(|segment| segment.starts_with('.')) {
    return Err((StatusCode::NOT_FOUND, "resource not found".to_string()));
  }
  let relative = if rest.is_empty() || rest.ends_with('/') {
    manifest.entry.clone()
  } else {
    rest.to_string()
  };
  let path = safe_join(&dir, &relative).map_err(|error| {
    let status = if error.contains("逃逸") {
      StatusCode::FORBIDDEN
    } else {
      StatusCode::NOT_FOUND
    };
    (status, error)
  })?;
  let bytes = std::fs::read(&path)
    .map_err(|error| (StatusCode::NOT_FOUND, format!("读取插件资源失败：{error}")))?;
  let content_type = mime_for(&path);
  if content_type.starts_with("text/html") {
    return Ok(html_response(&manifest, bytes, content_type, &granted));
  }
  Ok(binary_response(bytes, content_type))
}

fn html_response(
  manifest: &PackageManifest,
  bytes: Vec<u8>,
  content_type: &'static str,
  granted: &[String],
) -> Response<Vec<u8>> {
  let nonce = nonce();
  // 只给 HTML 中已有的 <script> 打 nonce；插件不应自带 nonce。
  let html = html_with_script_nonce(&String::from_utf8_lossy(&bytes), &nonce);
  let csp = plugin_csp(manifest, &nonce, granted);
  let mut response = binary_response(html.into_bytes(), content_type);
  set_header(&mut response, "Content-Security-Policy", &csp);
  response
}

fn plugin_csp(manifest: &PackageManifest, nonce: &str, granted: &[String]) -> String {
  #[cfg(windows)]
  let origin = "http://lullwidget.localhost";
  #[cfg(not(windows))]
  let origin = "lullwidget://localhost";
  let mut connect = origin.to_string();
  // 只有实际授予 widget.network 才放开清单声明的源；撤销后下一次响应即收紧。
  if granted.iter().any(|capability| capability == "widget.network") {
    for source in &manifest.network {
      connect.push(' ');
      connect.push_str(source);
    }
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
      icon: None,
      lifecycle: "background".to_string(),
    }
  }

  #[test]
  fn csp_contains_origin_nonce_and_network() {
    let csp = plugin_csp(&manifest(), "abc", &["widget.network".to_string()]);
    assert!(csp.contains("script-src"));
    assert!(csp.contains("'nonce-abc'"));
    assert!(csp.contains("https://api.example.com"));
    assert!(csp.contains("frame-src 'none'"));
  }

  #[test]
  fn csp_drops_network_when_capability_revoked() {
    let csp = plugin_csp(&manifest(), "abc", &[]);
    assert!(!csp.contains("https://api.example.com"));
  }
}
