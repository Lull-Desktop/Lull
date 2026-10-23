//! `lullcontent://` 自定义协议：只读服务用户内容包。
//!
//! 内容包在 `sandbox=""` 的 iframe 里运行（不执行 JS、无 Tauri IPC），
//! 所以这里不需要像插件那样注入 nonce / CSP；但路径校验、`nosniff`
//! 与 `no-store` 必须和插件协议一致。

use super::manifest::valid_id;
use super::store;
use crate::resource::{mime_for, safe_join};
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
  Ok(binary_response(bytes, mime_for(&path)))
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
