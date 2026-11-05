//! `lullgame://` 自定义协议：只读服务游戏包，并按包下发 CSP。
//!
//! 安全基线沿用 `lullwidget://`：路径只能是包内相对路径，拒绝 `..`、反斜杠、
//! 点号路径与绝对路径；HTML 注入 nonce 后才允许脚本；网络源只在
//! `game.network` 已授权时进 CSP。

use crate::resource::{html_with_script_nonce, mime_for, nonce, safe_join};
use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, Wry};

use super::manifest::{self, GameManifest};
use super::store;

type Failure = (StatusCode, String);

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  match serve(ctx.app_handle(), &request) {
    Ok(response) => response,
    Err((status, message)) => text_response(status, &message),
  }
}

#[must_use]
pub fn entry_url(id: &str, entry: &str) -> String {
  format!("{}/{}/{}", origin(), id, entry.trim_start_matches('/'))
}

#[cfg(windows)]
fn origin() -> &'static str {
  "http://lullgame.localhost"
}

#[cfg(not(windows))]
fn origin() -> &'static str {
  "lullgame://localhost"
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Failure> {
  let raw = request.uri().path().trim_start_matches('/');
  if raw.is_empty() {
    return Err((StatusCode::NOT_FOUND, "missing game id".to_string()));
  }
  let mut parts = raw.splitn(2, '/');
  let id = parts.next().unwrap_or_default();
  let rest = parts.next().unwrap_or_default();
  if !manifest::valid_id(id) {
    return Err((StatusCode::BAD_REQUEST, "invalid game id".to_string()));
  }
  let dir =
    store::package_dir(app, id).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
  let manifest =
    GameManifest::load(&dir, id).map_err(|error| (StatusCode::NOT_FOUND, error.message))?;
  if rest.split('/').any(|segment| segment.starts_with('.')) {
    return Err((StatusCode::NOT_FOUND, "resource not found".to_string()));
  }
  let relative = if rest.is_empty() || rest.ends_with('/') {
    manifest.entry.authority.clone()
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
    .map_err(|error| (StatusCode::NOT_FOUND, format!("读取游戏资源失败：{error}")))?;
  let content_type = mime_for(&path);
  if content_type.starts_with("text/html") {
    let granted = store::granted(app, id);
    return Ok(html_response(&manifest, bytes, content_type, &granted));
  }
  Ok(binary_response(bytes, content_type))
}

fn html_response(
  manifest: &GameManifest,
  bytes: Vec<u8>,
  content_type: &'static str,
  granted: &[String],
) -> Response<Vec<u8>> {
  let nonce = nonce();
  let html = html_with_script_nonce(&String::from_utf8_lossy(&bytes), &nonce);
  let csp = game_csp(manifest, &nonce, granted);
  let mut response = binary_response(html.into_bytes(), content_type);
  set_header(&mut response, "Content-Security-Policy", &csp);
  response
}

fn game_csp(manifest: &GameManifest, nonce: &str, granted: &[String]) -> String {
  let origin = origin();
  let network = if granted.iter().any(|item| item == "game.network") {
    manifest.network.join(" ")
  } else {
    String::new()
  };
  let net = if network.is_empty() {
    String::new()
  } else {
    format!(" {network}")
  };
  format!(
    "default-src {origin}; script-src {origin} 'nonce-{nonce}' 'wasm-unsafe-eval'; \
     style-src {origin} 'unsafe-inline'; img-src {origin} data: blob:{net}; \
     media-src {origin} data: blob:{net}; font-src {origin} data:{net}; \
     connect-src {origin}{net}; worker-src {origin} blob:; frame-src 'none'; \
     object-src 'none'; base-uri 'none'; form-action 'none'"
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

  fn manifest(network: Vec<String>) -> GameManifest {
    let value = serde_json::json!({
      "schemaVersion": 1,
      "type": "game",
      "id": "demo.game",
      "name": "Demo",
      "version": "1.0.0",
      "license": "MIT",
      "hostApi": 1,
      "entry": { "authority": "authority/index.html" },
      "runtime": { "authority": "host-tick" },
      "display": { "policy": "shared" },
      "capabilities": ["game.state.read", "game.network"],
      "commands": { "plant.seed": {} },
      "state": { "schemaVersion": 1 },
      "network": network
    });
    let manifest: GameManifest = serde_json::from_value(value).expect("manifest");
    manifest.validate().expect("validate");
    manifest
  }

  #[test]
  fn entry_url_is_package_scoped() {
    let url = entry_url("demo.game", "authority/index.html");
    assert!(url.contains("/demo.game/authority/index.html"));
  }

  #[test]
  fn csp_contains_nonce_and_origin() {
    let csp = game_csp(&manifest(Vec::new()), "abc", &[]);
    assert!(csp.contains("'nonce-abc'"));
    assert!(csp.contains("wasm-unsafe-eval"));
    assert!(csp.contains("frame-src 'none'"));
    assert!(!csp.contains("https://example.com"));
  }

  #[test]
  fn network_requires_grant() {
    let manifest = manifest(vec!["https://example.com".to_string()]);
    let without = game_csp(&manifest, "abc", &[]);
    assert!(!without.contains("https://example.com"));
    let with = game_csp(&manifest, "abc", &["game.network".to_string()]);
    assert!(with.contains("https://example.com"));
  }
}
