//! 第三方 Widget 包清单（schemaVersion 2）与校验。
//!
//! 插件包由用户安装到 `%APPDATA%\\app.lull.desktop\\widgets\\<id>\\`，
//! 清单是宿主创建窗口、授权与加载 iframe 的唯一依据；这里不信任任何字段。

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SCHEMA_VERSION: u32 = 2;
pub const HOST_API: u32 = 1;

/// 第三方可申请的能力；`chrome` / `window` / `native` 只属于宿主。
pub const PLUGIN_CAPABILITIES: &[&str] = &[
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.network",
  "widget.chrome",
];

const MIN_WIDTH: f64 = 320.0;
const MAX_WIDTH: f64 = 1600.0;
const MIN_HEIGHT: f64 = 240.0;
const MAX_HEIGHT: f64 = 1200.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpec {
  pub width: f64,
  pub height: f64,
  #[serde(default)]
  pub min_width: Option<f64>,
  #[serde(default)]
  pub min_height: Option<f64>,
  #[serde(default)]
  pub resizable: bool,
  #[serde(default = "default_transparent")]
  pub transparent: bool,
  /// `host`：宿主绘制顶栏；`custom`：插件自己绘制拖拽区与窗口按钮。
  #[serde(default = "default_chrome")]
  pub chrome: String,
}

fn default_transparent() -> bool {
  true
}

fn default_chrome() -> String {
  "host".to_string()
}

impl Default for WindowSpec {
  fn default() -> Self {
    Self {
      width: 560.0,
      height: 640.0,
      min_width: None,
      min_height: None,
      resizable: false,
      transparent: true,
      chrome: default_chrome(),
    }
  }
}

impl WindowSpec {
  pub fn min_width(&self) -> f64 {
    self.min_width.unwrap_or(self.width)
  }

  pub fn min_height(&self) -> f64 {
    self.min_height.unwrap_or(self.height)
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
  pub schema_version: u32,
  #[serde(rename = "type")]
  pub kind: String,
  pub id: String,
  pub name: String,
  pub version: String,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub author: Option<String>,
  #[serde(default)]
  pub license: Option<String>,
  #[serde(default)]
  pub builtin: bool,
  #[serde(default = "default_host_api")]
  pub host_api: u32,
  pub entry: String,
  #[serde(default)]
  pub capabilities: Vec<String>,
  pub window: WindowSpec,
  #[serde(default)]
  pub network: Vec<String>,
}

fn default_host_api() -> u32 {
  HOST_API
}

impl PackageManifest {
  /// 读取并校验 `<dir>/widget.json`；`dir_name` 必须与清单 id 一致。
  pub fn load(dir: &Path, dir_name: &str) -> Result<Self, String> {
    let path = dir.join("widget.json");
    let text = std::fs::read_to_string(&path)
      .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let manifest: Self = serde_json::from_str(&text)
      .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
    manifest.validate(dir_name)?;
    Ok(manifest)
  }

  fn validate(&self, dir_name: &str) -> Result<(), String> {
    if self.schema_version != SCHEMA_VERSION {
      return Err(format!(
        "schemaVersion 必须是 {SCHEMA_VERSION}，当前为 {}",
        self.schema_version
      ));
    }
    if self.kind != "widget" {
      return Err("type 必须是 widget".to_string());
    }
    if !valid_id(&self.id) {
      return Err(format!("id 非法：{}", self.id));
    }
    if self.id != dir_name {
      return Err(format!(
        "id 必须与目录名一致：目录 {dir_name}，清单 {}",
        self.id
      ));
    }
    if self.name.trim().is_empty() || self.name.chars().count() > 64 {
      return Err("name 必须是 1-64 字符".to_string());
    }
    if !valid_version(&self.version) {
      return Err(format!("version 不是语义化版本：{}", self.version));
    }
    if self.builtin {
      return Err("用户插件目录不接受 builtin=true".to_string());
    }
    if self.host_api == 0 || self.host_api > HOST_API {
      return Err(format!(
        "hostApi {} 超出宿主支持范围（1-{HOST_API}）",
        self.host_api
      ));
    }
    if !safe_entry(&self.entry) {
      return Err(format!("entry 必须是包内的相对 .html 路径：{}", self.entry));
    }
    if !self.window.width.is_finite()
      || !self.window.height.is_finite()
      || self.window.width < MIN_WIDTH
      || self.window.width > MAX_WIDTH
      || self.window.height < MIN_HEIGHT
      || self.window.height > MAX_HEIGHT
    {
      return Err(format!(
        "窗口尺寸必须在 {MIN_WIDTH}x{MIN_HEIGHT} - {MAX_WIDTH}x{MAX_HEIGHT} 之间"
      ));
    }
    if self.window.resizable {
      return Err("首期插件窗口固定尺寸，不能声明 resizable=true".to_string());
    }
    if self.window.min_width() > self.window.width || self.window.min_height() > self.window.height
    {
      return Err("最小尺寸不能大于初始尺寸".to_string());
    }
    match self.window.chrome.as_str() {
      "host" => {}
      "custom" => {
        if !self
          .capabilities
          .iter()
          .any(|capability| capability == "widget.chrome")
        {
          return Err("window.chrome=custom 必须同时申请 widget.chrome 能力".to_string());
        }
      }
      other => {
        return Err(format!(
          "window.chrome 只能是 host 或 custom，当前为 {other}"
        ));
      }
    }
    let mut seen = std::collections::HashSet::new();
    for capability in &self.capabilities {
      if !PLUGIN_CAPABILITIES.contains(&capability.as_str()) {
        return Err(format!("插件不能申请能力：{capability}"));
      }
      if !seen.insert(capability) {
        return Err(format!("能力重复：{capability}"));
      }
    }
    if self.capabilities.iter().any(|cap| cap == "widget.network") != !self.network.is_empty() {
      return Err("widget.network 能力与 network 白名单必须同时出现".to_string());
    }
    for source in &self.network {
      validate_network_source(source)?;
    }
    Ok(())
  }
}

pub(crate) fn valid_id(id: &str) -> bool {
  let Some(first) = id.chars().next() else {
    return false;
  };
  if !first.is_ascii_lowercase() || id.len() < 2 || id.len() > 32 {
    return false;
  }
  id.chars()
    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn valid_version(version: &str) -> bool {
  let mut parts = version.split('.');
  let Some(major) = parts.next() else {
    return false;
  };
  let Some(minor) = parts.next() else {
    return false;
  };
  let Some(patch) = parts.next() else {
    return false;
  };
  if parts.next().is_some() {
    return false;
  }
  [major, minor, patch]
    .iter()
    .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn safe_entry(entry: &str) -> bool {
  !entry.is_empty()
    && entry.len() <= 128
    && entry.ends_with(".html")
    && !entry.starts_with('/')
    && !entry.contains('\\')
    && !entry.contains('%')
    && entry
      .split('/')
      .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn validate_network_source(source: &str) -> Result<(), String> {
  let allowed = source.starts_with("https://") || source.starts_with("http://localhost:");
  if !allowed || source.contains([' ', ';', '\n', '\r', '\t', '"', '\'']) || source.len() > 256 {
    return Err(format!(
      "network 只允许 https:// 或 http://localhost: 源：{source}"
    ));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn base() -> PackageManifest {
    PackageManifest {
      schema_version: SCHEMA_VERSION,
      kind: "widget".to_string(),
      id: "community-pomodoro".to_string(),
      name: "番茄钟".to_string(),
      version: "1.0.0".to_string(),
      description: None,
      author: None,
      license: None,
      builtin: false,
      host_api: HOST_API,
      entry: "index.html".to_string(),
      capabilities: vec!["widget.state".to_string(), "widget.theme".to_string()],
      window: WindowSpec {
        width: 560.0,
        height: 640.0,
        min_width: None,
        min_height: None,
        resizable: false,
        transparent: true,
        chrome: "host".to_string(),
      },
      network: Vec::new(),
    }
  }

  #[test]
  fn valid_manifest_passes() {
    assert!(base().validate("community-pomodoro").is_ok());
  }

  #[test]
  fn rejects_window_and_native_capabilities() {
    for capability in ["widget.window", "widget.native"] {
      let mut manifest = base();
      manifest.capabilities.push(capability.to_string());
      assert!(
        manifest.validate("community-pomodoro").is_err(),
        "{capability}"
      );
    }
  }

  #[test]
  fn rejects_unsafe_entry() {
    for entry in ["../index.html", "/index.html", "a\\b.html", "index.js"] {
      let mut manifest = base();
      manifest.entry = entry.to_string();
      assert!(manifest.validate("community-pomodoro").is_err(), "{entry}");
    }
  }

  #[test]
  fn rejects_network_without_capability() {
    let mut manifest = base();
    manifest.network.push("https://api.example.com".to_string());
    assert!(manifest.validate("community-pomodoro").is_err());
  }

  #[test]
  fn accepts_network_with_capability() {
    let mut manifest = base();
    manifest.capabilities.push("widget.network".to_string());
    manifest.network.push("https://api.example.com".to_string());
    assert!(manifest.validate("community-pomodoro").is_ok());
  }

  #[test]
  fn custom_chrome_requires_capability() {
    let mut manifest = base();
    manifest.window.chrome = "custom".to_string();
    assert!(manifest.validate("community-pomodoro").is_err());
    manifest.capabilities.push("widget.chrome".to_string());
    assert!(manifest.validate("community-pomodoro").is_ok());
  }

  #[test]
  fn rejects_unknown_chrome_mode() {
    let mut manifest = base();
    manifest.window.chrome = "frameless".to_string();
    assert!(manifest.validate("community-pomodoro").is_err());
  }

  #[test]
  fn rejects_resizable_and_bad_ids() {
    let mut manifest = base();
    manifest.window.resizable = true;
    assert!(manifest.validate("community-pomodoro").is_err());
    for id in ["Community", "a", "a_b", "a.b"] {
      let mut manifest = base();
      manifest.id = id.to_string();
      assert!(manifest.validate("community-pomodoro").is_err(), "{id}");
    }
  }
}
