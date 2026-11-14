//! 壁纸窗访问音频响应的 Tauri 命令入口。
//!
//! 只有 `wallpaper-*` 窗口可以订阅；iframe 场景没有 Tauri IPC，因此第三方内容
//! 只能通过场景桥读取宿主裁剪后的帧，无法直接调用这些命令。

use tauri::{Manager, WebviewWindow};

use super::model::{AudioConnectRequest, AudioConnectResult, WALLPAPER_LABEL_PREFIX};

#[tauri::command]
pub fn audio_connect(
  window: WebviewWindow,
  request: AudioConnectRequest,
) -> Result<AudioConnectResult, String> {
  let label = window.label().to_string();
  if !label.starts_with(WALLPAPER_LABEL_PREFIX) {
    return Err("只有壁纸窗口可以订阅音频响应".to_string());
  }
  Ok(super::connect(
    &window.app_handle().clone(),
    &label,
    request,
  ))
}

#[tauri::command]
pub fn audio_disconnect(window: WebviewWindow) {
  let label = window.label().to_string();
  if !label.starts_with(WALLPAPER_LABEL_PREFIX) {
    return;
  }
  super::disconnect(&window.app_handle().clone(), &label);
}

#[cfg(test)]
mod tests {
  #[test]
  fn wallpaper_prefix_is_the_only_accepted_label_shape() {
    use super::WALLPAPER_LABEL_PREFIX;
    assert!("wallpaper-0".starts_with(WALLPAPER_LABEL_PREFIX));
    assert!("wallpaper-12".starts_with(WALLPAPER_LABEL_PREFIX));
    assert!(!"settings".starts_with(WALLPAPER_LABEL_PREFIX));
    assert!(!"media-engine".starts_with(WALLPAPER_LABEL_PREFIX));
  }
}
