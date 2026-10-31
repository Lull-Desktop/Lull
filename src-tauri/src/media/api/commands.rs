//! Media API 的 Tauri 命令入口。
//!
//! P1 只对设置窗开放资料库方法；播放器/白噪音在 P2 再获得权限。
//! 真正的权限检查放在 Rust 侧，前端 SDK 的 has() 只负责体验。

use tauri::{Manager, WebviewWindow};

use super::errors::MediaError;
use super::protocol::{MediaRequest, MediaResponse, PROTOCOL_VERSION};
use crate::media::library;

fn ensure_host(window: &WebviewWindow) -> Result<(), MediaError> {
  if window.label() == "settings" {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口没有媒体资料库权限",
    ))
  }
}

#[tauri::command]
pub async fn media_call(window: WebviewWindow, request: MediaRequest) -> MediaResponse {
  let request_id = request.request_id.clone();
  if request.protocol != PROTOCOL_VERSION {
    return MediaResponse::error(
      &request_id,
      &MediaError::new("protocol.unsupported", "不支持的媒体协议版本"),
      0,
    );
  }
  if let Err(error) = ensure_host(&window) {
    return MediaResponse::error(&request_id, &error, 0);
  }

  library::call_media(
    window.app_handle().clone(),
    &request_id,
    &request.namespace,
    &request.method,
    &request.args,
  )
  .await
}
