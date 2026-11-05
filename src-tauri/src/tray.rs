//! 系统托盘：创建菜单，并统一设置窗口的创建、复用、显示与切换逻辑。
use std::collections::BTreeSet;

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::extension::ExtensionCategory;
use crate::game_package::manifest::{GameController, GameControllerKind};
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
  // 托盘尚未创建（启动早期/测试）时不用白建菜单。
  if app.tray_by_id("main-tray").is_none() {
    return;
  }
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

/// 从任意线程安全地重建托盘菜单（游戏启停、壁纸切换游戏时调用）。
pub fn refresh_async(app: &AppHandle) {
  let target = app.clone();
  if let Err(error) = app.run_on_main_thread(move || refresh(&target)) {
    eprintln!("[tray] 派发菜单刷新失败：{error}");
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

#[derive(Debug, Clone)]
struct TrayController {
  game_id: String,
  game_name: String,
  controller_id: String,
  label: String,
}

/// 托盘控制器条目列出全部运行中的游戏；壁纸激活的排在最前。
/// 设置子菜单是控制器管理入口，不能因为游戏没绑壁纸就消失。多显示器同一游戏去重。
fn controller_games(wallpaper: &[String], active: &BTreeSet<String>) -> Vec<String> {
  let mut games: Vec<String> = active.iter().cloned().collect();
  games.sort_by(|left, right| {
    let left_wallpaper = wallpaper.contains(left);
    let right_wallpaper = wallpaper.contains(right);
    right_wallpaper
      .cmp(&left_wallpaper)
      .then_with(|| left.cmp(right))
  });
  games
}

fn controller_available(app: &AppHandle, game_id: &str, controller: &GameController) -> bool {
  match controller.kind() {
    GameControllerKind::Widget => controller.widget_id.as_deref().is_some_and(|id| {
      crate::widget_package::store::find(app, id).is_ok()
        && crate::widget_package::store::is_enabled(app, id)
    }),
    GameControllerKind::Package => controller.entry.as_deref().is_some_and(|entry| {
      crate::game_package::store::package_dir(app, game_id)
        .map(|dir| dir.join(entry).is_file())
        .unwrap_or(false)
    }),
  }
}

fn tray_controllers(app: &AppHandle) -> Vec<TrayController> {
  let wallpaper = crate::wallpaper::runtime::active_games();
  let active = crate::game::manager::active_controller_games();
  let mut entries = Vec::new();
  for game_id in controller_games(&wallpaper, &active) {
    let Ok(manifest) = crate::game_package::store::find(app, &game_id) else {
      continue;
    };
    for controller in &manifest.controllers {
      if !controller_available(app, &game_id, controller) {
        continue;
      }
      entries.push(TrayController {
        game_id: game_id.clone(),
        game_name: manifest.name.clone(),
        controller_id: controller.id.clone(),
        label: controller
          .label
          .clone()
          .unwrap_or_else(|| controller.id.clone()),
      });
    }
  }
  entries
}

fn controller_item_id(game_id: &str, controller_id: &str) -> String {
  format!("open-game-controller|{game_id}|{controller_id}")
}

/// 在「设置」子菜单里挂一个统一的「游戏控制器」子菜单：
/// 列出全部运行中游戏的控制器，壁纸激活的游戏排在前；单游戏时直接列控制器，
/// 多游戏时先按游戏分组。没有可打开的控制器时省略。
fn append_controller_menu(app: &AppHandle, menu: &Submenu<Wry>) -> tauri::Result<()> {
  let controllers = tray_controllers(app);
  if controllers.is_empty() {
    return Ok(());
  }
  menu.append(&PredefinedMenuItem::separator(app)?)?;
  let root = Submenu::with_id(
    app,
    "game-controllers",
    crate::i18n::t("tray_game_controller"),
    true,
  )?;
  let mut games: Vec<&str> = controllers
    .iter()
    .map(|entry| entry.game_id.as_str())
    .collect();
  games.sort_unstable();
  games.dedup();
  if games.len() <= 1 {
    for entry in &controllers {
      root.append(&MenuItem::with_id(
        app,
        controller_item_id(&entry.game_id, &entry.controller_id),
        entry.label.clone(),
        true,
        None::<&str>,
      )?)?;
    }
    menu.append(&root)?;
    return Ok(());
  }
  // 多游戏（逐屏不同游戏 / 多个运行实例）时按游戏分组，菜单里仍只出现运行中的游戏。
  for game_id in games {
    let game_name = controllers
      .iter()
      .find(|entry| entry.game_id == game_id)
      .map(|entry| entry.game_name.clone())
      .unwrap_or_else(|| game_id.to_string());
    let submenu = Submenu::with_id(app, format!("game-controllers-{game_id}"), game_name, true)?;
    for entry in controllers.iter().filter(|entry| entry.game_id == game_id) {
      submenu.append(&MenuItem::with_id(
        app,
        controller_item_id(&entry.game_id, &entry.controller_id),
        entry.label.clone(),
        true,
        None::<&str>,
      )?)?;
    }
    root.append(&submenu)?;
  }
  menu.append(&root)?;
  Ok(())
}

/// 构建「设置」子菜单：显示/隐藏设置 + 分隔线 + 各窗口入口。
///
/// 窗口入口不再平铺在一级菜单里，托盘右键的层级保持为
/// 「设置 ▸ 壁纸库 / 音乐库 / 白噪音库」。
fn build_settings_menu(app: &AppHandle, toggle: &MenuItem<Wry>) -> tauri::Result<Submenu<Wry>> {
  let menu = Submenu::with_id(app, "settings", crate::i18n::t("tray_settings"), true)?;
  menu.append(toggle)?;

  // 控制器入口列出全部运行中游戏，壁纸激活的排前；放在窗口入口前更显眼。
  append_controller_menu(app, &menu)?;

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
    // 分隔线把「控制器 / 显隐设置」与「打开各窗口」分成两组，避免误点。
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for item in &windows {
      menu.append(item)?;
    }
  }

  Ok(menu)
}

/// 托盘「扩展」子菜单里的可执行项：工具直接开窗，壁纸打开壁纸库。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayExtensionKind {
  Tool,
  Scene,
}

#[derive(Debug, Clone)]
struct TrayExtension {
  id: String,
  name: String,
  kind: TrayExtensionKind,
  enabled: bool,
}

/// 托盘「扩展」子菜单的入选规则：除游戏外的扩展都保留。
///
/// - 工具（widget）：第三方、非 Provider；停用的仍显示但菜单项置灰。
/// - 壁纸（scene）：显示为壁纸库入口；不做启用过滤。
/// - 游戏：由游戏页 / 「设置 ▸ 游戏控制器」管理，不进入扩展菜单。
/// 这条规则只作用于托盘，和设置页的分类筛选互不共享状态。
fn tray_extension_allowed(
  category: Option<ExtensionCategory>,
  origin: &str,
  is_provider: bool,
) -> bool {
  match category {
    Some(ExtensionCategory::Game) | None => false,
    Some(ExtensionCategory::Wallpaper) => true,
    Some(ExtensionCategory::Tool) => origin != "bundled" && !is_provider,
  }
}

/// 统一扩展列表 → 托盘扩展菜单条目；游戏在这里被类别规则排除。
fn tray_extensions(app: &AppHandle) -> Vec<TrayExtension> {
  crate::extension::extensions_list(app.clone())
    .into_iter()
    .filter_map(|item| {
      let category = item.category()?;
      // 坏掉的场景不提供快捷入口；仍可在扩展中心查看诊断。
      if category == ExtensionCategory::Wallpaper
        && matches!(item.status.as_str(), "invalid" | "tampered")
      {
        return None;
      }
      if !tray_extension_allowed(
        Some(category),
        &item.origin,
        crate::extension::slots::defs::slot_for_provides(&item.provides).is_some(),
      ) {
        return None;
      }
      let (kind, enabled) = match category {
        ExtensionCategory::Tool => (TrayExtensionKind::Tool, item.enabled == Some(true)),
        ExtensionCategory::Wallpaper => (TrayExtensionKind::Scene, true),
        ExtensionCategory::Game => return None,
      };
      Some(TrayExtension {
        id: item.id,
        name: item.name,
        kind,
        enabled,
      })
    })
    .collect()
}

fn tray_extension_label(item: &TrayExtension) -> String {
  match item.kind {
    TrayExtensionKind::Scene => {
      format!("{} · {}", crate::i18n::t("ext_kind_scene"), item.name)
    }
    TrayExtensionKind::Tool if !item.enabled => {
      format!("{} · {}", item.name, crate::i18n::t("ext_state_disabled"))
    }
    _ => item.name.clone(),
  }
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

  let enabled = tray_extensions(app);
  let submenu = if enabled.is_empty() {
    None
  } else {
    let menu = Submenu::with_id(app, "extensions", crate::i18n::t("tray_extensions"), true)?;
    let mut last_kind: Option<TrayExtensionKind> = None;
    for item in &enabled {
      if last_kind.is_some_and(|kind| kind != item.kind) {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
      }
      last_kind = Some(item.kind);
      let id = match item.kind {
        TrayExtensionKind::Tool => format!("ext-tool-{}", item.id),
        TrayExtensionKind::Scene => format!("ext-scene-{}", item.id),
      };
      let entry = MenuItem::with_id(
        app,
        id,
        tray_extension_label(item),
        item.enabled,
        None::<&str>,
      )?;
      menu.append(&entry)?;
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
        if let Some(rest) = id.strip_prefix("open-game-controller|") {
          let mut parts = rest.splitn(2, '|');
          let (Some(game_id), Some(controller_id)) = (parts.next(), parts.next()) else {
            return;
          };
          let app = app.clone();
          let game_id = game_id.to_string();
          let controller_id = controller_id.to_string();
          tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::game::controller::open(
              &app,
              &game_id,
              Some(&controller_id),
              crate::game::controller::OpenSource::Host,
            )
            .await
            {
              eprintln!("[tray] 打开控制器失败：{}", error.message);
            }
          });
          return;
        }
        if let Some(plugin_id) = id.strip_prefix("ext-tool-") {
          let app = app.clone();
          let plugin_id = plugin_id.to_string();
          tauri::async_runtime::spawn(async move {
            let _ = crate::widget_package::open(app, plugin_id).await;
          });
          return;
        }
        if id.starts_with("ext-scene-") {
          // 壁纸条目打开壁纸库：切换场景/游戏要经过壁纸库的确认流程。
          if let Some(spec) = window_host::find("backdrop") {
            window_host::open_async(app, spec);
          }
          return;
        }
        // 兼容旧版本重建前的 ext-<id> 菜单项。
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

  #[test]
  fn tray_extensions_keep_everything_except_games() {
    use crate::extension::ExtensionCategory::{Game, Tool, Wallpaper};

    // 工具：第三方、非 Provider 进入「扩展」菜单；停用项仍保留（菜单项置灰）。
    assert!(tray_extension_allowed(Some(Tool), "user", false));
    assert!(tray_extension_allowed(Some(Tool), "dev", false));
    assert!(!tray_extension_allowed(Some(Tool), "bundled", false));
    assert!(!tray_extension_allowed(Some(Tool), "user", true));

    // 壁纸不按启用状态过滤（scene 没有启用位），保留为壁纸库入口。
    assert!(tray_extension_allowed(Some(Wallpaper), "user", false));
    assert!(tray_extension_allowed(Some(Wallpaper), "bundled", false));

    // 游戏与未知 kind 一律排除。
    assert!(!tray_extension_allowed(Some(Game), "user", false));
    assert!(!tray_extension_allowed(None, "user", false));
  }

  #[test]
  fn disabled_tools_are_labeled_but_remain_visible() {
    let item = TrayExtension {
      id: "community-pomodoro".into(),
      name: "番茄钟".into(),
      kind: TrayExtensionKind::Tool,
      enabled: false,
    };
    assert!(tray_extension_label(&item).starts_with("番茄钟 · "));
  }

  fn active(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| (*id).to_string()).collect()
  }

  #[test]
  fn tray_controllers_list_all_running_with_wallpaper_first() {
    let wallpaper = vec!["a".to_string()];
    // 壁纸激活的游戏排在其它运行中游戏之前。
    assert_eq!(
      controller_games(&wallpaper, &active(&["a", "b"])),
      vec!["a".to_string(), "b".to_string()]
    );
    // 壁纸游戏未运行 → 其它运行中的游戏仍可在设置子菜单打开控制器。
    assert_eq!(
      controller_games(&wallpaper, &active(&["b"])),
      vec!["b".to_string()]
    );
    // 没有绑定壁纸 → 全部运行中的游戏。
    assert_eq!(
      controller_games(&[], &active(&["b", "a"])),
      vec!["a".to_string(), "b".to_string()]
    );
    // 没有运行实例 → 不显示控制器。
    assert!(controller_games(&["a".to_string()], &active(&[])).is_empty());
    // 多显示器/多游戏：两个都在壁纸里时按 id 排序并去重。
    assert_eq!(
      controller_games(
        &["b".to_string(), "a".to_string(), "b".to_string()],
        &active(&["a", "b"])
      ),
      vec!["a".to_string(), "b".to_string()]
    );
  }
}
