//! 扩展中心的后端门面：统一列表、安装预览、安装、卸载、启用与权限。
//!
//! 这一层不拥有包格式：scene 仍由 `content_package` 校验，widget 仍由
//! `widget_package` 校验；这里只负责把两条链路收敛到同一组命令与事件。

pub mod dev;
pub mod error;
pub mod install;
pub mod slots;

pub use error::ExtensionError;

use crate::content_package;
use crate::content_trust::{
  self, PackageClaim, PackageKind, SignatureDecision, SignatureInfo, TrustPolicy,
};
use crate::package_hash;
use crate::widget_package;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// 扩展增删、授权、开发包变化后广播。
pub const EXTENSIONS_CHANGED_EVENT: &str = "extensions-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
  pub width: f64,
  pub height: f64,
  pub chrome: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
  pub kind: String,
  pub id: String,
  pub name: String,
  pub version: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub author: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub license: Option<String>,
  pub status: String,
  pub verified: String,
  /// 社区发布者签名状态；与摘要校验是两条独立的链。
  pub signature: SignatureInfo,
  pub dev: bool,
  /// `user` / `dev` / `bundled`；官方扩展由宿主按资源路径判定。
  pub origin: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<ExtensionError>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub enabled: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub running: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub visible: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub capabilities: Option<Vec<String>>,
  /// 该 Widget 声明的功能槽位；普通 Widget 为空。
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub provides: Vec<widget_package::manifest::ProviderDecl>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub granted: Option<Vec<String>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub network: Option<Vec<String>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub window: Option<WindowInfo>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lifecycle: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub entry_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub manifest: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPreview {
  pub kind: String,
  pub id: String,
  pub name: String,
  pub version: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub author: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub license: Option<String>,
  pub capabilities: Vec<String>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub provides: Vec<widget_package::manifest::ProviderDecl>,
  pub network: Vec<String>,
  pub file_count: usize,
  pub bytes: u64,
  pub source_digest: String,
  /// 安装器认的内容摘要；签名声明里的 digest 必须与它一致。
  pub package_digest: String,
  pub signature: SignatureInfo,
  pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
  pub path: String,
  pub preview: ExtensionPreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
  Scene,
  Widget,
}

impl Kind {
  fn as_str(self) -> &'static str {
    match self {
      Self::Scene => "scene",
      Self::Widget => "widget",
    }
  }
}

fn kind_from_str(kind: &str) -> Result<Kind, ExtensionError> {
  match kind {
    "scene" => Ok(Kind::Scene),
    "widget" => Ok(Kind::Widget),
    other => Err(ExtensionError::new(
      "extension.unsupported-kind",
      format!("未知扩展类型：{other}"),
    )),
  }
}

fn io_error(message: impl Into<String>) -> ExtensionError {
  ExtensionError::new("io.error", message)
}

fn emit_changed(app: &AppHandle) {
  let _ = app.emit(EXTENSIONS_CHANGED_EVENT, ());
  // 兼容期：壁纸窗还在监听旧事件。
  let _ = app.emit("content-changed", ());
  crate::tray::refresh(app);
}

fn staging_base(app: &AppHandle) -> Result<PathBuf, ExtensionError> {
  app
    .path()
    .app_data_dir()
    .map_err(|error| io_error(format!("应用数据目录不可用：{error}")))
}

fn text_field(manifest: &Value, key: &str) -> Option<String> {
  manifest
    .get(key)
    .and_then(Value::as_str)
    .map(str::to_string)
}

fn capabilities_field(manifest: &Value) -> Vec<String> {
  manifest
    .get("capabilities")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

fn scene_info(package: content_package::store::ContentPackageInfo) -> ExtensionInfo {
  let status = match package.status.as_str() {
    "tampered" => "tampered",
    "invalid" => "invalid",
    _ if !package.verified => "unverified",
    _ => "ready",
  };
  let error = package.error.as_ref().map(|message| {
    ExtensionError::new(
      if status == "tampered" {
        "integrity.mismatch"
      } else {
        "manifest.field-invalid"
      },
      message.clone(),
    )
  });
  ExtensionInfo {
    kind: "scene".to_string(),
    id: package.id,
    name: package.name,
    version: package.version,
    description: package.description,
    author: package.author,
    license: package.license,
    status: status.to_string(),
    verified: if package.verified { "declared" } else { "none" }.to_string(),
    signature: package.signature,
    dev: false,
    origin: package.origin,
    error,
    enabled: None,
    running: None,
    visible: None,
    capabilities: Some(capabilities_field(&package.manifest)),
    provides: Vec::new(),
    granted: None,
    network: None,
    window: None,
    lifecycle: None,
    entry_url: Some(package.entry_url),
    manifest: Some(package.manifest),
  }
}

fn widget_info(app: &AppHandle, package: widget_package::store::PackageInfo) -> ExtensionInfo {
  let visible = package.running
    && app
      .get_webview_window(&format!("widget-{}", package.id))
      .and_then(|window| window.is_visible().ok())
      .unwrap_or(false);
  let status = if package.status == "invalid" {
    "invalid"
  } else if package.tampered {
    "tampered"
  } else if !package.verified {
    "unverified"
  } else {
    "ready"
  };
  let error = package.error.as_ref().map(|message| {
    ExtensionError::new(
      if package.tampered {
        "integrity.mismatch"
      } else {
        "manifest.field-invalid"
      },
      message.clone(),
    )
  });
  ExtensionInfo {
    kind: "widget".to_string(),
    id: package.id,
    name: package.name,
    version: package.version,
    description: package.description,
    author: package.author,
    license: package.license,
    status: status.to_string(),
    verified: package.integrity,
    signature: package.signature,
    dev: package.dev,
    origin: package.origin,
    error,
    enabled: Some(package.enabled),
    running: Some(package.running),
    visible: Some(visible),
    capabilities: Some(package.requested),
    provides: package.provides,
    granted: Some(package.granted),
    network: Some(package.network),
    window: Some(WindowInfo {
      width: package.window.width,
      height: package.window.height,
      chrome: package.window.chrome,
    }),
    lifecycle: Some(package.lifecycle),
    entry_url: Some(package.entry_url),
    manifest: None,
  }
}

fn detect_kind(bundle: &Path) -> Result<Kind, ExtensionError> {
  let scene = bundle.join("catalog.json").is_file();
  let widget = bundle.join("widget.json").is_file();
  match (scene, widget) {
    (true, false) => Ok(Kind::Scene),
    (false, true) => Ok(Kind::Widget),
    (true, true) => Err(ExtensionError::new(
      "package.ambiguous",
      "扩展包同时包含 catalog.json 与 widget.json，无法判断类型",
    )),
    (false, false) => Err(ExtensionError::new(
      "package.manifest-missing",
      "扩展包里没有找到 catalog.json 或 widget.json",
    )),
  }
}

fn precheck_provider_shape(bundle: &Path) -> Result<(), ExtensionError> {
  let path = bundle.join("widget.json");
  let Ok(text) = std::fs::read_to_string(&path) else {
    return Ok(());
  };
  let Ok(value) = serde_json::from_str::<Value>(&text) else {
    return Ok(());
  };
  if value
    .get("provides")
    .and_then(Value::as_array)
    .is_some_and(|items| items.len() > 1)
  {
    return Err(ExtensionError::new(
      "manifest.provides-multiple",
      "v1 一个扩展最多声明一个功能槽位（provides 只能有一条）",
    ));
  }
  Ok(())
}

fn claim_for_bundle(kind: Kind, bundle: &Path) -> Result<PackageClaim, ExtensionError> {
  match kind {
    Kind::Widget => {
      precheck_provider_shape(bundle)?;
      let manifest = widget_package::manifest::PackageManifest::from_dir(bundle)
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      let digest = widget_package::digest::compute(bundle, &manifest.id, &manifest.version)
        .map_err(|error| ExtensionError::new("integrity.mismatch", error))?;
      Ok(PackageClaim {
        kind: PackageKind::Widget,
        id: manifest.id,
        version: manifest.version,
        digest,
      })
    }
    Kind::Scene => {
      let registration = content_package::manifest::parse(bundle)
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      let package = bundle.join(&registration.package_rel);
      let digest =
        content_package::digest::compute(&registration.id, &registration.version, &package)
          .map_err(|error| ExtensionError::new("integrity.mismatch", error))?;
      Ok(PackageClaim {
        kind: PackageKind::Scene,
        id: registration.id,
        version: registration.version,
        digest,
      })
    }
  }
}

fn preview_from_staged(
  app: &AppHandle,
  staged: &install::Staged,
  source: &Path,
) -> Result<ExtensionPreview, ExtensionError> {
  let policy = content_trust::policy::load(app);
  preview_from_staged_with_policy(staged, source, &policy)
}

/// 已知 Slot 的 Provider 安装前必须满足必需能力；未知 Slot 只提示。
fn validate_provider_install(
  manifest: &widget_package::manifest::PackageManifest,
) -> Result<(), ExtensionError> {
  let Some(slot) = slots::defs::slot_for_provides(&manifest.provides) else {
    return Ok(());
  };
  let missing = slots::defs::missing_required(slot, &manifest.capabilities);
  if missing.is_empty() {
    return Ok(());
  }
  Err(ExtensionError::new(
    "manifest.provider-capability-missing",
    format!("{} 槽位缺少必需能力：{}", slot.id, missing.join(", ")),
  ))
}

fn provider_warnings(manifest: &widget_package::manifest::PackageManifest) -> Vec<String> {
  let mut warnings = Vec::new();
  let unknown = slots::defs::unknown_declared_slots(&manifest.provides);
  if !unknown.is_empty() {
    warnings.push(format!(
      "当前 Lull 不支持功能槽位 {}；该扩展会按普通 Widget 安装。",
      unknown.join(", ")
    ));
  }
  if let Some(slot) = slots::defs::slot_for_provides(&manifest.provides) {
    if let Some(provider) = manifest.provides.first() {
      if !slots::defs::supports_version(provider.version) {
        warnings.push(format!(
          "该扩展声明的 {} 槽位版本 {} 高于当前宿主支持的版本；需要更新 Lull 才能选择它。",
          slot.id, provider.version
        ));
      }
    }
    let missing = slots::defs::missing_recommended(slot, &manifest.capabilities);
    if !missing.is_empty() {
      warnings.push(format!("缺少推荐能力：{}", missing.join(", ")));
    }
  }
  warnings
}

fn preview_from_staged_with_policy(
  staged: &install::Staged,
  source: &Path,
  policy: &TrustPolicy,
) -> Result<ExtensionPreview, ExtensionError> {
  let kind = detect_kind(staged.bundle())?;
  let bundle = staged.bundle();
  let claim = claim_for_bundle(kind, bundle)?;
  if kind == Kind::Scene && content_package::store::is_reserved(&claim.id) {
    return Err(ExtensionError::new(
      "manifest.id-reserved",
      format!("{} 是官方保留 id，不能作为用户内容包安装", claim.id),
    ));
  }
  let (signature, _) = content_trust::verify_source(source, bundle, &claim, policy);
  let mut warnings: Vec<String> = Vec::new();
  let mut provides = Vec::new();

  let (id, name, version, description, author, license, capabilities, network) = match kind {
    Kind::Widget => {
      let manifest = widget_package::manifest::PackageManifest::from_dir(bundle)
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      if !bundle.join(&manifest.entry).is_file() {
        return Err(ExtensionError::new(
          "manifest.entry-missing",
          format!("entry 指向的文件不存在：{}", manifest.entry),
        ));
      }
      if manifest
        .license
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
      {
        warnings.push("未声明 license：安装器会拒绝该包".to_string());
      }
      match widget_package::digest::check(bundle, &manifest.id, &manifest.version) {
        Ok(Some(_)) => {}
        Ok(None) => warnings.push("未带摘要锁：安装时会生成本地锁".to_string()),
        Err(error) => {
          return Err(ExtensionError::new("integrity.mismatch", error));
        }
      }
      validate_provider_install(&manifest)?;
      warnings.extend(provider_warnings(&manifest));
      provides = manifest.provides.clone();
      (
        manifest.id,
        manifest.name,
        manifest.version,
        manifest.description,
        manifest.author,
        manifest.license,
        manifest.capabilities,
        manifest.network,
      )
    }
    Kind::Scene => {
      let registration = content_package::manifest::parse(bundle)
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      let manifest = &registration.manifest;
      (
        registration.id,
        registration.name,
        registration.version,
        text_field(manifest, "description"),
        text_field(manifest, "author"),
        text_field(manifest, "license"),
        registration.capabilities,
        Vec::new(),
      )
    }
  };

  let (file_count, bytes) = install::stats(bundle)?;
  let source_digest = package_hash::source_digest(bundle)
    .map_err(|error| io_error(format!("计算源指纹失败：{error}")))?;

  Ok(ExtensionPreview {
    kind: kind.as_str().to_string(),
    id,
    name,
    version,
    description,
    author,
    license,
    capabilities,
    provides,
    network,
    file_count,
    bytes,
    source_digest,
    package_digest: claim.digest,
    signature,
    warnings,
  })
}

/// 列出所有扩展；单个包坏掉不影响其它。
#[tauri::command]
#[must_use]
pub fn extensions_list(app: AppHandle) -> Vec<ExtensionInfo> {
  let mut items: Vec<ExtensionInfo> = Vec::new();
  for package in content_package::store::list(&app) {
    items.push(scene_info(package));
  }
  for package in widget_package::store::list(&app) {
    items.push(widget_info(&app, package));
  }
  items.sort_by(|left, right| {
    left
      .kind
      .cmp(&right.kind)
      .then_with(|| left.name.cmp(&right.name))
      .then_with(|| left.id.cmp(&right.id))
  });
  items
}

/// 功能槽位列表：选择、运行状态、候选 Provider。
#[tauri::command]
#[must_use]
pub fn extensions_slots(app: AppHandle) -> Vec<slots::SlotInfo> {
  slots::list(&app)
}

/// 选择并运行某个 Provider；内部完成停旧、开新、等待 ready 与失败回滚。
#[tauri::command]
pub async fn extensions_slot_use(
  app: AppHandle,
  slot: String,
  id: String,
) -> Result<slots::SlotInfo, ExtensionError> {
  let view = slots::use_provider(&app, &slot, &id).await?;
  crate::tray::refresh(&app);
  Ok(view)
}

/// 启动/显示当前 Selected；不清空选择。
#[tauri::command]
pub async fn extensions_slot_activate(
  app: AppHandle,
  slot: String,
) -> Result<slots::SlotInfo, ExtensionError> {
  let view = slots::activate(&app, &slot).await?;
  crate::tray::refresh(&app);
  Ok(view)
}

/// 停止当前 active，保留 Selected。
#[tauri::command]
pub fn extensions_slot_deactivate(
  app: AppHandle,
  slot: String,
) -> Result<slots::SlotInfo, ExtensionError> {
  let view = slots::deactivate(&app, &slot)?;
  crate::tray::refresh(&app);
  Ok(view)
}

/// 无副作用校验，供安装确认框使用。
#[tauri::command]
pub fn extensions_inspect(
  app: AppHandle,
  path: String,
) -> Result<ExtensionPreview, ExtensionError> {
  let base = staging_base(&app)?;
  let staged = install::stage(&base, Path::new(&path))?;
  preview_from_staged(&app, &staged, Path::new(&path))
}

/// 系统文件对话框选择 zip 并预览；不落盘。
#[tauri::command]
pub async fn extensions_pick(app: AppHandle) -> Result<Option<PickResult>, ExtensionError> {
  let picked = tauri::async_runtime::spawn_blocking(pick_source)
    .await
    .map_err(|error| io_error(format!("打开文件选择器失败：{error}")))?;
  let Some(path) = picked else {
    return Ok(None);
  };
  let base = staging_base(&app)?;
  let staged = install::stage(&base, &path)?;
  let preview = preview_from_staged(&app, &staged, &path)?;
  Ok(Some(PickResult {
    path: path.to_string_lossy().into_owned(),
    preview,
  }))
}

fn pick_source() -> Option<PathBuf> {
  rfd::FileDialog::new()
    .set_title("选择 Lull 扩展包")
    .add_filter("Lull 扩展包 (*.zip)", &["zip"])
    .add_filter("所有文件", &["*"])
    .pick_file()
}

/// 安装；`source_digest` 来自预览，用于拒绝“确认后包被替换”。
#[tauri::command]
pub fn extensions_install(
  app: AppHandle,
  path: String,
  source_digest: Option<String>,
) -> Result<ExtensionInfo, ExtensionError> {
  let base = staging_base(&app)?;
  let staged = install::stage(&base, Path::new(&path))?;
  if let Some(expected) = source_digest {
    let actual = package_hash::source_digest(staged.bundle())
      .map_err(|error| io_error(format!("计算源指纹失败：{error}")))?;
    if actual != expected {
      return Err(ExtensionError::new(
        "package.changed",
        "确认安装后包内容发生变化，请重新选择",
      ));
    }
  }

  let kind = detect_kind(staged.bundle())?;
  let claim = claim_for_bundle(kind, staged.bundle())?;
  if kind == Kind::Scene && content_package::store::is_reserved(&claim.id) {
    return Err(ExtensionError::new(
      "manifest.id-reserved",
      format!("{} 是官方保留 id，不能作为用户内容包安装", claim.id),
    ));
  }
  let policy = content_trust::policy::load(&app);
  let (signature, persist) =
    content_trust::verify_source(Path::new(&path), staged.bundle(), &claim, &policy);
  if signature.decision == SignatureDecision::Block {
    let reason = signature
      .reason
      .clone()
      .unwrap_or_else(|| "未通过 community 发布签名校验".to_string());
    return Err(ExtensionError::new(
      "signature.blocked",
      format!("发布签名未通过：{reason}"),
    ));
  }
  if let Some(bytes) = persist {
    content_trust::persist_sidecar(staged.bundle(), &bytes)
      .map_err(|error| io_error(format!("写入包内签名失败：{error}")))?;
  }

  let info = match kind {
    Kind::Widget => {
      let manifest = widget_package::manifest::PackageManifest::from_dir(staged.bundle())
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      validate_provider_install(&manifest)?;
      let root = widget_package::store::root(&app).map_err(io_error)?;
      let package = widget_package::store::install_from_staged(&root, &staged)?;
      widget_info(&app, package)
    }
    Kind::Scene => {
      let root = content_package::store::root(&app).map_err(io_error)?;
      let package = content_package::store::install_staged(&root, &staged)
        .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
      scene_info(package)
    }
  };
  emit_changed(&app);
  Ok(info)
}

#[tauri::command]
pub fn extensions_remove(app: AppHandle, kind: String, id: String) -> Result<(), ExtensionError> {
  match kind_from_str(&kind)? {
    Kind::Widget => {
      if widget_package::store::is_official(&app, &id) {
        return Err(ExtensionError::new(
          "extension.official-readonly",
          "官方扩展随应用分发，不能卸载；可以停用",
        ));
      }
      widget_package::store::remove(&app, &id)
        .map_err(|error| ExtensionError::new("extension.remove-failed", error))?;
      slots::on_extension_removed(&app, &id);
    }
    Kind::Scene => {
      if content_package::store::is_official(&app, &id) {
        return Err(ExtensionError::new(
          "extension.official-readonly",
          "官方壁纸随应用分发，不能卸载",
        ));
      }
      if crate::wallpaper::runtime::scene_in_use(&id) {
        return Err(ExtensionError::new(
          "extension.in-use",
          "该场景正在壁纸中使用，请先切换场景再卸载",
        ));
      }
      content_package::store::remove(&app, &id)
        .map_err(|error| ExtensionError::new("extension.remove-failed", error))?;
    }
  }
  emit_changed(&app);
  Ok(())
}

#[tauri::command]
pub fn extensions_set_enabled(
  app: AppHandle,
  id: String,
  enabled: bool,
) -> Result<ExtensionInfo, ExtensionError> {
  widget_package::store::set_enabled(&app, &id, enabled)
    .map_err(|error| ExtensionError::new("extension.update-failed", error))?;
  slots::on_extension_changed(&app);
  emit_changed(&app);
  find_widget(&app, &id)
}

#[tauri::command]
pub fn extensions_set_capability(
  app: AppHandle,
  id: String,
  capability: String,
  granted: bool,
) -> Result<ExtensionInfo, ExtensionError> {
  widget_package::store::set_capability(&app, &id, &capability, granted)
    .map_err(|error| ExtensionError::new("extension.update-failed", error))?;
  emit_changed(&app);
  find_widget(&app, &id)
}

fn find_widget(app: &AppHandle, id: &str) -> Result<ExtensionInfo, ExtensionError> {
  let package = widget_package::store::list(app)
    .into_iter()
    .find(|item| item.id == id)
    .ok_or_else(|| {
      ExtensionError::new("extension.not-found", format!("没有安装 id={id} 的插件"))
    })?;
  Ok(widget_info(app, package))
}

#[tauri::command]
pub async fn extensions_open(
  app: AppHandle,
  kind: String,
  id: String,
) -> Result<(), ExtensionError> {
  match kind_from_str(&kind)? {
    Kind::Widget => {
      if let Some(slot) = slots::provider_slot_for_id(&app, &id) {
        if slots::selected_provider(&app, slot.id).as_deref() != Some(id.as_str()) {
          return Err(ExtensionError::new(
            "slot.not-selected",
            format!("{} 还不是 {} 的当前实现，请先在扩展中心使用它", id, slot.id),
          ));
        }
        slots::activate(&app, slot.id).await?;
        return Ok(());
      }
      widget_package::open(app, id)
        .await
        .map_err(|error| ExtensionError::new("extension.open-failed", error))
    }
    Kind::Scene => Ok(()),
  }
}

#[tauri::command]
pub fn extensions_close(app: AppHandle, id: String) -> Result<(), ExtensionError> {
  // Provider 的“关闭窗口”固定为隐藏：关闭不能让出 Slot，也不能触发另一个实现。
  if slots::provider_slot_for_id(&app, &id).is_some() {
    let result = widget_package::close(&app, &id);
    slots::emit_changed(&app);
    return result.map_err(|error| ExtensionError::new("extension.update-failed", error));
  }
  let manifest = widget_package::store::find(&app, &id)
    .map_err(|error| ExtensionError::new("extension.not-found", error))?;
  let result = if manifest.lifecycle == "suspend" {
    widget_package::stop(&app, &id)
  } else {
    widget_package::close(&app, &id)
  };
  result.map_err(|error| ExtensionError::new("extension.update-failed", error))
}

#[tauri::command]
pub fn extensions_stop(app: AppHandle, id: String) -> Result<(), ExtensionError> {
  widget_package::stop(&app, &id)
    .map_err(|error| ExtensionError::new("extension.update-failed", error))
}

#[tauri::command]
pub fn extensions_open_dir(app: AppHandle, kind: String) -> Result<String, ExtensionError> {
  let root = match kind_from_str(&kind)? {
    Kind::Widget => widget_package::store::root(&app),
    Kind::Scene => content_package::store::root(&app),
  }
  .map_err(io_error)?;
  std::fs::create_dir_all(&root).map_err(|error| io_error(format!("创建目录失败：{error}")))?;
  let display = root.to_string_lossy().to_string();
  app
    .opener()
    .open_path(display.clone(), None::<&str>)
    .map_err(|error| io_error(format!("打开目录失败：{error}")))?;
  Ok(display)
}

#[tauri::command]
#[must_use]
pub fn extensions_dev_state(app: AppHandle) -> dev::DevState {
  dev::state(&app)
}

#[tauri::command]
pub fn extensions_dev_set_enabled(
  app: AppHandle,
  enabled: bool,
) -> Result<dev::DevState, ExtensionError> {
  let state = dev::set_enabled(&app, enabled)
    .map_err(|error| ExtensionError::new("dev.update-failed", error))?;
  slots::on_extension_changed(&app);
  slots::emit_changed(&app);
  emit_changed(&app);
  Ok(state)
}

/// 选择本地 Widget 项目目录并挂载；返回挂载后的扩展条目。
#[tauri::command]
pub async fn extensions_dev_pick_and_add(
  app: AppHandle,
) -> Result<Option<ExtensionInfo>, ExtensionError> {
  let picked = tauri::async_runtime::spawn_blocking(pick_dev_dir)
    .await
    .map_err(|error| io_error(format!("打开目录选择器失败：{error}")))?;
  let Some(path) = picked else {
    return Ok(None);
  };
  let manifest =
    dev::add(&app, &path).map_err(|error| ExtensionError::new("dev.path-invalid", error))?;
  emit_changed(&app);
  find_widget(&app, &manifest.id).map(Some)
}

#[tauri::command]
pub fn extensions_dev_remove(app: AppHandle, id: String) -> Result<(), ExtensionError> {
  if !dev::contains(&app, &id) {
    return Err(ExtensionError::new(
      "dev.not-found",
      format!("没有挂载 id={id} 的开发包"),
    ));
  }
  widget_package::store::remove(&app, &id)
    .map_err(|error| ExtensionError::new("extension.remove-failed", error))?;
  slots::on_extension_removed(&app, &id);
  emit_changed(&app);
  Ok(())
}

#[tauri::command]
pub async fn extensions_dev_reload(app: AppHandle, id: String) -> Result<(), ExtensionError> {
  if !dev::contains(&app, &id) {
    return Err(ExtensionError::new(
      "dev.not-found",
      format!("没有挂载 id={id} 的开发包"),
    ));
  }
  // Provider 的重载必须走 Slot 激活路径，否则会绕过互斥和 Selected 状态。
  if let Some(slot) = slots::provider_slot_for_id(&app, &id) {
    if slots::selected_provider(&app, slot.id).as_deref() != Some(id.as_str()) {
      return Err(ExtensionError::new(
        "slot.not-selected",
        "该 Provider 不是当前实现，请先在扩展中心使用它",
      ));
    }
    let _ = widget_package::stop(&app, &id);
    let wait_app = app.clone();
    let wait_id = id.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
      widget_package::runtime::wait_closed(&wait_app, &wait_id, std::time::Duration::from_secs(2))
    })
    .await;
    slots::activate(&app, slot.id).await?;
    return Ok(());
  }

  let label = format!("widget-{id}");
  // `window.reload()` 会复用创建时注入的旧 entryUrl；销毁后重建才能从
  // 最新 dev 配置读取 Vite 地址（也用于首次从静态包切到 dev server）。
  if let Some(window) = app.get_webview_window(&label) {
    window
      .destroy()
      .map_err(|error| ExtensionError::new("extension.reload-failed", error.to_string()))?;
  }
  widget_package::open(app, id)
    .await
    .map_err(|error| ExtensionError::new("extension.open-failed", error))
}

fn pick_dev_dir() -> Option<PathBuf> {
  rfd::FileDialog::new()
    .set_title("选择 Widget 项目目录")
    .pick_folder()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn kind_parser_rejects_unknown() {
    assert_eq!(
      kind_from_str("widget").ok().map(Kind::as_str),
      Some("widget")
    );
    assert_eq!(kind_from_str("scene").ok().map(Kind::as_str), Some("scene"));
    assert_eq!(
      kind_from_str("native").err().map(|error| error.code),
      Some("extension.unsupported-kind".to_string())
    );
  }

  fn temp_dir(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-extension-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_widget(dir: &Path) -> std::io::Result<()> {
    std::fs::write(
      dir.join("widget.json"),
      r#"{
        "schemaVersion": 2,
        "type": "widget",
        "id": "community-test",
        "name": "测试插件",
        "version": "1.0.0",
        "builtin": false,
        "hostApi": 1,
        "entry": "index.html",
        "capabilities": ["widget.state"],
        "window": {
          "width": 560,
          "height": 640,
          "resizable": false,
          "transparent": true,
          "chrome": "host"
        }
      }"#,
    )?;
    std::fs::write(dir.join("index.html"), b"<html></html>")
  }

  #[test]
  fn provider_install_requires_slot_capabilities() {
    let Some(root) = temp_dir("provider-caps") else {
      return;
    };
    let dir = root.join("community-player");
    if std::fs::create_dir_all(&dir).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let _ = std::fs::write(
      dir.join("widget.json"),
      r#"{
        "schemaVersion": 2,
        "type": "widget",
        "id": "community-player",
        "name": "Community Player",
        "version": "1.0.0",
        "license": "MIT",
        "builtin": false,
        "hostApi": 1,
        "entry": "index.html",
        "provides": [{ "slot": "music-player", "version": 1 }],
        "capabilities": ["widget.media"],
        "window": { "width": 560, "height": 640, "chrome": "host" }
      }"#,
    );
    let _ = std::fs::write(dir.join("index.html"), b"<html></html>");
    let manifest = widget_package::manifest::PackageManifest::from_dir(&dir);
    let Ok(manifest) = manifest else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert_eq!(
      validate_provider_install(&manifest)
        .err()
        .map(|error| error.code),
      Some("manifest.provider-capability-missing".to_string())
    );
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn detects_ambiguous_and_missing_packages() {
    let Some(root) = temp_dir("detect") else {
      return;
    };
    let empty = root.join("empty");
    let _ = std::fs::create_dir_all(&empty);
    assert_eq!(
      detect_kind(&empty).err().map(|error| error.code),
      Some("package.manifest-missing".to_string())
    );

    let both = root.join("both");
    let _ = std::fs::create_dir_all(&both);
    let _ = std::fs::write(both.join("catalog.json"), "{}");
    let _ = std::fs::write(both.join("widget.json"), "{}");
    assert_eq!(
      detect_kind(&both).err().map(|error| error.code),
      Some("package.ambiguous".to_string())
    );
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn preview_widget_reports_capabilities_and_warnings() {
    let Some(root) = temp_dir("preview") else {
      return;
    };
    let source = root.join("source");
    if std::fs::create_dir_all(&source).is_err() || write_widget(&source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let staged = install::stage(&root.join("packages"), &source);
    let Ok(staged) = staged else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let preview = preview_from_staged_with_policy(&staged, &source, &TrustPolicy::default());
    assert!(
      preview.is_ok(),
      "预览失败：{}",
      preview
        .as_ref()
        .err()
        .map(|error| error.code.clone())
        .unwrap_or_default()
    );
    if let Ok(preview) = preview {
      assert_eq!(preview.kind, "widget");
      assert_eq!(preview.id, "community-test");
      assert!(preview
        .capabilities
        .iter()
        .any(|item| item == "widget.state"));
      assert!(preview.warnings.iter().any(|item| item.contains("license")));
      assert!(preview.warnings.iter().any(|item| item.contains("摘要锁")));
      assert_eq!(preview.source_digest.len(), 64);
      assert_eq!(preview.file_count, 2);
      assert!(preview.bytes > 0);
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn installs_signed_widget_and_keeps_signature() {
    let Some(root) = temp_dir("signed-install") else {
      return;
    };
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/minimal-clock");
    let Ok(staged) = install::stage(&root.join("staging"), &source) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let Ok(claim) = claim_for_bundle(Kind::Widget, staged.bundle()) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let policy = TrustPolicy::default();
    let (signature, persist) =
      content_trust::verify_source(&source, staged.bundle(), &claim, &policy);
    assert_eq!(
      signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    if let Some(bytes) = persist {
      assert!(content_trust::persist_sidecar(staged.bundle(), &bytes).is_ok());
    }
    let installed = widget_package::store::install_from_staged(&root.join("widgets"), &staged);
    let Ok(info) = installed else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert_eq!(
      info.signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    assert!(root
      .join("widgets")
      .join(&info.id)
      .join(".lull-signature.json")
      .is_file());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn installs_signed_scene_zip_with_embedded_signature() {
    let Some(root) = temp_dir("signed-scene") else {
      return;
    };
    let source =
      Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/community.mist-1.0.0.zip");
    let Ok(staged) = install::stage(&root.join("staging"), &source) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let Ok(claim) = claim_for_bundle(Kind::Scene, staged.bundle()) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let (signature, _) =
      content_trust::verify_source(&source, staged.bundle(), &claim, &TrustPolicy::default());
    assert_eq!(
      signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    let installed = content_package::store::install_staged(&root.join("content"), &staged);
    let Ok(info) = installed else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert_eq!(info.status, "ready");
    assert_eq!(
      info.signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn installs_signed_widget_zip_with_embedded_signature() {
    let Some(root) = temp_dir("signed-zip") else {
      return;
    };
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("tests/fixtures/minimal-clock-1.0.0.lull-widget.zip");
    let Ok(staged) = install::stage(&root.join("staging"), &source) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let Ok(claim) = claim_for_bundle(Kind::Widget, staged.bundle()) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let (signature, _) =
      content_trust::verify_source(&source, staged.bundle(), &claim, &TrustPolicy::default());
    assert_eq!(
      signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    let installed = widget_package::store::install_from_staged(&root.join("widgets"), &staged);
    let Ok(info) = installed else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert_eq!(
      info.signature.status,
      crate::content_trust::verify::SignatureStatus::Verified
    );
    assert!(root
      .join("widgets")
      .join(&info.id)
      .join(".lull-signature.json")
      .is_file());
    let _ = std::fs::remove_dir_all(&root);
  }
}
