//! 功能槽位（Slot）与 Provider 管理。
//!
//! Slot 是宿主概念：第三方只能通过 `widget.json` 的 `provides` 声明自己提供某个 Slot，
//! 不能创建 Slot。槽位负责互斥，Provider 负责声明；窗口仍由 `widget_package` 创建。

pub mod defs;
pub mod selection;

use crate::extension::ExtensionError;
use crate::widget_package;
use crate::widget_package::store::PackageInfo;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const SLOTS_CHANGED_EVENT: &str = "slots-changed";
const READY_TIMEOUT: Duration = Duration::from_secs(12);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotStatus {
  Empty,
  Stopped,
  Starting,
  Active,
  Switching,
  Unavailable,
  Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotProviderInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  /// `bundled` / `user` / `dev`
  pub origin: String,
  pub enabled: bool,
  pub eligible: bool,
  pub selected: bool,
  pub active: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason_code: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotInfo {
  pub id: String,
  pub name: String,
  pub description: String,
  pub category: String,
  pub status: SlotStatus,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub selected: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub active: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub visible: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<ExtensionError>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_provider: Option<String>,
  pub providers: Vec<SlotProviderInfo>,
}

#[derive(Debug, Default)]
struct RuntimeState {
  busy: HashSet<String>,
  phases: HashMap<String, SlotStatus>,
  errors: HashMap<String, ExtensionError>,
}

fn state() -> &'static Mutex<RuntimeState> {
  static STATE: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
  STATE.get_or_init(|| Mutex::new(RuntimeState::default()))
}

struct BusyGuard {
  slot: String,
}

impl Drop for BusyGuard {
  fn drop(&mut self) {
    if let Ok(mut state) = state().lock() {
      state.busy.remove(&self.slot);
      state.phases.remove(&self.slot);
    }
  }
}

fn begin(slot: &str, phase: Option<SlotStatus>) -> Result<BusyGuard, ExtensionError> {
  let mut state = state()
    .lock()
    .map_err(|error| ExtensionError::new("internal.error", error.to_string()))?;
  if !state.busy.insert(slot.to_string()) {
    return Err(ExtensionError::new(
      "slot.busy",
      "该功能槽位正在切换，请稍后再试",
    ));
  }
  if let Some(phase) = phase {
    state.phases.insert(slot.to_string(), phase);
  } else {
    state.phases.remove(slot);
  }
  drop(state);
  Ok(BusyGuard {
    slot: slot.to_string(),
  })
}

fn set_error(slot: &str, error: Option<ExtensionError>) {
  if let Ok(mut state) = state().lock() {
    match error {
      Some(error) => {
        state.errors.insert(slot.to_string(), error);
      }
      None => {
        state.errors.remove(slot);
      }
    }
  }
}

fn clear_error(slot: &str) {
  set_error(slot, None);
}

fn stored_error(slot: &str) -> Option<ExtensionError> {
  state()
    .lock()
    .ok()
    .and_then(|state| state.errors.get(slot).cloned())
}

fn phase(slot: &str) -> Option<SlotStatus> {
  state()
    .lock()
    .ok()
    .and_then(|state| state.phases.get(slot).copied())
}

pub fn emit_changed(app: &AppHandle) {
  let _ = app.emit(SLOTS_CHANGED_EVENT, ());
}

/// 解析扩展 id 对应的 Slot；普通 Widget 返回 `None`。
#[must_use]
pub fn provider_slot_for_id(app: &AppHandle, id: &str) -> Option<&'static defs::SlotDef> {
  widget_package::store::find(app, id)
    .ok()
    .and_then(|manifest| defs::slot_for_provides(&manifest.provides))
}

#[must_use]
pub fn selected_provider(app: &AppHandle, slot_id: &str) -> Option<String> {
  selection::selected(app, slot_id)
}

fn find_slot(slot_id: &str) -> Result<&'static defs::SlotDef, ExtensionError> {
  defs::find(slot_id).ok_or_else(|| {
    ExtensionError::new(
      "slot.unknown",
      format!("当前 Lull 不支持功能槽位：{slot_id}"),
    )
  })
}

fn provider_decl<'a>(
  info: &'a PackageInfo,
  slot: &defs::SlotDef,
) -> Option<&'a widget_package::manifest::ProviderDecl> {
  info
    .provides
    .iter()
    .find(|provider| provider.slot == slot.id)
}

fn provider_slot(info: &PackageInfo) -> Option<&'static defs::SlotDef> {
  defs::slot_for_provides(&info.provides)
}

/// `None` 表示可用；`Some((reasonCode, message))` 表示不可用。
fn check_provider(slot: &defs::SlotDef, info: &PackageInfo) -> Option<(&'static str, String)> {
  let Some(provider) = provider_decl(info, slot) else {
    return Some((
      "package-invalid",
      format!("{} 没有声明 {} 槽位", info.id, slot.id),
    ));
  };
  if !defs::supports_version(provider.version) {
    return Some((
      "incompatible",
      format!(
        "槽位契约版本 {} 高于当前宿主支持的版本 {}",
        provider.version,
        defs::SLOT_API_VERSION
      ),
    ));
  }
  if !info.enabled {
    return Some(("disabled", "扩展未启用".to_string()));
  }
  if info.status != "ready" {
    return Some((
      "package-invalid",
      format!("扩展包状态不可用：{}", info.status),
    ));
  }
  let missing = defs::missing_granted(slot, &info.granted);
  if missing.is_empty() {
    None
  } else {
    Some((
      "missing-capabilities",
      format!("缺少槽位必需能力：{}", missing.join(", ")),
    ))
  }
}

fn eligibility_error(code: &str, message: String) -> ExtensionError {
  let public = match code {
    "disabled" => "slot.provider-disabled",
    "missing-capabilities" => "slot.capabilities-missing",
    _ => "slot.provider-unavailable",
  };
  ExtensionError::new(public, message)
}

fn provider_info(
  app: &AppHandle,
  slot: &defs::SlotDef,
  info: &PackageInfo,
  selected: Option<&str>,
) -> SlotProviderInfo {
  let failure = check_provider(slot, info);
  SlotProviderInfo {
    id: info.id.clone(),
    name: info.name.clone(),
    version: info.version.clone(),
    origin: info.origin.clone(),
    enabled: info.enabled,
    eligible: failure.is_none(),
    selected: selected == Some(info.id.as_str()),
    active: widget_package::runtime::is_open(app, &info.id),
    reason_code: failure.as_ref().map(|(code, _)| (*code).to_string()),
    reason: failure.map(|(_, message)| message),
  }
}

fn sort_providers(providers: &mut [SlotProviderInfo]) {
  providers.sort_by(|left, right| {
    (left.origin != "bundled")
      .cmp(&(right.origin != "bundled"))
      .then_with(|| left.name.cmp(&right.name))
      .then_with(|| left.id.cmp(&right.id))
  });
}

fn slot_view_from(app: &AppHandle, slot: &defs::SlotDef, packages: &[PackageInfo]) -> SlotInfo {
  let selected = selection::selected(app, slot.id);
  let mut providers: Vec<SlotProviderInfo> = packages
    .iter()
    .filter(|info| provider_slot(info).is_some_and(|candidate| candidate.id == slot.id))
    .map(|info| provider_info(app, slot, info, selected.as_deref()))
    .collect();
  sort_providers(&mut providers);

  let selected_info = selected
    .as_deref()
    .and_then(|id| packages.iter().find(|info| info.id == id));
  let selected_provider = selected
    .as_deref()
    .and_then(|id| providers.iter().find(|provider| provider.id == id));
  let stored = stored_error(slot.id);
  let transient = phase(slot.id);
  let active = selected_info
    .filter(|info| widget_package::runtime::is_open(app, &info.id))
    .map(|info| info.id.clone());
  let visible = active.as_deref().and_then(|id| {
    app
      .get_webview_window(&widget_package::label_for_id(id))
      .and_then(|window| window.is_visible().ok())
  });

  let status = if selected.is_none() {
    SlotStatus::Empty
  } else if let Some(transient) = transient {
    transient
  } else if selected_info.is_none() || selected_provider.is_none_or(|provider| !provider.eligible) {
    SlotStatus::Unavailable
  } else if active.is_some() {
    SlotStatus::Active
  } else if stored.is_some() {
    SlotStatus::Failed
  } else {
    SlotStatus::Stopped
  };

  let error = match status {
    SlotStatus::Failed => stored,
    SlotStatus::Unavailable => {
      if selected_info.is_none() {
        Some(ExtensionError::new(
          "slot.provider-not-found",
          format!(
            "当前选择的扩展 {} 已不存在，请重新选择实现",
            selected.as_deref().unwrap_or_default()
          ),
        ))
      } else if let Some(provider) = selected_provider {
        provider.reason_code.as_ref().map(|code| {
          ExtensionError::new(
            match code.as_str() {
              "missing-capabilities" => "slot.capabilities-missing",
              "disabled" => "slot.provider-disabled",
              _ => "slot.provider-unavailable",
            },
            provider
              .reason
              .clone()
              .unwrap_or_else(|| "Provider 不可用".to_string()),
          )
        })
      } else if let Some(info) = selected_info {
        if info.status == "ready" {
          Some(ExtensionError::new(
            "slot.provider-invalid",
            "当前选择的扩展没有声明该功能槽位",
          ))
        } else {
          Some(ExtensionError::new(
            "slot.provider-unavailable",
            format!("扩展包状态不可用：{}", info.status),
          ))
        }
      } else {
        None
      }
    }
    _ => None,
  };

  SlotInfo {
    id: slot.id.to_string(),
    name: crate::i18n::t(slot.name_key),
    description: crate::i18n::t(slot.description_key),
    category: slot.category.to_string(),
    status,
    selected,
    active,
    visible,
    error,
    default_provider: Some(slot.default_provider.to_string()),
    providers,
  }
}

#[must_use]
pub fn list(app: &AppHandle) -> Vec<SlotInfo> {
  let packages = widget_package::store::list(app);
  defs::SLOTS
    .iter()
    .map(|slot| slot_view_from(app, slot, &packages))
    .collect()
}

fn default_eligible(slot: &defs::SlotDef, packages: &[PackageInfo]) -> Option<String> {
  let info = packages
    .iter()
    .find(|info| info.id == slot.default_provider)?;
  check_provider(slot, info)
    .is_none()
    .then(|| info.id.clone())
}

/// 首次运行 / 启用官方包后补默认选择；不激活任何窗口。
pub fn ensure_defaults(app: &AppHandle) -> Result<bool, String> {
  let packages = widget_package::store::list(app);
  let mut file = selection::load(app);
  let mut changed = false;
  for slot in defs::SLOTS {
    if file.slots.contains_key(slot.id) {
      continue;
    }
    if let Some(default) = default_eligible(slot, &packages) {
      file.slots.insert(slot.id.to_string(), default);
      changed = true;
    }
  }
  if changed {
    selection::save(app, &file)?;
  }
  Ok(changed)
}

pub fn init(app: &AppHandle) {
  if let Err(error) = ensure_defaults(app) {
    eprintln!("[slots] 初始化默认选择失败：{error}");
  }
}

/// 启用 / 能力变化后：若 Slot 还没有选择，补默认实现；不自动启动。
pub fn on_extension_changed(app: &AppHandle) {
  match ensure_defaults(app) {
    Ok(true) => emit_changed(app),
    Ok(false) => {}
    Err(error) => eprintln!("[slots] 补默认选择失败：{error}"),
  }
}

/// 卸载扩展后清理/回退当前选择；不自动启动。
pub fn on_extension_removed(app: &AppHandle, id: &str) {
  let packages = widget_package::store::list(app);
  let mut file = selection::load(app);
  let mut changed = false;
  for slot in defs::SLOTS {
    if file
      .slots
      .get(slot.id)
      .is_some_and(|selected| selected == id)
    {
      match default_eligible(slot, &packages) {
        Some(default) => {
          file.slots.insert(slot.id.to_string(), default);
        }
        None => {
          file.slots.remove(slot.id);
        }
      }
      changed = true;
      clear_error(slot.id);
    }
  }
  if changed {
    if let Err(error) = selection::save(app, &file) {
      eprintln!("[slots] 保存选择回退失败：{error}");
    }
  }
  emit_changed(app);
}

/// 窗口销毁后刷新 Slot 状态；对普通 Widget 也发一次，代价可控。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
  if widget_package::is_plugin_label(label) {
    emit_changed(app);
  }
}

async fn start_provider(app: &AppHandle, id: &str) -> Result<(), String> {
  if widget_package::runtime::is_open(app, id) {
    return widget_package::runtime::show(app, id);
  }
  let label = widget_package::label_for_id(id);
  let receiver = widget_package::runtime::expect_ready(&label)?;
  if let Err(error) = widget_package::open_for_slot(app.clone(), id.to_string()).await {
    widget_package::runtime::cancel(&label);
    return Err(error);
  }
  let wait = match tauri::async_runtime::spawn_blocking(move || {
    widget_package::runtime::wait_ready(receiver, READY_TIMEOUT)
  })
  .await
  {
    Ok(result) => result,
    Err(error) => {
      widget_package::runtime::cancel(&label);
      let _ = widget_package::stop(app, id);
      return Err(error.to_string());
    }
  };
  if let Err(error) = wait {
    widget_package::runtime::cancel(&label);
    let _ = widget_package::stop(app, id);
    return Err(error);
  }
  Ok(())
}

fn stop_other_slot_windows(
  app: &AppHandle,
  slot: &defs::SlotDef,
  packages: &[PackageInfo],
  keep_id: &str,
) {
  for info in packages {
    if info.id == keep_id || provider_slot(info).is_none_or(|candidate| candidate.id != slot.id) {
      continue;
    }
    if widget_package::runtime::is_open(app, &info.id) {
      let _ = widget_package::stop(app, &info.id);
      let _ = widget_package::runtime::wait_closed(app, &info.id, CLOSE_TIMEOUT);
    }
  }
}

async fn rollback(app: &AppHandle, old_id: Option<&str>) -> Result<(), String> {
  let Some(old_id) = old_id else {
    return Ok(());
  };
  start_provider(app, old_id).await
}

async fn fail_use(
  app: &AppHandle,
  slot: &defs::SlotDef,
  id: &str,
  old_active: Option<&str>,
  error: ExtensionError,
) -> ExtensionError {
  let _ = widget_package::stop(app, id);
  if widget_package::runtime::wait_closed(app, id, CLOSE_TIMEOUT).is_err() {
    let combined = ExtensionError::new(
      "slot.rollback-failed",
      format!(
        "{}；新实现窗口未能关闭，已停止自动回滚以避免两个实现同时运行",
        error.message
      ),
    );
    set_error(slot.id, Some(combined.clone()));
    return combined;
  }
  match rollback(app, old_active).await {
    Ok(()) => {
      set_error(slot.id, Some(error.clone()));
      ExtensionError::new(error.code.clone(), error.message.clone())
        .with_detail("已恢复切换前的实现".to_string())
    }
    Err(rollback_error) => {
      let combined = ExtensionError::new(
        "slot.rollback-failed",
        format!("{}；旧实现恢复失败：{rollback_error}", error.message),
      );
      set_error(slot.id, Some(combined.clone()));
      combined
    }
  }
}

pub async fn use_provider(
  app: &AppHandle,
  slot_id: &str,
  id: &str,
) -> Result<SlotInfo, ExtensionError> {
  let slot = find_slot(slot_id)?;
  let packages = widget_package::store::list(app);
  let info = packages
    .iter()
    .find(|info| info.id == id)
    .ok_or_else(|| ExtensionError::new("slot.provider-not-found", "没有安装该扩展"))?;
  if provider_slot(info).is_none_or(|candidate| candidate.id != slot.id) {
    return Err(ExtensionError::new(
      "slot.provider-invalid",
      format!("{id} 没有声明 {} 槽位", slot.id),
    ));
  }
  if let Some((code, message)) = check_provider(slot, info) {
    return Err(eligibility_error(code, message));
  }

  let old = selection::selected(app, slot.id);
  let old_active = old
    .as_deref()
    .filter(|old_id| widget_package::runtime::is_open(app, old_id))
    .map(str::to_string);
  let guard = begin(
    slot.id,
    Some(if old_active.is_some() {
      SlotStatus::Switching
    } else {
      SlotStatus::Starting
    }),
  )?;
  clear_error(slot.id);

  if old.as_deref() == Some(id) && widget_package::runtime::is_open(app, id) {
    widget_package::runtime::show(app, id)
      .map_err(|error| ExtensionError::new("slot.start-failed", error))?;
    drop(guard);
    emit_changed(app);
    return Ok(slot_view_from(app, slot, &widget_package::store::list(app)));
  }

  stop_other_slot_windows(app, slot, &packages, id);

  if let Some(old_id) = old_active.as_deref() {
    if let Err(error) = widget_package::stop(app, old_id) {
      return Err(ExtensionError::new("slot.start-failed", error));
    }
    if let Err(error) = widget_package::runtime::wait_closed(app, old_id, CLOSE_TIMEOUT) {
      set_error(
        slot.id,
        Some(ExtensionError::new("slot.start-failed", &error)),
      );
      return Err(ExtensionError::new("slot.start-failed", error));
    }
  }

  if let Err(error) = start_provider(app, id).await {
    return Err(
      fail_use(
        app,
        slot,
        id,
        old_active.as_deref(),
        ExtensionError::new("slot.start-failed", error),
      )
      .await,
    );
  }

  // 启动期间用户可能停用/撤销能力；提交前再复核一次。
  let packages = widget_package::store::list(app);
  let still_eligible = packages
    .iter()
    .find(|info| info.id == id)
    .is_some_and(|info| check_provider(slot, info).is_none());
  if !still_eligible {
    return Err(
      fail_use(
        app,
        slot,
        id,
        old_active.as_deref(),
        ExtensionError::new("slot.provider-unavailable", "启动期间扩展变为不可用"),
      )
      .await,
    );
  }

  if old.as_deref() != Some(id) {
    if let Err(error) = selection::set_selected(app, slot.id, Some(id)) {
      return Err(
        fail_use(
          app,
          slot,
          id,
          old_active.as_deref(),
          ExtensionError::new("slot.start-failed", format!("保存选择失败：{error}")),
        )
        .await,
      );
    }
  }

  clear_error(slot.id);
  drop(guard);
  emit_changed(app);
  Ok(slot_view_from(app, slot, &packages))
}

pub async fn activate(app: &AppHandle, slot_id: &str) -> Result<SlotInfo, ExtensionError> {
  let slot = find_slot(slot_id)?;
  let selected = selection::selected(app, slot.id)
    .ok_or_else(|| ExtensionError::new("slot.not-selected", "该功能槽位还没有选择实现"))?;
  let packages = widget_package::store::list(app);
  let info = packages
    .iter()
    .find(|info| info.id == selected)
    .ok_or_else(|| ExtensionError::new("slot.provider-not-found", "当前选择的扩展已不存在"))?;
  if let Some((code, message)) = check_provider(slot, info) {
    return Err(eligibility_error(code, message));
  }

  let guard = begin(slot.id, Some(SlotStatus::Starting))?;
  clear_error(slot.id);
  if widget_package::runtime::is_open(app, &selected) {
    widget_package::runtime::show(app, &selected)
      .map_err(|error| ExtensionError::new("slot.start-failed", error))?;
    drop(guard);
    emit_changed(app);
    return Ok(slot_view_from(app, slot, &packages));
  }

  stop_other_slot_windows(app, slot, &packages, &selected);
  if let Err(error) = start_provider(app, &selected).await {
    set_error(
      slot.id,
      Some(ExtensionError::new("slot.start-failed", &error)),
    );
    return Err(ExtensionError::new("slot.start-failed", error));
  }
  clear_error(slot.id);
  drop(guard);
  emit_changed(app);
  Ok(slot_view_from(app, slot, &widget_package::store::list(app)))
}

pub fn deactivate(app: &AppHandle, slot_id: &str) -> Result<SlotInfo, ExtensionError> {
  let slot = find_slot(slot_id)?;
  let guard = begin(slot.id, None)?;
  let selected = selection::selected(app, slot.id);
  if let Some(selected) = selected.as_deref() {
    if widget_package::runtime::is_open(app, selected) {
      widget_package::stop(app, selected)
        .map_err(|error| ExtensionError::new("slot.start-failed", error))?;
    }
  }
  clear_error(slot.id);
  drop(guard);
  emit_changed(app);
  Ok(slot_view_from(app, slot, &widget_package::store::list(app)))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::widget_package::manifest::ProviderDecl;

  fn package(id: &str, slot: &str, enabled: bool, caps: &[&str]) -> PackageInfo {
    PackageInfo {
      id: id.to_string(),
      name: id.to_string(),
      version: "1.0.0".to_string(),
      description: None,
      author: None,
      license: Some("MIT".to_string()),
      status: "ready".to_string(),
      error: None,
      requested: caps.iter().map(|cap| (*cap).to_string()).collect(),
      provides: vec![ProviderDecl {
        slot: slot.to_string(),
        version: 1,
      }],
      granted: caps.iter().map(|cap| (*cap).to_string()).collect(),
      enabled,
      running: false,
      verified: true,
      integrity: "declared".to_string(),
      signature: crate::content_trust::SignatureInfo::unsigned(
        &crate::content_trust::TrustPolicy::default(),
        "test",
      ),
      tampered: false,
      review_required: false,
      dev: false,
      origin: "user".to_string(),
      window: crate::widget_package::store::PackageWindow {
        width: 560.0,
        height: 640.0,
        min_width: 560.0,
        min_height: 640.0,
        resizable: false,
        transparent: true,
        chrome: "host".to_string(),
      },
      lifecycle: "background".to_string(),
      network: Vec::new(),
      entry_url: String::new(),
      host_api: 1,
      order: 100.0,
    }
  }

  #[test]
  fn mini_player_example_is_a_valid_music_provider() {
    let dir =
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/widgets/mini-player");
    let manifest = crate::widget_package::manifest::PackageManifest::from_dir(&dir)
      .expect("mini player manifest");
    let slot = defs::slot_for_provides(&manifest.provides).expect("music-player provider");
    assert_eq!(slot.id, "music-player");
    assert!(dir.join(&manifest.entry).is_file(), "entry must exist");
    assert!(
      defs::missing_required(slot, &manifest.capabilities).is_empty(),
      "example must declare every required capability"
    );
  }

  #[test]
  fn eligibility_requires_enabled_and_capabilities() {
    let slot = defs::find("music-player").expect("slot");
    let full = ["widget.media", "media.player.read", "media.player.control"];
    assert!(check_provider(slot, &package("a", "music-player", true, &full)).is_none());
    assert_eq!(
      check_provider(slot, &package("b", "music-player", false, &full)).map(|item| item.0),
      Some("disabled")
    );
    assert_eq!(
      check_provider(slot, &package("c", "music-player", true, &["widget.media"]))
        .map(|item| item.0),
      Some("missing-capabilities")
    );
  }

  #[test]
  fn wrong_slot_and_version_are_rejected() {
    let slot = defs::find("music-player").expect("slot");
    let wrong = package(
      "wrong",
      "noise-controller",
      true,
      &["widget.media", "media.player.read", "media.player.control"],
    );
    assert_eq!(
      check_provider(slot, &wrong).map(|item| item.0),
      Some("package-invalid")
    );

    let mut future = package(
      "future",
      "music-player",
      true,
      &["widget.media", "media.player.read", "media.player.control"],
    );
    future.provides[0].version = 2;
    assert_eq!(
      check_provider(slot, &future).map(|item| item.0),
      Some("incompatible")
    );
  }
}
