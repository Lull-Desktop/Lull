//! 用户内容包清单校验。
//!
//! **安装单位 = 一个内容根目录**，与官方 `public/content/` 完全同构：
//! ```text
//! <root>/<scene-id>/
//!   catalog.json              # { schemaVersion: 1, scenes: [ 单条 scene ] }
//!   scenes/<name>/index.html  # entry 必须位于子目录里
//! ```
//! 这样做的原因：`content-digest.mjs` 的摘要只覆盖 **entry 所在目录**，清单在目录之外。
//! 若把清单也放进摘要范围，写入 `integrity` 会改变自身字节，摘要永远算不出来。
//!
//! 与前端 `src/sdk/scene/manifest.ts` 的分工：
//! - **这里**只校验安全与文件系统相关字段（id 规则、entry 是否越界、摘要格式、单场景约束）；
//! - 字段级 schema（theme / performance / compatibility）由前端 `parseSceneManifest()` 负责，
//!   Rust 把单条 scene 清单原样带回，避免两套规则漂移。

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

pub const CATALOG_SCHEMA_VERSION: u64 = 1;
pub const MANIFEST_FILE: &str = "catalog.json";

/// 与 `content/schema/scene.schema.json` 的 capabilities 枚举一致。
pub const CAPABILITIES: &[&str] = &[
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
  "wallpaper.params",
  "wallpaper.script",
];

const MAX_ID_LEN: usize = 64;
const MAX_NAME_CHARS: usize = 80;
const MAX_ENTRY_DEPTH: usize = 6;
const DIGEST_LEN: usize = 64;

/// 校验通过的内容包信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
  pub id: String,
  pub name: String,
  pub version: String,
  /// 相对 bundle 根目录的 entry，例如 `scenes/mist/index.html`。
  pub entry: String,
  /// entry 所在目录（bundle 内相对路径），整包摘要覆盖这一层。
  pub package_rel: String,
  pub capabilities: Vec<String>,
  /// 声明的整包摘要；没有声明时为 None（手动放置允许，安装器拒绝）。
  pub integrity: Option<String>,
  /// 单条 scene 清单原文，交给前端 `parseSceneManifest()` 做完整校验。
  pub manifest: Value,
}

/// id 规则：小写字母/数字开头，`[a-z0-9._-]`，3-64 字符。
pub fn valid_id(id: &str) -> bool {
  let bytes = id.as_bytes();
  if bytes.len() < 3 || bytes.len() > MAX_ID_LEN {
    return false;
  }
  let Some(first) = bytes.first() else {
    return false;
  };
  if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
    return false;
  }
  bytes.iter().all(|byte| {
    byte.is_ascii_lowercase()
      || byte.is_ascii_digit()
      || matches!(byte, b'.' | b'_' | b'-')
  })
}

/// 读取并校验 `<bundle>/catalog.json`。
pub fn parse(bundle: &Path) -> Result<Registration, String> {
  let path = bundle.join(MANIFEST_FILE);
  let text = std::fs::read_to_string(&path).map_err(|error| {
    format!(
      "读取 {} 失败：{error}（内容包根目录需要 catalog.json）",
      path.display()
    )
  })?;
  let catalog: Value = serde_json::from_str(&text)
    .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
  let object = catalog
    .as_object()
    .ok_or_else(|| "catalog.json 必须是 JSON 对象".to_string())?;

  let schema_version = object
    .get("schemaVersion")
    .and_then(Value::as_u64)
    .unwrap_or_default();
  if schema_version != CATALOG_SCHEMA_VERSION {
    return Err(format!(
      "catalog.json 的 schemaVersion 必须是 {CATALOG_SCHEMA_VERSION}，当前为 {schema_version}"
    ));
  }

  let scenes = object
    .get("scenes")
    .and_then(Value::as_array)
    .ok_or_else(|| "catalog.json 的 scenes 必须是数组".to_string())?;
  if scenes.len() != 1 {
    return Err("v1 安装器只接受单场景内容包：catalog.json 的 scenes 必须恰好一条".to_string());
  }
  let manifest = scenes
    .first()
    .cloned()
    .ok_or_else(|| "catalog.json 的 scenes 必须恰好一条".to_string())?;
  let scene = manifest
    .as_object()
    .ok_or_else(|| "scenes[0] 必须是 JSON 对象".to_string())?;

  if scene.get("schemaVersion").and_then(Value::as_u64) != Some(CATALOG_SCHEMA_VERSION) {
    return Err("scene.schemaVersion 必须是 1".to_string());
  }
  if scene.get("type").and_then(Value::as_str) != Some("scene") {
    return Err("scene.type 必须是 scene".to_string());
  }

  let id = required_string(scene, "id")?;
  if !valid_id(&id) {
    return Err(format!(
      "id 非法：{id}（只允许小写字母/数字/._-，3-64 字符）"
    ));
  }
  let name = required_string(scene, "name")?;
  if name.chars().count() > MAX_NAME_CHARS {
    return Err(format!("name 超过 {MAX_NAME_CHARS} 字"));
  }
  let version = required_string(scene, "version")?;
  // 第三方内容必须声明许可，否则无法合规分发。
  let _license = required_string(scene, "license")?;

  let entry = required_string(scene, "entry")?;
  let package_rel = validate_entry(bundle, &entry)?;
  let capabilities = parse_capabilities(scene)?;
  let integrity = parse_integrity(scene)?;

  Ok(Registration {
    id,
    name,
    version,
    entry,
    package_rel,
    capabilities,
    integrity,
    manifest,
  })
}

fn required_string(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
  match object.get(key).and_then(Value::as_str) {
    Some(text) if !text.trim().is_empty() => Ok(text.trim().to_string()),
    _ => Err(format!("scene.{key} 必须是非空字符串")),
  }
}

/// entry 必须是包内已存在的文件、至少位于一层子目录里，且不允许 `..` / 绝对路径 / 反斜杠。
/// 返回 entry 所在目录（bundle 内相对路径），用于计算整包摘要。
fn validate_entry(bundle: &Path, entry: &str) -> Result<String, String> {
  if entry.starts_with('/') || entry.contains('\\') || entry.contains('%') || entry.contains('\0') {
    return Err(format!("entry 不是安全的相对路径：{entry}"));
  }
  let mut segments: Vec<&str> = Vec::new();
  for segment in entry.split('/') {
    if segment.is_empty() || segment == "." || segment == ".." {
      return Err(format!("entry 不是安全的相对路径：{entry}"));
    }
    segments.push(segment);
  }
  if segments.len() < 2 {
    return Err(format!(
      "entry 必须位于子目录内（例如 scenes/mist/index.html），当前为 {entry}"
    ));
  }
  if segments.len() > MAX_ENTRY_DEPTH {
    return Err(format!("entry 层级超过 {MAX_ENTRY_DEPTH}"));
  }
  let target = bundle.join(entry);
  if !target.is_file() {
    return Err(format!("entry 指向的文件不存在：{entry}"));
  }
  let canonical_root =
    std::fs::canonicalize(bundle).map_err(|error| format!("内容包目录不可用：{error}"))?;
  let canonical =
    std::fs::canonicalize(&target).map_err(|error| format!("entry 不可读：{error}"))?;
  if !canonical.starts_with(&canonical_root) {
    return Err(format!("entry 逃逸出内容包目录：{entry}"));
  }
  let package_rel = segments
    .get(..segments.len().saturating_sub(1))
    .map(|parts| parts.join("/"))
    .unwrap_or_default();
  Ok(package_rel)
}

fn parse_capabilities(scene: &serde_json::Map<String, Value>) -> Result<Vec<String>, String> {
  let Some(items) = scene.get("capabilities").and_then(Value::as_array) else {
    return Err("capabilities 必须是非空数组".to_string());
  };
  if items.is_empty() {
    return Err("capabilities 必须是非空数组".to_string());
  }
  let mut capabilities: Vec<String> = Vec::new();
  for item in items {
    let Some(capability) = item.as_str() else {
      return Err("capabilities 必须是字符串数组".to_string());
    };
    if !CAPABILITIES.contains(&capability) {
      return Err(format!("未知能力：{capability}"));
    }
    if !capabilities.iter().any(|known| known == capability) {
      capabilities.push(capability.to_string());
    }
  }

  let has = |capability: &str| capabilities.iter().any(|known| known == capability);
  if !has("wallpaper.script") && (has("wallpaper.params") || has("wallpaper.sync")) {
    return Err(
      "外部内容包的 wallpaper.params / wallpaper.sync 必须同时声明 wallpaper.script".to_string(),
    );
  }
  if let Some(params) = scene.get("params").filter(|value| !value.is_null()) {
    let Some(items) = params.as_array() else {
      return Err("params 必须是数组".to_string());
    };
    if !items.is_empty() && !has("wallpaper.params") {
      return Err("声明 params 时必须同时声明 wallpaper.params".to_string());
    }
  }
  Ok(capabilities)
}

/// 摘要字段可选，但一旦声明就必须是受支持的算法与 64 位十六进制。
fn parse_integrity(scene: &serde_json::Map<String, Value>) -> Result<Option<String>, String> {
  let Some(value) = scene.get("integrity") else {
    return Ok(None);
  };
  if value.is_null() {
    return Ok(None);
  }
  let record = value
    .as_object()
    .ok_or_else(|| "integrity 必须是对象".to_string())?;
  if record.get("algorithm").and_then(Value::as_str) != Some("sha256") {
    return Err("integrity.algorithm 只支持 sha256".to_string());
  }
  if record.get("scope").and_then(Value::as_str) != Some("package") {
    return Err("integrity.scope 只支持 package".to_string());
  }
  let digest = record
    .get("digest")
    .and_then(Value::as_str)
    .ok_or_else(|| "integrity.digest 必须是字符串".to_string())?;
  if digest.len() != DIGEST_LEN || !digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
    return Err("integrity.digest 必须是 64 位十六进制".to_string());
  }
  Ok(Some(digest.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_bundle(tag: &str) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-content-manifest-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(dir.join("scenes/test")).ok()?;
    std::fs::write(dir.join("scenes/test/index.html"), "<html></html>").ok()?;
    Some(dir)
  }

  fn scene_json(id: &str, entry: &str) -> String {
    format!(
      r#"{{
        "schemaVersion": 1,
        "type": "scene",
        "id": "{id}",
        "name": "测试场景",
        "version": "1.0.0",
        "license": "CC-BY-4.0",
        "entry": "{entry}",
        "capabilities": ["wallpaper.viewport"]
      }}"#
    )
  }

  fn write_catalog(bundle: &Path, scene: &str) -> Result<(), String> {
    let body = format!("{{\n  \"schemaVersion\": 1,\n  \"scenes\": [{scene}]\n}}\n");
    std::fs::write(bundle.join(MANIFEST_FILE), body).map_err(|error| error.to_string())
  }

  #[test]
  fn accepts_valid_bundle_and_reports_package_dir() {
    let Some(bundle) = temp_bundle("ok") else {
      return;
    };
    let scene = scene_json("community.test", "scenes/test/index.html");
    assert!(write_catalog(&bundle, &scene).is_ok());
    let registration = parse(&bundle);
    assert!(registration.is_ok(), "解析失败：{registration:?}");
    if let Ok(registration) = registration {
      assert_eq!(registration.id, "community.test");
      assert_eq!(registration.package_rel, "scenes/test");
      assert!(registration.integrity.is_none());
    }
    let _ = std::fs::remove_dir_all(&bundle);
  }

  #[test]
  fn rejects_unsafe_entry_missing_license_and_multi_scene() {
    let Some(bundle) = temp_bundle("bad") else {
      return;
    };
    let escape = scene_json("community.test", "../index.html");
    assert!(write_catalog(&bundle, &escape).is_ok());
    assert!(parse(&bundle).is_err());

    let flat = scene_json("community.test", "index.html");
    assert!(write_catalog(&bundle, &flat).is_ok());
    assert!(parse(&bundle).is_err(), "entry 必须位于子目录");

    let missing_file = scene_json("community.test", "scenes/test/missing.html");
    assert!(write_catalog(&bundle, &missing_file).is_ok());
    assert!(parse(&bundle).is_err());

    let no_license =
      scene_json("community.test", "scenes/test/index.html").replace("\"license\": \"CC-BY-4.0\",", "");
    assert!(write_catalog(&bundle, &no_license).is_ok());
    assert!(parse(&bundle).is_err());

    let bad_capability = scene_json("community.test", "scenes/test/index.html")
      .replace("wallpaper.viewport", "widget.native");
    assert!(write_catalog(&bundle, &bad_capability).is_ok());
    assert!(parse(&bundle).is_err());

    let two = scene_json("community.a", "scenes/test/index.html");
    let body = format!("{{\"schemaVersion\":1,\"scenes\":[{two},{two}]}}");
    assert!(std::fs::write(bundle.join(MANIFEST_FILE), body).is_ok());
    assert!(parse(&bundle).is_err(), "多场景在 v1 必须被拒绝");

    let _ = std::fs::remove_dir_all(&bundle);
  }

  #[test]
  fn external_params_and_sync_require_script_capability() {
    let Some(bundle) = temp_bundle("script") else {
      return;
    };
    let base = scene_json("community.test", "scenes/test/index.html");
    let params_no_script = base.replace(
      "\"capabilities\": [\"wallpaper.viewport\"]",
      "\"capabilities\": [\"wallpaper.viewport\", \"wallpaper.params\"],\n        \"params\": [{\"key\":\"density\",\"type\":\"number\",\"label\":\"密度\",\"default\":0.5}]",
    );
    assert!(write_catalog(&bundle, &params_no_script).is_ok());
    assert!(parse(&bundle).is_err(), "params 没有 script 必须拒绝");

    let params_with_script = params_no_script.replace(
      "\"wallpaper.params\"]",
      "\"wallpaper.params\", \"wallpaper.script\"]",
    );
    assert!(write_catalog(&bundle, &params_with_script).is_ok());
    assert!(parse(&bundle).is_ok(), "params + script 必须通过");

    let sync_no_script = base.replace(
      "\"wallpaper.viewport\"",
      "\"wallpaper.viewport\", \"wallpaper.sync\"",
    );
    assert!(write_catalog(&bundle, &sync_no_script).is_ok());
    assert!(parse(&bundle).is_err(), "sync 没有 script 必须拒绝");

    let _ = std::fs::remove_dir_all(&bundle);
  }

  #[test]
  fn rejects_bad_integrity_shape() {
    let Some(bundle) = temp_bundle("digest") else {
      return;
    };
    let scene = scene_json("community.test", "scenes/test/index.html").replace(
      "\"capabilities\"",
      "\"integrity\": {\"algorithm\": \"md5\", \"scope\": \"package\", \"digest\": \"",
    );
    assert!(write_catalog(&bundle, &scene).is_ok());
    assert!(parse(&bundle).is_err());
    let _ = std::fs::remove_dir_all(&bundle);
  }
}
