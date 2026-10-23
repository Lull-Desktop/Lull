//! 扩展中心的后端门面：统一列表、安装预览、安装、卸载、启用与权限。
//!
//! 这一层不拥有包格式：scene 仍由 `content_package` 校验，widget 仍由
//! `widget_package` 校验；这里只负责把两条链路收敛到同一组命令与事件。

pub mod error;
pub mod install;

pub use error::ExtensionError;

use crate::content_package;
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
  pub dev: bool,
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
  pub network: Vec<String>,
  pub file_count: usize,
  pub bytes: u64,
  pub source_digest: String,
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
    dev: false,
    error,
    enabled: None,
    running: None,
    visible: None,
    capabilities: Some(capabilities_field(&package.manifest)),
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
    dev: false,
    error,
    enabled: Some(package.enabled),
    running: Some(package.running),
    visible: Some(visible),
    capabilities: Some(package.requested),
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

fn preview_from_staged(staged: &install::Staged) -> Result<ExtensionPreview, ExtensionError> {
  let kind = detect_kind(staged.bundle())?;
  let bundle = staged.bundle();
  let mut warnings: Vec<String> = Vec::new();

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
    network,
    file_count,
    bytes,
    source_digest,
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

/// 无副作用校验，供安装确认框使用。
#[tauri::command]
pub fn extensions_inspect(
  app: AppHandle,
  path: String,
) -> Result<ExtensionPreview, ExtensionError> {
  let base = staging_base(&app)?;
  let staged = install::stage(&base, Path::new(&path))?;
  preview_from_staged(&staged)
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
  let preview = preview_from_staged(&staged)?;
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

  let info = match detect_kind(staged.bundle())? {
    Kind::Widget => {
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
    Kind::Widget => widget_package::store::remove(&app, &id)
      .map_err(|error| ExtensionError::new("extension.remove-failed", error))?,
    Kind::Scene => {
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
    Kind::Widget => widget_package::open(app, id)
      .await
      .map_err(|error| ExtensionError::new("extension.open-failed", error)),
    Kind::Scene => Ok(()),
  }
}

#[tauri::command]
pub fn extensions_close(app: AppHandle, id: String) -> Result<(), ExtensionError> {
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
    let preview = preview_from_staged(&staged);
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
}
