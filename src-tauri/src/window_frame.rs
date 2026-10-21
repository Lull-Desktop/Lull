//! 无边框窗口的原子位置 / 尺寸更新。
//!
//! 播放器左侧曲库展开时，窗口需要向左移动并同步变宽；如果分别调用
//! `set_size` / `set_position`，DWM 会在两次原生调用之间先绘制一帧旧位置，
//! 表现为闪烁。Windows 下用一次 `SetWindowPos` 同时提交位置和尺寸。

use tauri::Window;

/// 原子设置窗口的屏幕坐标与物理尺寸。
#[tauri::command]
pub fn window_set_frame(
  window: Window,
  x: i32,
  y: i32,
  width: u32,
  height: u32,
) -> Result<(), String> {
  apply_frame(&window, x, y, width, height)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_frame(window: &Window, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
  use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

  let hwnd = window.hwnd().map_err(|error| error.to_string())?;
  let width = i32::try_from(width).map_err(|_| "窗口宽度超出范围".to_string())?;
  let height = i32::try_from(height).map_err(|_| "窗口高度超出范围".to_string())?;
  // SAFETY: hwnd 来自仍然存活的 Tauri 窗口；SWP_NOZORDER / SWP_NOACTIVATE
  // 保持层级和焦点不变，只提交一次位置 + 尺寸。
  unsafe {
    SetWindowPos(
      hwnd,
      None,
      x,
      y,
      width,
      height,
      SWP_NOZORDER | SWP_NOACTIVATE,
    )
  }
  .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn apply_frame(window: &Window, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
  window
    .set_size(tauri::PhysicalSize::new(width, height))
    .map_err(|error| error.to_string())?;
  window
    .set_position(tauri::PhysicalPosition::new(x, y))
    .map_err(|error| error.to_string())
}
