//! 系统托盘：创建菜单，并统一设置窗口的创建、复用、显示与切换逻辑。
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::window_host::{self, WidgetSpec, ALL_WIDGETS, SETTINGS};

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

/// 重建托盘菜单：设置子菜单（含窗口入口）+ 功能槽位 + 已启用扩展 + 退出。
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
    // tooltip 是同类文案：切语言后只重建菜单会让它停在旧语言。
    if let Err(error) = tray.set_tooltip(Some(crate::i18n::t("tray_tooltip"))) {
      eprintln!("[tray] 设置提示语失败：{error}");
    }
  }
}

/// 窗口入口的展示名：优先取 `widget_<kind>_name` 文案键
/// （与设置页 `widgets/registry.ts` 的 `DISPLAY_NAME` 是同一批键），
/// 没有对应文案时回退清单里的 `name`，第三方新窗口不必先补翻译才能显示。
fn window_label(spec: &WidgetSpec) -> String {
  let key = format!("widget_{}_name", spec.kind.replace('-', "_"));
  if crate::i18n::has(&key) {
    crate::i18n::t(&key)
  } else {
    spec.name.to_string()
  }
}

/// 归入「设置」子菜单的窗口入口：除设置窗自身以外的全部内置窗口
/// （壁纸库 / 音乐库 / 白噪音库……，以后新增的工具窗同理）。
///
/// 顺序沿用清单的 `order`（`ALL_WIDGETS` 已由 build.rs 排好序）。
fn window_entries() -> impl Iterator<Item = &'static WidgetSpec> {
  ALL_WIDGETS
    .iter()
    .copied()
    .filter(|spec| spec.kind != SETTINGS.kind)
}

/// 构建「设置」子菜单：显示/隐藏设置 + 分隔线 + 各窗口入口。
///
/// 窗口入口不再平铺在一级菜单里，托盘右键的层级保持为
/// 「设置 ▸ 壁纸库 / 音乐库 / 白噪音库」。
fn build_settings_menu(app: &AppHandle, toggle: &MenuItem<Wry>) -> tauri::Result<Submenu<Wry>> {
  let menu = Submenu::with_id(app, "settings", crate::i18n::t("tray_settings"), true)?;
  menu.append(toggle)?;

  let windows = window_entries()
    .map(|spec| {
      MenuItem::with_id(
        app,
        format!("open-{}", spec.kind),
        window_label(spec),
        true,
        None::<&str>,
      )
    })
    .collect::<tauri::Result<Vec<_>>>()?;
  if !windows.is_empty() {
    // 分隔线把「显隐设置」与「打开各窗口」分成两组，避免误点。
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for item in &windows {
      menu.append(item)?;
    }
  }
  Ok(menu)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
  let toggle = MenuItem::with_id(
    app,
    "toggle-settings",
    crate::i18n::t("tray_toggle_settings"),
    true,
    None::<&str>,
  )?;
  let quit = MenuItem::with_id(app, "quit", crate::i18n::t("tray_quit"), true, None::<&str>)?;

  // 一级菜单只剩「设置」子菜单 + 功能槽位 + 扩展 + 退出；
  // 窗口入口收进子菜单，事件 id 仍是 `open-<kind>`，处理器不用改。
  let settings_menu = build_settings_menu(app, &toggle)?;

  // 功能槽位与「设置」子菜单同级：每个 Slot 只出现一次，避免 10 个播放器塞满托盘。
  let mut tool_items: Vec<MenuItem<Wry>> = Vec::new();
  let slots = crate::extension::slots::list(app);
  for slot in slots {
    let has_selected = slot.selected.as_ref().is_some_and(|id| {
      slot
        .providers
        .iter()
        .any(|provider| &provider.id == id && provider.eligible)
    });
    if !has_selected {
      continue;
    }
    tool_items.push(MenuItem::with_id(
      app,
      format!("slot-{}", slot.id),
      &slot.name,
      true,
      None::<&str>,
    )?);
  }

  // 官方非 Provider 兼容项 + 第三方普通 Widget 仍收在「扩展」子菜单。
  let packages = crate::widget_package::store::list(app);
  let mut official_plain = packages
    .iter()
    .filter(|package| {
      package.enabled
        && package.origin == "bundled"
        && crate::extension::slots::defs::slot_for_provides(&package.provides).is_none()
    })
    .collect::<Vec<_>>();
  official_plain.sort_by(|left, right| {
    left
      .order
      .total_cmp(&right.order)
      .then_with(|| left.id.cmp(&right.id))
  });
  for package in official_plain {
    tool_items.push(MenuItem::with_id(
      app,
      format!("open-ext-{}", package.id),
      &package.name,
      true,
      None::<&str>,
    )?);
  }

  let enabled = packages
    .into_iter()
    .filter(|package| {
      package.enabled
        && package.origin != "bundled"
        && crate::extension::slots::defs::slot_for_provides(&package.provides).is_none()
    })
    .collect::<Vec<_>>();
  let submenu = if enabled.is_empty() {
    None
  } else {
    let menu = Submenu::with_id(app, "extensions", crate::i18n::t("tray_extensions"), true)?;
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

  // 一级菜单：设置（子菜单）→ 功能槽位 / 官方扩展 → 扩展（子菜单）→ 退出。
  let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&settings_menu];
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
    .tooltip(crate::i18n::t("tray_tooltip"))
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "toggle-settings" => toggle_settings(app),
      "quit" => app.exit(0),
      id => {
        if let Some(slot_id) = id.strip_prefix("slot-") {
          let app = app.clone();
          let slot_id = slot_id.to_string();
          tauri::async_runtime::spawn(async move {
            let _ = crate::extension::extensions_slot_activate(app, slot_id).await;
          });
          return;
        }
        if let Some(plugin_id) = id.strip_prefix("open-ext-") {
          let app = app.clone();
          let plugin_id = plugin_id.to_string();
          tauri::async_runtime::spawn(async move {
            let _ = crate::widget_package::open(app, plugin_id).await;
          });
          return;
        }
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

#[cfg(test)]
mod tests {
  use super::*;

  /// 窗口入口必须覆盖全部内置库窗口，且不能把设置窗自己也当成入口。
  #[test]
  fn window_entries_exclude_settings_and_keep_library_windows() {
    let entries = window_entries().collect::<Vec<_>>();
    assert!(
      entries.iter().all(|spec| spec.kind != SETTINGS.kind),
      "设置窗不应出现在窗口入口里"
    );
    for kind in ["backdrop", "library", "noise-library"] {
      assert!(
        entries.iter().any(|spec| spec.kind == kind),
        "缺少窗口入口：{kind}"
      );
    }
  }

  /// 入口按清单 order 升序，保证子菜单里三个库窗口的排列稳定。
  #[test]
  fn window_entries_follow_manifest_order() {
    let kinds = window_entries().map(|spec| spec.kind).collect::<Vec<_>>();
    assert_eq!(kinds, ["backdrop", "library", "noise-library"]);
  }

  /// 每个窗口入口都要有 `widget_<kind>_name` 文案：缺了就会在英文界面漏出
  /// 清单里的中文名（`t()` 查不到时返回键名，`window_label` 会回退到 `spec.name`）。
  #[test]
  fn every_window_entry_has_a_translated_label() {
    for spec in window_entries() {
      let key = format!("widget_{}_name", spec.kind.replace('-', "_"));
      assert!(
        crate::i18n::has(&key),
        "窗口 {} 缺少文案键 {key}",
        spec.kind
      );
      let label = window_label(spec);
      assert_ne!(label, key, "{} 的文案键没有命中", spec.kind);
      assert!(!label.trim().is_empty(), "{} 的展示名为空", spec.kind);
    }
  }
}
