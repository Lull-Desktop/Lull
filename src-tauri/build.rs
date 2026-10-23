//! Tauri 构建脚本：注入 DPI 清单，并把 `src/widgets/manifests/*.json` 编译成
//! `window_host::spec` 使用的 Rust 静态窗口描述。
//!
//! 清单是 TS / Rust 两侧的唯一事实源：构建期校验失败会直接中断编译，
//! 避免窗口尺寸、能力或 label 在两份手写清单之间漂移。
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// 与 `src/sdk/widget/types.ts` 的 `WIDGET_CAPABILITIES` 保持一致。
const CAPABILITIES: &[&str] = &[
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.chrome",
  "widget.window",
  "widget.native",
];

const ROLES: &[&str] = &["shell", "tool"];

/// `lib.rs` 的 `generate_handler!` 必须与这里完全一致：
/// 生成 `allow-*` / `deny-*` 权限，供逐窗口 capability 引用。
const APP_COMMANDS: &[&str] = &[
  "window_set_frame",
  "widget_open",
  "widget_states",
  "widget_close",
  "window_prefs_get",
  "window_prefs_set",
  "widget_package_notify",
  "widget_state_get",
  "widget_state_set",
  "widget_state_remove",
  "widget_set_transparent",
  "extensions_list",
  "extensions_inspect",
  "extensions_pick",
  "extensions_install",
  "extensions_remove",
  "extensions_set_enabled",
  "extensions_set_capability",
  "extensions_open",
  "extensions_close",
  "extensions_stop",
  "extensions_open_dir",
  "extensions_dev_state",
  "extensions_dev_set_enabled",
  "extensions_dev_pick_and_add",
  "extensions_dev_remove",
  "extensions_dev_reload",
  "wallpaper_status",
  "wallpaper_detach",
  "wallpaper_set_visible",
  "wallpaper_get_visible",
  "wallpaper_monitors",
  "wallpaper_set_monitor_visible",
  "wallpaper_display_get",
  "wallpaper_set_display",
  "wallpaper_set_scene_params",
  "wallpaper_set_monitor_scene",
  "content_packages",
];

fn fail(message: &str) -> ! {
  eprintln!("[build] {message}");
  std::process::exit(1);
}

fn string_field(value: &Value, key: &str, file: &str) -> String {
  match value.get(key).and_then(Value::as_str) {
    Some(text) if !text.trim().is_empty() => text.to_string(),
    _ => fail(&format!("{file}: 字段 {key} 必须是非空字符串")),
  }
}

fn number_field(value: &Value, key: &str, file: &str) -> f64 {
  match value.get(key).and_then(Value::as_f64) {
    Some(number) if number.is_finite() && number > 0.0 => number,
    _ => fail(&format!("{file}: 字段 {key} 必须是正数")),
  }
}

fn bool_field(value: &Value, key: &str, file: &str) -> bool {
  match value.get(key).and_then(Value::as_bool) {
    Some(flag) => flag,
    None => fail(&format!("{file}: 字段 {key} 必须是布尔值")),
  }
}

fn capabilities_field(value: &Value, file: &str) -> Vec<String> {
  let Some(items) = value.get("capabilities").and_then(Value::as_array) else {
    fail(&format!("{file}: capabilities 必须是非空数组"));
  };
  if items.is_empty() {
    fail(&format!("{file}: capabilities 必须是非空数组"));
  }
  let mut capabilities: Vec<String> = Vec::new();
  for item in items {
    let Some(capability) = item.as_str() else {
      fail(&format!("{file}: capabilities 必须是字符串数组"));
    };
    if !CAPABILITIES.contains(&capability) {
      fail(&format!("{file}: 未知能力 {capability}"));
    }
    if !capabilities.iter().any(|known| known == capability) {
      capabilities.push(capability.to_string());
    }
  }
  capabilities
}

struct Manifest {
  order: f64,
  id: String,
  value: Value,
}

fn read_manifests(dir: &Path) -> Vec<Manifest> {
  let entries = match fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(error) => fail(&format!("读取 {} 失败: {error}", dir.display())),
  };
  let mut files: Vec<PathBuf> = entries
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
    .collect();
  files.sort();

  let mut manifests: Vec<Manifest> = Vec::new();
  let mut ids = HashSet::new();
  let mut labels = HashSet::new();
  let mut routes = HashSet::new();

  for path in files {
    let file = path
      .file_name()
      .and_then(|name| name.to_str())
      .unwrap_or("widget.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = match fs::read_to_string(&path) {
      Ok(text) => text,
      Err(error) => fail(&format!("{file}: 读取失败 {error}")),
    };
    let value: Value = match serde_json::from_str(&text) {
      Ok(value) => value,
      Err(error) => fail(&format!("{file}: JSON 解析失败 {error}")),
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
      fail(&format!("{file}: schemaVersion 必须是 1"));
    }
    if value.get("type").and_then(Value::as_str) != Some("widget") {
      fail(&format!("{file}: type 必须是 \"widget\""));
    }
    let role = string_field(&value, "role", file);
    if !ROLES.contains(&role.as_str()) {
      fail(&format!("{file}: role 必须是 shell / tool"));
    }
    let id = string_field(&value, "id", file);
    if !ids.insert(id.clone()) {
      fail(&format!("{file}: id 重复 {id}"));
    }
    if value.get("builtin").and_then(Value::as_bool) != Some(true) {
      fail(&format!("{file}: 首期只接受 builtin=true"));
    }
    let window = match value.get("window") {
      Some(Value::Object(window)) => window,
      _ => fail(&format!("{file}: window 必须是对象")),
    };
    let window = Value::Object(window.clone());
    let label = string_field(&window, "label", file);
    let route = string_field(&window, "route", file);
    if !labels.insert(label.clone()) {
      fail(&format!("{file}: label 重复 {label}"));
    }
    if !routes.insert(route.clone()) {
      fail(&format!("{file}: route 重复 {route}"));
    }
    let width = number_field(&window, "width", file);
    let height = number_field(&window, "height", file);
    let min_width = number_field(&window, "minWidth", file);
    let min_height = number_field(&window, "minHeight", file);
    if min_width > width || min_height > height {
      fail(&format!("{file}: 最小尺寸不能大于初始尺寸"));
    }
    let order = value.get("order").and_then(Value::as_f64).unwrap_or(100.0);
    manifests.push(Manifest { order, id, value });
  }

  if manifests.is_empty() {
    fail("src/widgets/manifests 下没有 widget 清单");
  }
  manifests.sort_by(|left, right| {
    left
      .order
      .total_cmp(&right.order)
      .then_with(|| left.id.cmp(&right.id))
  });
  manifests
}

fn rust_string(text: &str) -> String {
  format!("{text:?}")
}

fn rust_capabilities(capabilities: &[String]) -> String {
  let items: Vec<String> = capabilities
    .iter()
    .map(|capability| rust_string(capability))
    .collect();
  format!("&[{}]", items.join(", "))
}

fn constant_name(id: &str) -> String {
  id.to_uppercase().replace('-', "_")
}

fn generate(manifests: &[Manifest]) -> String {
  let mut code = String::from(
    "// @generated by src-tauri/build.rs from src/widgets/manifests/*.json.\n\
     // Do not edit by hand; cargo build regenerates this file.\n\n",
  );
  for manifest in manifests {
    let value = &manifest.value;
    let window = match value.get("window") {
      Some(Value::Object(window)) => window,
      _ => fail("window 必须是对象"),
    };
    let window = Value::Object(window.clone());
    let id = string_field(value, "id", "manifest");
    let width_value = number_field(&window, "width", "manifest");
    let height_value = number_field(&window, "height", "manifest");
    let min_width_value = number_field(&window, "minWidth", "manifest");
    let min_height_value = number_field(&window, "minHeight", "manifest");
    let width = format!("{width_value:?}");
    let height = format!("{height_value:?}");
    let min_width = format!("{min_width_value:?}");
    let min_height = format!("{min_height_value:?}");
    code.push_str(&format!(
      "pub static {constant}: WidgetSpec = WidgetSpec {{\n\
       \x20 kind: {kind},\n\
       \x20 label: {label},\n\
       \x20 url: {url},\n\
       \x20 title: {title},\n\
       \x20 name: {name},\n\
       \x20 width: {width},\n\
       \x20 height: {height},\n\
       \x20 min_width: {min_width},\n\
       \x20 min_height: {min_height},\n\
       \x20 resizable: {resizable},\n\
       \x20 transparent: {transparent},\n\
       \x20 version: {version},\n\
       \x20 capabilities: {capabilities},\n\
       }};\n\n",
      constant = constant_name(&id),
      kind = rust_string(&id),
      label = rust_string(&string_field(&window, "label", "manifest")),
      url = rust_string(&string_field(&window, "route", "manifest")),
      title = rust_string(&string_field(&window, "title", "manifest")),
      name = rust_string(&string_field(value, "name", "manifest")),
      resizable = bool_field(&window, "resizable", "manifest"),
      transparent = bool_field(&window, "transparent", "manifest"),
      version = rust_string(&string_field(value, "version", "manifest")),
      capabilities = rust_capabilities(&capabilities_field(value, "manifest")),
    ));
  }
  let refs: Vec<String> = manifests
    .iter()
    .map(|manifest| format!("&{}", constant_name(&manifest.id)))
    .collect();
  code.push_str(&format!(
    "pub static ALL_WIDGETS: [&WidgetSpec; {}] = [{}];\n",
    refs.len(),
    refs.join(", ")
  ));
  code
}

fn main() {
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
  let widgets_dir = manifest_dir.join("../src/widgets/manifests");
  println!("cargo:rerun-if-changed={}", widgets_dir.display());
  // 结构体字段变化时也要重新生成静态描述。
  println!("cargo:rerun-if-changed=src/window_host/spec.rs");

  let manifests = read_manifests(&widgets_dir);
  let generated = generate(&manifests);

  let out_dir = match env::var("OUT_DIR") {
    Ok(out_dir) => out_dir,
    Err(error) => fail(&format!("读取 OUT_DIR 失败: {error}")),
  };
  let out_path = PathBuf::from(out_dir).join("widget_specs.rs");
  if let Err(error) = fs::write(&out_path, generated) {
    fail(&format!("写入 {} 失败: {error}", out_path.display()));
  }

  let attrs = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))
    .windows_attributes(
    tauri_build::WindowsAttributes::new().app_manifest(
      r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>"#,
    ),
  );
  tauri_build::try_build(attrs).expect("failed to run build script");
}
