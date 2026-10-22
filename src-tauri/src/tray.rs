//! 系统托盘：创建菜单，并统一设置窗口的创建、复用、显示与切换逻辑。
use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::window_host::{self, ALL_WIDGETS, SETTINGS};

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
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

  // 工具菜单项由 widget 清单生成：新增工具只需加 manifest，不再改托盘代码。
  let mut tool_items: Vec<MenuItem<Wry>> = Vec::new();
  for spec in ALL_WIDGETS.iter().filter(|spec| spec.kind != SETTINGS.kind) {
    let kind = spec.kind;
    tool_items.push(MenuItem::with_id(
      app,
      format!("open-{kind}"),
      spec.name,
      true,
      None::<&str>,
    )?);
  }

  let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&toggle];
  for item in &tool_items {
    items.push(item);
  }
  items.push(&quit);
  let menu = Menu::with_items(app, &items)?;

  let mut builder = TrayIconBuilder::with_id("main-tray")
    .tooltip("Lull（左键显示/隐藏设置 / 右键菜单）")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "toggle-settings" => toggle_settings(app),
      "quit" => app.exit(0),
      id => {
        let Some(kind) = id.strip_prefix("open-") else {
          return;
        };
        if let Some(spec) = window_host::find(kind) {
          window_host::open_async(app, spec);
        }
      }
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
