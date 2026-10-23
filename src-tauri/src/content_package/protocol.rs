//! `lullcontent://` 自定义协议：只读服务用户内容包。
//!
//! 静态包仍在 `sandbox=""` 的 iframe 里运行；声明 `wallpaper.script` 的包改用
//! `allow-scripts`，因此 HTML 必须像插件协议一样注入 nonce 并下发 CSP。
//! 路径校验、`nosniff` 与 `no-store` 与插件协议共用 `resource` 实现。

use super::manifest::valid_id;
use super::store;
use crate::resource::{html_with_script_nonce, mime_for, nonce, safe_join};
use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, Wry};

type Failure = (StatusCode, String);

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  match serve(ctx.app_handle(), &request) {
    Ok(response) => response,
    Err((status, message)) => text_response(status, &message),
  }
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Failure> {
  let raw = request.uri().path().trim_start_matches('/');
  let mut parts = raw.splitn(2, '/');
  let id = parts.next().unwrap_or_default();
  let rest = parts.next().unwrap_or_default();
  if !valid_id(id) {
    return Err((StatusCode::BAD_REQUEST, "invalid content id".to_string()));
  }
  if rest.is_empty() {
    return Err((StatusCode::NOT_FOUND, "missing asset path".to_string()));
  }
  let dir = store::package_dir(app, id)
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
  let path = safe_join(&dir, rest).map_err(|error| {
    let status = if error.contains("逃逸") {
      StatusCode::FORBIDDEN
    } else {
      StatusCode::NOT_FOUND
    };
    (status, error)
  })?;
  let bytes = std::fs::read(&path)
    .map_err(|error| (StatusCode::NOT_FOUND, format!("读取内容资源失败：{error}")))?;
  let content_type = mime_for(&path);
  if content_type.starts_with("text/html") {
    return Ok(html_response(bytes, content_type));
  }
  Ok(binary_response(bytes, content_type))
}

fn html_response(bytes: Vec<u8>, content_type: &'static str) -> Response<Vec<u8>> {
  let nonce = nonce();
  let html = html_with_script_nonce(&String::from_utf8_lossy(&bytes), &nonce);
  let csp = scene_csp(&nonce);
  let mut response = binary_response(html.into_bytes(), content_type);
  set_header(&mut response, "Content-Security-Policy", &csp);
  response
}

/// 场景文档 CSP：脚本只允许包内源与本次 nonce，远程资源与嵌套 iframe 全禁。
fn scene_csp(nonce: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullcontent.localhost";
  #[cfg(not(windows))]
  let origin = "lullcontent://localhost";
  format!(
    "default-src {origin}; script-src {origin} 'nonce-{nonce}'; style-src {origin} 'unsafe-inline'; \
     img-src {origin} data: blob:; media-src {origin} data: blob:; font-src {origin} data:; \
     connect-src {origin}; worker-src {origin} blob:; frame-src 'none'; object-src 'none'; \
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

  #[test]
  fn scene_csp_allows_nonce_and_blocks_remote_assets() {
    let csp = scene_csp("abc123");
    assert!(csp.contains("script-src"));
    assert!(csp.contains("'nonce-abc123'"));
    assert!(csp.contains("frame-src 'none'"));
    assert!(csp.contains("connect-src "));
    assert!(!csp.contains("https://"));
    let script_src = csp
      .split("script-src ")
      .nth(1)
      .and_then(|rest| rest.split(';').next())
      .unwrap_or_default();
    assert!(!script_src.contains("'unsafe-inline'"));
  }

  #[test]
  fn html_response_injects_nonce_and_sets_csp() {
    let response = html_response(
      b"<html><script>window.x=1</script></html>".to_vec(),
      "text/html; charset=utf-8",
    );
    let csp = response
      .headers()
      .get("content-security-policy")
      .and_then(|value| value.to_str().ok())
      .unwrap_or_default();
    assert!(csp.contains("script-src"));
    let body = String::from_utf8_lossy(response.body());
    assert!(body.contains("<script nonce=\""));
  }
}
