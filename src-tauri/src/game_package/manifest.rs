//! `game.json` v1：第三方游戏包的清单校验。
//!
//! 与 scene/widget 清单一样走"字段少而稳定、未知字段直接拒绝"的策略；
//! 清单只描述包，不参与运行期授权（授权在 `.grants.json`）。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const HOST_API: u32 = 1;
pub const MANIFEST_FILE: &str = "game.json";

pub const PACKAGE_CAPABILITIES: &[&str] = &[
  "game.state.read",
  "game.state.write",
  "game.command.receive",
  "game.event.publish",
  "game.event.read",
  "game.render.publish",
  "game.network",
];

/// 宿主保留、任何游戏包都不能申请的能力。
pub const RESERVED_CAPABILITIES: &[&str] = &[
  "game.authority.claim",
  "game.instance.manage",
  "game.storage.raw",
  "game.window",
];

pub const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;
pub const DEFAULT_STATE_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_MAX_REPLICAS: u32 = 8;
pub const DEFAULT_TICK_MS: u64 = 1_000;
pub const DEFAULT_FLUSH_MS: u64 = 1_000;
pub const MAX_COMMAND_TIMEOUT_MS: u64 = 8_000;

const RENDER_MODES: [&str; 5] = ["canvas2d", "webgl", "webgpu", "dom", "custom"];
const AUTHORITY_MODES: [&str; 2] = ["host-tick", "self-loop"];
const DISPLAY_MODES: [&str; 2] = ["mirror", "span"];

#[derive(Debug, Clone)]
pub struct ManifestError {
  pub code: &'static str,
  pub message: String,
}

impl ManifestError {
  fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for ManifestError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}: {}", self.code, self.message)
  }
}

impl From<ManifestError> for String {
  fn from(error: ManifestError) -> Self {
    error.message
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameEntry {
  pub authority: String,
  #[serde(default)]
  pub replica: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameEngine {
  #[serde(default = "default_engine_id")]
  pub id: String,
  #[serde(default)]
  pub version: Option<String>,
  #[serde(default)]
  pub adapter: Option<String>,
  #[serde(default = "default_render_mode")]
  pub render_mode: String,
}

fn default_engine_id() -> String {
  "custom".to_string()
}

fn default_render_mode() -> String {
  "canvas2d".to_string()
}

impl Default for GameEngine {
  fn default() -> Self {
    Self {
      id: default_engine_id(),
      version: None,
      adapter: None,
      render_mode: default_render_mode(),
    }
  }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitPolicy {
  #[serde(default)]
  pub flush_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameRuntime {
  pub authority: String,
  #[serde(default)]
  pub tick_ms: Option<u64>,
  #[serde(default)]
  pub replicas: Option<bool>,
  #[serde(default)]
  pub max_replicas: Option<u32>,
  #[serde(default)]
  pub commit: Option<CommitPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameDisplay {
  pub policy: String,
  #[serde(default)]
  pub modes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameStateSpec {
  pub schema_version: u32,
  #[serde(default)]
  pub max_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDecl {
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub idempotent: Option<bool>,
  #[serde(default)]
  pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventDecl {
  #[serde(default)]
  pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameManifest {
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
  pub license: String,
  pub host_api: u32,
  pub entry: GameEntry,
  #[serde(default)]
  pub engine: GameEngine,
  pub runtime: GameRuntime,
  pub display: GameDisplay,
  pub capabilities: Vec<String>,
  pub commands: BTreeMap<String, CommandDecl>,
  #[serde(default)]
  pub events: BTreeMap<String, EventDecl>,
  pub state: GameStateSpec,
  #[serde(default)]
  pub network: Vec<String>,
}

impl GameManifest {
  /// 读取并校验 `<dir>/game.json`；`dir_name` 用于要求目录名与 id 一致。
  pub fn load(dir: &Path, dir_name: &str) -> Result<Self, ManifestError> {
    let manifest = Self::from_dir(dir)?;
    if manifest.id != dir_name {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("清单 id={} 与目录名 {dir_name} 不一致", manifest.id),
      ));
    }
    Ok(manifest)
  }

  /// 安装/预览时读取清单：此时目录名还没确定为 id，不校验目录名。
  pub fn from_dir(dir: &Path) -> Result<Self, ManifestError> {
    let path = dir.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&path).map_err(|error| {
      ManifestError::new(
        "game.package_not_found",
        format!("读取 {} 失败：{error}", path.display()),
      )
    })?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|error| {
      ManifestError::new(
        "game.manifest_invalid",
        format!("解析 game.json 失败：{error}"),
      )
    })?;
    let manifest: Self = serde_json::from_value(value).map_err(|error| {
      ManifestError::new(
        "game.manifest_invalid",
        format!("game.json 字段非法：{error}"),
      )
    })?;
    manifest.validate()?;
    Ok(manifest)
  }

  pub fn validate(&self) -> Result<(), ManifestError> {
    if self.schema_version != SCHEMA_VERSION {
      return Err(ManifestError::new(
        "game.unsupported_schema",
        format!(
          "不支持的 schemaVersion={}（当前支持 {SCHEMA_VERSION}）",
          self.schema_version
        ),
      ));
    }
    if self.kind != "game" {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "type 必须是 game",
      ));
    }
    if !valid_id(&self.id) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("id 非法：{}", self.id),
      ));
    }
    if self.name.trim().is_empty() || self.name.chars().count() > 64 {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "name 必须是 1-64 字符",
      ));
    }
    if !valid_version(&self.version) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("version 不是语义化版本：{}", self.version),
      ));
    }
    if self.license.trim().is_empty() {
      return Err(ManifestError::new("game.manifest_invalid", "license 必填"));
    }
    if self.host_api == 0 || self.host_api > HOST_API {
      return Err(ManifestError::new(
        "game.unsupported_host_api",
        format!("hostApi {} 超出宿主支持范围（1-{HOST_API}）", self.host_api),
      ));
    }
    if !is_safe_entry(&self.entry.authority) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!(
          "entry.authority 必须是包内相对 .html：{}",
          self.entry.authority
        ),
      ));
    }
    if let Some(replica) = &self.entry.replica {
      if !is_safe_entry(replica) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("entry.replica 必须是包内相对 .html：{replica}"),
        ));
      }
    }

    if self.capabilities.is_empty() {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "capabilities 必须是非空数组",
      ));
    }
    let mut seen = std::collections::HashSet::new();
    for capability in &self.capabilities {
      if RESERVED_CAPABILITIES.contains(&capability.as_str()) {
        return Err(ManifestError::new(
          "permission.denied",
          format!("宿主保留能力不可申请：{capability}"),
        ));
      }
      if !PACKAGE_CAPABILITIES.contains(&capability.as_str()) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("未知 capability：{capability}"),
        ));
      }
      if !seen.insert(capability) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("capability 重复：{capability}"),
        ));
      }
    }

    if self.engine.id.trim().is_empty() || self.engine.id.chars().count() > 64 {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "engine.id 必须是 1-64 字符",
      ));
    }
    if !RENDER_MODES.contains(&self.engine.render_mode.as_str()) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("未知 engine.renderMode：{}", self.engine.render_mode),
      ));
    }

    if !AUTHORITY_MODES.contains(&self.runtime.authority.as_str()) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("未知 runtime.authority：{}", self.runtime.authority),
      ));
    }
    if let Some(tick) = self.runtime.tick_ms {
      if !(200..=60_000).contains(&tick) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          "runtime.tickMs 必须在 200-60000 之间",
        ));
      }
    }
    if let Some(max) = self.runtime.max_replicas {
      if !(1..=16).contains(&max) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          "runtime.maxReplicas 必须在 1-16 之间",
        ));
      }
    }
    if let Some(commit) = &self.runtime.commit {
      if let Some(flush) = commit.flush_ms {
        if !(250..=10_000).contains(&flush) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            "runtime.commit.flushMs 必须在 250-10000 之间",
          ));
        }
      }
    }

    if self.display.policy != "shared" {
      return Err(ManifestError::new(
        "game.unsupported_display_policy",
        "首期只支持 display.policy=shared",
      ));
    }
    if let Some(modes) = &self.display.modes {
      if modes.is_empty() {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          "display.modes 不能是空数组",
        ));
      }
      for mode in modes {
        if !DISPLAY_MODES.contains(&mode.as_str()) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!("未知 display.modes：{mode}"),
          ));
        }
      }
    }

    if self.commands.len() > 128 {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "commands 最多声明 128 条",
      ));
    }
    for (kind, decl) in &self.commands {
      if !valid_symbol(kind) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("命令类型非法：{kind}"),
        ));
      }
      if let Some(timeout) = decl.timeout_ms {
        if timeout == 0 || timeout > MAX_COMMAND_TIMEOUT_MS {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!("commands.{kind}.timeoutMs 必须在 1-{MAX_COMMAND_TIMEOUT_MS} 之间"),
          ));
        }
      }
    }
    for kind in self.events.keys() {
      if !valid_symbol(kind) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("事件类型非法：{kind}"),
        ));
      }
    }

    if self.state.schema_version == 0 {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "state.schemaVersion 必须是正整数",
      ));
    }
    if let Some(size) = self.state.max_size_bytes {
      if size == 0 || size > MAX_STATE_BYTES {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("state.maxSizeBytes 必须在 1-{MAX_STATE_BYTES} 之间"),
        ));
      }
    }

    for origin in &self.network {
      if !valid_network_origin(origin) {
        return Err(ManifestError::new(
          "network.origin_denied",
          format!("network 只允许 https:// 或 wss:// 源：{origin}"),
        ));
      }
    }
    if !self.network.is_empty() && !self.capabilities.iter().any(|cap| cap == "game.network") {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "声明 network 时必须同时申请 game.network 能力",
      ));
    }

    Ok(())
  }

  #[must_use]
  pub fn tick_ms(&self) -> u64 {
    self.runtime.tick_ms.unwrap_or(DEFAULT_TICK_MS)
  }

  #[must_use]
  pub fn flush_ms(&self) -> u64 {
    self
      .runtime
      .commit
      .as_ref()
      .and_then(|commit| commit.flush_ms)
      .unwrap_or(DEFAULT_FLUSH_MS)
  }

  #[must_use]
  pub fn max_replicas(&self) -> u32 {
    self.runtime.max_replicas.unwrap_or(DEFAULT_MAX_REPLICAS)
  }

  #[must_use]
  pub fn max_state_bytes(&self) -> u64 {
    self.state.max_size_bytes.unwrap_or(DEFAULT_STATE_BYTES)
  }
}

#[must_use]
pub fn valid_id(id: &str) -> bool {
  let count = id.chars().count();
  if !(3..=64).contains(&count) {
    return false;
  }
  let mut chars = id.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
    return false;
  }
  id.chars()
    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

/// 命令/事件类型名：小写字母开头，允许点/下划线/连字符，1-64 字符。
#[must_use]
pub fn valid_symbol(name: &str) -> bool {
  let count = name.chars().count();
  if !(1..=64).contains(&count) {
    return false;
  }
  let mut chars = name.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !first.is_ascii_lowercase() {
    return false;
  }
  name
    .chars()
    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

fn valid_version(version: &str) -> bool {
  let core = version.split(['-', '+']).next().unwrap_or_default();
  let mut parts = core.split('.');
  let mut count = 0;
  for part in &mut parts {
    if part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()) {
      return false;
    }
    count += 1;
  }
  count == 3
}

#[must_use]
pub fn is_safe_entry(entry: &str) -> bool {
  if entry.is_empty() || entry.len() > 256 {
    return false;
  }
  if entry.starts_with('/') || entry.contains('\\') || entry.contains(':') {
    return false;
  }
  if entry
    .split('/')
    .any(|segment| segment.is_empty() || segment == "." || segment == "..")
  {
    return false;
  }
  entry.ends_with(".html")
    && entry
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'))
}

fn valid_network_origin(origin: &str) -> bool {
  if origin.is_empty() || origin.len() > 128 || origin.chars().any(char::is_whitespace) {
    return false;
  }
  (origin.starts_with("https://") && origin.len() > 8)
    || (origin.starts_with("wss://") && origin.len() > 6)
}

#[cfg(test)]
fn default_manifest_value() -> serde_json::Value {
  serde_json::json!({
    "schemaVersion": 1,
    "type": "game",
    "id": "community.living-world",
    "name": "Living World",
    "version": "1.0.0",
    "license": "MIT",
    "hostApi": 1,
    "entry": { "authority": "authority/index.html" },
    "runtime": { "authority": "host-tick" },
    "display": { "policy": "shared", "modes": ["mirror", "span"] },
    "capabilities": [
      "game.state.read",
      "game.state.write",
      "game.command.receive",
      "game.event.publish",
      "game.event.read",
      "game.render.publish"
    ],
    "commands": { "plant.seed": { "description": "种下一颗种子" } },
    "events": { "world.changed": { "description": "世界变化" } },
    "state": { "schemaVersion": 1, "maxSizeBytes": 1048576 }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse(value: serde_json::Value) -> Result<GameManifest, ManifestError> {
    let manifest: GameManifest = serde_json::from_value(value)
      .map_err(|error| ManifestError::new("game.manifest_invalid", error.to_string()))?;
    manifest.validate()?;
    Ok(manifest)
  }

  #[test]
  fn minimal_manifest_is_valid_and_defaults_are_applied() {
    let manifest = parse(default_manifest_value()).expect("valid");
    assert_eq!(manifest.engine.id, "custom");
    assert_eq!(manifest.engine.render_mode, "canvas2d");
    assert_eq!(manifest.tick_ms(), 1000);
    assert_eq!(manifest.max_replicas(), 8);
    assert_eq!(manifest.max_state_bytes(), DEFAULT_STATE_BYTES);
    assert!(manifest.commands.contains_key("plant.seed"));
  }

  #[test]
  fn unknown_fields_are_rejected() {
    let mut value = default_manifest_value();
    value["unknownField"] = serde_json::json!(true);
    let error = serde_json::from_value::<GameManifest>(value).expect_err("must reject");
    assert!(error.to_string().contains("unknownField"));
  }

  #[test]
  fn per_monitor_and_bad_paths_are_rejected() {
    let mut value = default_manifest_value();
    value["display"]["policy"] = serde_json::json!("per-monitor");
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.unsupported_display_policy")
    );
    let mut value = default_manifest_value();
    value["entry"]["authority"] = serde_json::json!("../escape.html");
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.manifest_invalid")
    );
  }

  #[test]
  fn reserved_and_unknown_capabilities_are_rejected() {
    let mut value = default_manifest_value();
    value["capabilities"] = serde_json::json!(["game.storage.raw"]);
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("permission.denied")
    );
    let mut value = default_manifest_value();
    value["capabilities"] = serde_json::json!(["game.unknown"]);
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.manifest_invalid")
    );
  }

  #[test]
  fn network_requires_capability_and_https() {
    let mut value = default_manifest_value();
    value["network"] = serde_json::json!(["https://example.com"]);
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.manifest_invalid")
    );
    let mut value = default_manifest_value();
    value["capabilities"]
      .as_array_mut()
      .expect("capabilities")
      .push(serde_json::json!("game.network"));
    value["network"] = serde_json::json!(["http://example.com"]);
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("network.origin_denied")
    );
  }

  #[test]
  fn ids_and_symbols_are_strict() {
    assert!(valid_id("community.living-world"));
    assert!(!valid_id("Bad.Id"));
    assert!(!valid_id("ab"));
    assert!(valid_symbol("plant.seed"));
    assert!(!valid_symbol("Plant.Seed"));
    let mut value = default_manifest_value();
    value["commands"] = serde_json::json!({"Bad": {}});
    assert!(parse(value).is_err());
  }

  #[test]
  fn versions_are_three_segments() {
    assert!(valid_version("1.0.0"));
    assert!(valid_version("1.0.0-beta.1"));
    assert!(!valid_version("1.0"));
    assert!(!valid_version("v1.0.0"));
  }

  #[test]
  fn example_game_manifest_is_valid() {
    let dir =
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/games/living-world");
    let manifest = GameManifest::from_dir(&dir).expect("example game.json");
    assert_eq!(manifest.id, "community.living-world");
    assert_eq!(manifest.runtime.authority, "host-tick");
    assert!(dir.join(&manifest.entry.authority).is_file());
    assert!(manifest.commands.contains_key("plant.seed"));
  }
}
