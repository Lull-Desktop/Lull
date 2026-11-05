//! 游戏控制器窗口：声明解析、打开/关闭、绑定与「跟随游戏」自动开关。
//!
//! 控制器有两种载体：
//! - 包内页面（`entry`）：宿主壳 `/game-controller` + sandbox iframe，窗口 label
//!   `game-controller-<hash>-<id>`；
//! - 外部 Widget（`widgetId`）：既有 `widget-<id>` 窗口 + Widget 授权账本。
//!
//! 两者都先写入 `manager.controller_bindings` 再建窗；窗口存在即绑定存在。
//! 只有实例处于 `accepts_controller()` 时才允许打开/连接，停止时由 lifecycle
//! 调用 `close_for_game` 回收。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::config;
use super::error::{codes, GameError, GameResult};
use super::manager::{self, manager as lock_manager, ControllerBinding};
use super::permissions;
use super::protocol::{HOST_API, PROTOCOL_VERSION};
use crate::game_package::manifest::{GameController, GameControllerKind, GameManifest};
use crate::game_package::store;
use crate::widget_package;

/// 打开来源：决定 `auto` 标记与失败处理（自动打开不阻塞游戏启动）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenSource {
  /// 设置页 / 托盘 / 扩展中心。
  Host,
  /// 游戏 Authority 主动请求。
  Game,
  /// 启动游戏时按偏好自动打开。
  Auto,
}

/// 包内控制器窗口 label：`game-controller-<fnv1a32(gameId)>-<id>`。
///
/// 固定长度前缀 + 8 位十六进制 hash，保证不同游戏同名控制器不会撞窗口；
/// 同时不含点号，便于 capability glob 与事件 target 匹配。
#[must_use]
pub fn label_for(game_id: &str, controller_id: &str) -> String {
  format!(
    "game-controller-{:08x}-{controller_id}",
    fnv1a32(game_id.as_bytes())
  )
}

fn fnv1a32(bytes: &[u8]) -> u32 {
  let mut hash: u32 = 0x811c_9dc5;
  for byte in bytes {
    hash ^= u32::from(*byte);
    hash = hash.wrapping_mul(0x0100_0193);
  }
  hash
}

fn ensure_active(game_id: &str) -> GameResult<()> {
  let guard = lock_manager();
  match guard.instances.get(game_id) {
    Some(instance) if instance.status.accepts_controller() => Ok(()),
    _ => Err(GameError::new(
      codes::CONTROLLER_NOT_ACTIVE,
      format!("游戏 {game_id} 未运行：控制器只在游戏运行中可用"),
    )),
  }
}

fn select_targets(
  manifest: &GameManifest,
  controller_id: Option<&str>,
) -> GameResult<Vec<GameController>> {
  match controller_id {
    Some(id) => manifest
      .controllers
      .iter()
      .find(|controller| controller.id == id)
      .cloned()
      .map(|controller| vec![controller])
      .ok_or_else(|| {
        GameError::new(
          codes::CONTROLLER_UNKNOWN,
          format!("游戏 {} 没有声明控制器 {id}", manifest.id),
        )
      }),
    None => Ok(manifest.controllers.clone()),
  }
}

fn ensure_available(
  app: &AppHandle,
  manifest: &GameManifest,
  controller: &GameController,
  label: &str,
) -> GameResult<()> {
  {
    let guard = lock_manager();
    if let Some(existing) = guard.controller_bindings.get(label) {
      if existing.game_id != manifest.id {
        return Err(GameError::new(
          codes::CONTROLLER_IN_USE,
          format!(
            "控制器 {} 正在被游戏 {} 使用，请先关闭它的控制器",
            existing.controller_id, existing.game_id
          ),
        ));
      }
    }
  }
  match controller.kind() {
    GameControllerKind::Widget => {
      let widget_id = controller.widget_id.as_deref().unwrap_or_default();
      if widget_package::store::find(app, widget_id).is_err() {
        return Err(GameError::new(
          codes::CONTROLLER_NOT_INSTALLED,
          format!("控制器 {widget_id} 尚未安装，请先到扩展中心安装"),
        ));
      }
      if !widget_package::store::is_enabled(app, widget_id) {
        return Err(GameError::new(
          codes::CONTROLLER_DISABLED,
          format!("控制器 {widget_id} 未启用，请先到扩展中心授权"),
        ));
      }
    }
    GameControllerKind::Package => {
      let dir = store::package_dir(app, &manifest.id)
        .map_err(|error| GameError::new(codes::IO_ERROR, error))?;
      let entry = controller.entry.as_deref().unwrap_or_default();
      if !dir.join(entry).is_file() {
        return Err(GameError::new(
          codes::CONTROLLER_NOT_INSTALLED,
          format!("控制器页面不存在：{entry}"),
        ));
      }
    }
  }
  Ok(())
}

fn binding_alive(label: &str, game_id: &str) -> bool {
  let guard = lock_manager();
  guard.controller_bindings.contains_key(label)
    && guard
      .instances
      .get(game_id)
      .is_some_and(|instance| instance.status.accepts_controller())
}

/// 打开控制器窗口（`controller_id = None` 表示全部声明的控制器）。
///
/// 自动打开（`OpenSource::Auto`）只处理 `autoOpen=true` 的项，单个失败只记日志，
/// 不影响游戏启动；显式打开失败直接返回错误。
pub async fn open(
  app: &AppHandle,
  game_id: &str,
  controller_id: Option<&str>,
  source: OpenSource,
) -> GameResult<Vec<String>> {
  ensure_active(game_id)?;
  let manifest = store::find(app, game_id).map_err(|error| {
    GameError::new(
      codes::PACKAGE_NOT_FOUND,
      format!("找不到游戏 {game_id}：{error}"),
    )
  })?;
  let mut targets = select_targets(&manifest, controller_id)?;
  if source == OpenSource::Auto {
    targets.retain(|controller| controller.auto_open);
  }
  let propagate = controller_id.is_some() || source != OpenSource::Auto;
  let mut opened = Vec::new();
  for controller in targets {
    match open_one(app, &manifest, &controller).await {
      Ok(label) => opened.push(label),
      Err(error) => {
        if propagate {
          // 已打开的窗口保留：显式打开失败不应该把其它控制器一起关掉。
          return Err(error);
        }
        eprintln!(
          "[game] 自动打开控制器 {} 失败：{}",
          controller.id, error.message
        );
      }
    }
  }
  if !opened.is_empty() {
    manager::emit_games_changed(app);
  }
  Ok(opened)
}

async fn open_one(
  app: &AppHandle,
  manifest: &GameManifest,
  controller: &GameController,
) -> GameResult<String> {
  let label = match controller.kind() {
    GameControllerKind::Widget => widget_package::label_for_id(
      controller.widget_id.as_deref().unwrap_or_default(),
    ),
    GameControllerKind::Package => label_for(&manifest.id, &controller.id),
  };
  ensure_available(app, manifest, controller, &label)?;
  let binding = ControllerBinding {
    game_id: manifest.id.clone(),
    controller_id: controller.id.clone(),
    kind: controller.kind(),
    window_label: label.clone(),
    allowed_commands: controller
      .commands
      .as_ref()
      .map(|commands| commands.iter().cloned().collect()),
    allowed_events: controller
      .events
      .as_ref()
      .map(|events| events.iter().cloned().collect()),
  };
  {
    let mut guard = lock_manager();
    guard.controller_bindings.insert(label.clone(), binding.clone());
  }
  let was_open = app.get_webview_window(&label).is_some();
  let opened = match controller.kind() {
    GameControllerKind::Widget => {
      let widget_id = controller.widget_id.clone().ok_or_else(|| {
        GameError::new(codes::MANIFEST_INVALID, "控制器缺少 widgetId")
      })?;
      widget_package::open(app.clone(), widget_id)
        .await
        .map_err(|error| {
          drop_binding(&label, &manifest.id);
          GameError::new(codes::IO_ERROR, format!("打开控制器失败：{error}"))
        })
    }
    GameControllerKind::Package => {
      let app_handle = app.clone();
      let manifest_clone = manifest.clone();
      let controller_clone = controller.clone();
      let binding_clone = binding.clone();
      let result = tauri::async_runtime::spawn_blocking(move || {
        open_package_window(
          &app_handle,
          &manifest_clone,
          &controller_clone,
          &binding_clone,
        )
      })
      .await
      .map_err(|error| {
        GameError::new(codes::IO_ERROR, format!("创建控制器窗口任务失败：{error}"))
      });
      match result {
        Ok(inner) => inner,
        Err(error) => {
          drop_binding(&label, &manifest.id);
          Err(error)
        }
      }
    }
  };
  if let Err(error) = opened {
    return Err(error);
  }
  // 窗口已存在时只 show/focus，不会重新执行页面脚本；显式 reload 让控制器按新的
  // 目标游戏重新 handshake（游戏重启后控制器必须重连）。
  if was_open {
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.eval("window.location.reload()");
    }
  }
  // 建窗与停止可能并发：binding 已被回收时立即销毁刚建出的窗口。
  if !binding_alive(&label, &manifest.id) {
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.destroy();
    }
    drop_binding(&label, &manifest.id);
    permissions::revoke_window_token(&label);
    return Err(GameError::new(
      codes::CONTROLLER_NOT_ACTIVE,
      "游戏已停止，控制器窗口已关闭",
    ));
  }
  Ok(label)
}

fn drop_binding(label: &str, game_id: &str) {
  let mut guard = lock_manager();
  if guard
    .controller_bindings
    .get(label)
    .is_some_and(|binding| binding.game_id == game_id)
  {
    guard.controller_bindings.remove(label);
  }
}

fn open_package_window(
  app: &AppHandle,
  manifest: &GameManifest,
  controller: &GameController,
  binding: &ControllerBinding,
) -> GameResult<()> {
  let label = binding.window_label.as_str();
  if let Some(window) = app.get_webview_window(label) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    return Ok(());
  }
  let dir = store::package_dir(app, &manifest.id)
    .map_err(|error| GameError::new(codes::IO_ERROR, error))?;
  let entry = controller.entry.as_deref().ok_or_else(|| {
    GameError::new(codes::MANIFEST_INVALID, "包内控制器缺少 entry")
  })?;
  if !dir.join(entry).is_file() {
    return Err(GameError::new(
      codes::CONTROLLER_NOT_INSTALLED,
      format!("控制器页面不存在：{entry}"),
    ));
  }
  let (instance_id, limits) = {
    let guard = lock_manager();
    let instance = guard.instances.get(&manifest.id).ok_or_else(|| {
      GameError::new(codes::CONTROLLER_NOT_ACTIVE, "游戏未运行，无法创建控制器窗口")
    })?;
    (instance.instance_id.clone(), instance.spec.limits)
  };
  let token = permissions::issue_window_token(label);
  let context = serde_json::json!({
    "protocol": PROTOCOL_VERSION,
    "hostApi": HOST_API,
    "role": "controller",
    "gameId": manifest.id,
    "instanceId": instance_id,
    "controllerId": controller.id,
    "label": controller.label,
    "entryUrl": crate::game_package::protocol::entry_url(&manifest.id, entry),
    "token": token,
    "limits": limits,
    "locale": crate::i18n::current(),
    "allowedCommands": controller.commands,
    "window": {
      "width": controller.width(),
      "height": controller.height(),
      "minWidth": controller.min_width(),
      "minHeight": controller.min_height(),
      "resizable": controller.resizable(),
      "alwaysOnTop": controller.always_on_top(),
    },
  });
  let locale = serde_json::to_string(&crate::i18n::current()).unwrap_or_else(|_| "\"zh-CN\"".to_string());
  let context_json = serde_json::to_string(&context).map_err(|error| {
    permissions::revoke_window_token(label);
    GameError::new(codes::IO_ERROR, format!("序列化控制器上下文失败：{error}"))
  })?;
  let script = format!(
    "window.__LULL_LOCALE__ = {locale};\nwindow.__LULL_GAME_CONTROLLER__ = {context_json};"
  );
  let title = format!(
    "Lull {} · {}",
    manifest.name,
    controller.label.as_deref().unwrap_or(&controller.id)
  );
  let on = crate::window_host::prefs::load(app).taskbar_and_minimize;
  let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("game-controller".into()))
    .title(title)
    .inner_size(controller.width(), controller.height())
    .min_inner_size(controller.min_width(), controller.min_height())
    .decorations(false)
    .shadow(false)
    .visible(false)
    .skip_taskbar(!on)
    .minimizable(on)
    .resizable(controller.resizable())
    .maximizable(false)
    .always_on_top(controller.always_on_top())
    .background_color(tauri::window::Color(246, 243, 236, 255))
    .additional_browser_args(crate::webview::browser_args())
    .initialization_script(script)
    .devtools(crate::window_host::devtools_enabled());
  let window = builder.build().map_err(|error| {
    permissions::revoke_window_token(label);
    GameError::new(
      codes::IO_ERROR,
      format!("创建控制器窗口失败：{error}"),
    )
  })?;
  let _ = window.set_background_color(Some(tauri::window::Color(246, 243, 236, 255)));
  // 壳页加载失败时兜底显示，避免控制器窗口永远隐藏。
  let fallback = window.clone();
  std::thread::spawn(move || {
    for _ in 0..15 {
      std::thread::sleep(Duration::from_millis(200));
      if fallback.is_visible().unwrap_or(true) {
        return;
      }
    }
    let _ = fallback.show();
  });
  Ok(())
}

fn close_labels(app: &AppHandle, labels: Vec<String>) {
  let mut changed = false;
  for label in labels {
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.destroy();
    }
    {
      let mut guard = lock_manager();
      changed |= guard.controller_bindings.remove(&label).is_some();
      guard.controllers.remove(&label);
    }
    permissions::revoke_window_token(&label);
    crate::widget_package::on_window_destroyed(&label);
  }
  if changed {
    manager::emit_games_changed(app);
  }
}

/// 关闭指定游戏的控制器窗口（`controller_id = None` 表示全部）。
pub fn close(app: &AppHandle, game_id: &str, controller_id: Option<&str>) {
  let labels = manager::bindings_for_game(game_id)
    .into_iter()
    .filter(|binding| controller_id.map_or(true, |id| binding.controller_id == id))
    .map(|binding| binding.window_label)
    .collect();
  close_labels(app, labels);
}

/// 游戏停止/失败/禁用时回收全部控制器窗口。
pub fn close_for_game(app: &AppHandle, game_id: &str) {
  close(app, game_id, None);
}

/// ticker 兜底：实例已不处于运行态时回收其控制器窗口。
///
/// 覆盖失败/异常退出等没有显式 close 的路径，保证"只有运行中的游戏有控制器窗口"。
pub fn close_orphaned(app: &AppHandle) {
  let labels = {
    let guard = lock_manager();
    guard
      .controller_bindings
      .values()
      .filter(|binding| {
        guard
          .instances
          .get(&binding.game_id)
          .map_or(true, |instance| !instance.status.accepts_controller())
      })
      .map(|binding| binding.window_label.clone())
      .collect()
  };
  close_labels(app, labels);
}

/// 启动游戏后按偏好自动打开 `autoOpen` 控制器。
pub fn spawn_open_if_follows(app: &AppHandle, game_id: &str) {
  if !config::controller_follows_game(app) {
    return;
  }
  let app = app.clone();
  let game_id = game_id.to_string();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = open(&app, &game_id, None, OpenSource::Auto).await {
      eprintln!("[game] 自动打开控制器失败：{}", error.message);
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn manifest(controllers: serde_json::Value) -> GameManifest {
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
      "capabilities": ["game.state.read", "game.command.receive"],
      "commands": { "plant.seed": {} },
      "events": { "world.changed": {} },
      "state": { "schemaVersion": 1 },
      "controllers": controllers
    });
    let mut manifest: GameManifest = serde_json::from_value(value).expect("manifest");
    manifest.normalize();
    manifest.validate().expect("valid manifest");
    manifest
  }

  fn controllers() -> serde_json::Value {
    serde_json::json!([
      { "id": "panel", "entry": "controllers/panel/index.html" },
      { "id": "remote", "widgetId": "example-ambient-controller" }
    ])
  }

  #[test]
  fn labels_are_deterministic_and_game_scoped() {
    let panel = label_for("community.living-world", "panel");
    assert_eq!(panel, label_for("community.living-world", "panel"));
    assert!(panel.starts_with("game-controller-"));
    assert!(panel.ends_with("-panel"));
    assert!(!panel.contains('.'));
    assert_ne!(panel, label_for("community.phaser-demo", "panel"));
    assert_ne!(
      label_for("community.living-world", "panel"),
      label_for("community.living-world", "remote")
    );
  }

  #[test]
  fn engine_demo_controllers_are_game_scoped_and_distinct() {
    use std::collections::HashSet;
    use std::path::Path;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/games");
    let mut controller_ids = HashSet::new();
    let mut labels = HashSet::new();
    let mut window_labels = HashSet::new();

    for name in ["phaser-demo", "pixi-demo", "three-demo"] {
      let dir = root.join(name);
      let manifest = GameManifest::from_dir(&dir).expect("demo game.json");
      assert_eq!(manifest.controllers.len(), 1, "{name} controller count");
      let controller = &manifest.controllers[0];
      assert!(
        controller_ids.insert(controller.id.clone()),
        "{name} 的 controller id 与其它示例重复"
      );
      let label = controller
        .label
        .as_deref()
        .unwrap_or(controller.id.as_str());
      assert!(
        labels.insert(label.to_string()),
        "{name} 的 controller label 与其它示例重复"
      );
      let entry = controller
        .entry
        .as_deref()
        .expect("package controller entry");
      assert!(dir.join(entry).is_file(), "{name} 控制器入口不存在：{entry}");
      let window_label = label_for(&manifest.id, &controller.id);
      assert!(
        window_labels.insert(window_label.clone()),
        "{name} 的控制器窗口 label 与其它示例重复"
      );
      assert!(window_label.contains(&controller.id));
    }
  }

  #[test]
  fn select_targets_resolves_all_or_one() {
    let manifest = manifest(controllers());
    let all = select_targets(&manifest, None).expect("all");
    assert_eq!(all.len(), 2);
    let one = select_targets(&manifest, Some("remote")).expect("remote");
    assert_eq!(one.len(), 1);
    assert_eq!(
      one[0].widget_id.as_deref(),
      Some("example-ambient-controller")
    );
    assert_eq!(
      select_targets(&manifest, Some("missing"))
        .err()
        .map(|error| error.code),
      Some(codes::CONTROLLER_UNKNOWN)
    );
  }

  #[test]
  fn auto_open_filters_declared_flag() {
    let value = serde_json::json!([
      { "id": "panel", "entry": "controllers/panel/index.html" },
      {
        "id": "remote",
        "widgetId": "example-ambient-controller",
        "autoOpen": false
      }
    ]);
    let manifest = manifest(value);
    let mut targets = select_targets(&manifest, None).expect("targets");
    targets.retain(|controller| controller.auto_open);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "panel");
  }
}
