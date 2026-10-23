//! 系统托盘：创建菜单，并统一设置窗口的创建、复用、显示与切换逻辑。
use tauri::menu::{IsMenuItem, Menu, MenuItem, Submenu};
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

/// 重建托盘菜单：内置工具 + 已启用扩展 + 退出。
///
/// 扩展启用/停用/安装/卸载后由 `extension::emit_changed` 调用；失败时保留旧菜单。
pub fn refresh(app: &AppHandle) {
  let Ok(menu) = build_menu(app) else {
    eprintln!("[tray] 重建菜单失败，保留旧菜单");
    return;
  };
  if let Some(tray) = app.tray_by_id("main-tray") {
    if let Err(error) = tray.set_menu(Some(menu)) {
      eprintln!("[tray] 设置菜单失败：{error}");
    }
  }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
  let toggle = MenuItem::with_id(app, "toggle-settings", "显示/隐藏设置", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

  // 工具菜单项由 widget 清单生成：新增内置工具只需加 manifest，不再改托盘代码。
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

  // 只列已启用的第三方扩展；未启用时省略子菜单。
  let enabled = crate::widget_package::store::list(app)
    .into_iter()
    .filter(|package| package.enabled)
    .collect::<Vec<_>>();
  let submenu = if enabled.is_empty() {
    None
  } else {
    let menu = Submenu::with_id(app, "extensions", "扩展", true)?;
    for package in &enabled {
      let item = MenuItem::with_id(
        app,
        format!("ext-{}", package.id),
        &package.name,
        true,
        None::<&str>,
      )?;
      menu.append(&item)?;
    }
    Some(menu)
  };

  let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&toggle];
  for item in &tool_items {
    items.push(item);
  }
  if let Some(menu) = &submenu {
    items.push(menu);
  }
  items.push(&quit);
  Menu::with_items(app, &items)
}

pub fn init(app: &tauri::App) -> tauri::Result<()> {
  let menu = build_menu(app.handle())?;

  let mut builder = TrayIconBuilder::with_id("main-tray")
    .tooltip("Lull（左键显示/隐藏设置 / 右键菜单）")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "toggle-settings" => toggle_settings(app),
      "quit" => app.exit(0),
      id => {
        if let Some(plugin_id) = id.strip_prefix("ext-") {
          let app = app.clone();
          let plugin_id = plugin_id.to_string();
          tauri::async_runtime::spawn(async move {
            let _ = crate::widget_package::open(app, plugin_id).await;
          });
          return;
        }
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
