//! 系统托盘：创建菜单，并统一设置窗口的创建、复用、显示与切换逻辑。
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::window_host;

pub fn show_settings(app: &AppHandle) {
  // 运行时建窗统一走非主线程路径（见 window_host::open_async），避免 WebView2 卡死。
  window_host::open_async(app, &window_host::SETTINGS);
}

pub fn toggle_settings(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("settings") {
    if window.is_visible().unwrap_or(false) {
      let _ = window.hide();
      return;
    }
  }
  show_settings(app);
}

pub fn init(app: &tauri::App) -> tauri::Result<()> {
  let toggle = MenuItem::with_id(app, "toggle-settings", "显示/隐藏设置", true, None::<&str>)?;
  let player = MenuItem::with_id(app, "open-player", "播放器", true, None::<&str>)?;
  let pomodoro = MenuItem::with_id(app, "open-pomodoro", "番茄钟", true, None::<&str>)?;
  let noise = MenuItem::with_id(app, "open-noise", "白噪音", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&toggle, &player, &pomodoro, &noise, &quit])?;

  let mut builder = TrayIconBuilder::with_id("main-tray")
    .tooltip("Lull（左键显示/隐藏设置 / 右键菜单）")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "toggle-settings" => toggle_settings(app),
      "open-player" => window_host::open_async(app, &window_host::PLAYER),
      "open-pomodoro" => window_host::open_async(app, &window_host::POMODORO),
      "open-noise" => window_host::open_async(app, &window_host::NOISE),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_settings(tray.app_handle());
      }
    });
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  builder.build(app)?;
  Ok(())
}
