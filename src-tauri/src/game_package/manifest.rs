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

/// 单个游戏最多声明的控制器窗口数。
pub const MAX_CONTROLLERS: usize = 8;
/// 包内控制器窗口的尺寸范围（逻辑像素）。
pub const MIN_CONTROLLER_WIDTH: f64 = 240.0;
pub const MAX_CONTROLLER_WIDTH: f64 = 1_600.0;
pub const MIN_CONTROLLER_HEIGHT: f64 = 200.0;
pub const MAX_CONTROLLER_HEIGHT: f64 = 1_200.0;
pub const DEFAULT_CONTROLLER_WIDTH: f64 = 360.0;
pub const DEFAULT_CONTROLLER_HEIGHT: f64 = 420.0;

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

/// 控制器窗口的载体：包内页面（`entry`）或外部 Widget（`widgetId`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameControllerKind {
  Package,
  Widget,
}

/// 包内控制器窗口的尺寸偏好；缺省为固定 360×420。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameControllerWindow {
  #[serde(default = "default_controller_width")]
  pub width: f64,
  #[serde(default = "default_controller_height")]
  pub height: f64,
  #[serde(default)]
  pub min_width: Option<f64>,
  #[serde(default)]
  pub min_height: Option<f64>,
  #[serde(default)]
  pub resizable: bool,
  #[serde(default)]
  pub always_on_top: bool,
}

fn default_controller_width() -> f64 {
  DEFAULT_CONTROLLER_WIDTH
}

fn default_controller_height() -> f64 {
  DEFAULT_CONTROLLER_HEIGHT
}

fn default_true() -> bool {
  true
}

/// 游戏声明的控制器窗口。
///
/// 两种载体二选一：`entry` = 游戏包自带页面（宿主壳 + iframe），`widgetId` =
/// 外部 Widget 包（跨游戏复用）。`commands`/`events` 可把该控制器的能力收窄到
/// 子集；缺省表示全部声明项，`[]` 表示只读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameController {
  /// 槽位 id；旧的单数 `controller` 归一化后为 `default`。
  #[serde(default)]
  pub id: String,
  #[serde(default)]
  pub label: Option<String>,
  #[serde(default)]
  pub entry: Option<String>,
  #[serde(default)]
  pub widget_id: Option<String>,
  #[serde(default)]
  pub commands: Option<Vec<String>>,
  #[serde(default)]
  pub events: Option<Vec<String>>,
  #[serde(default)]
  pub window: Option<GameControllerWindow>,
  #[serde(default = "default_true")]
  pub auto_open: bool,
}

impl GameController {
  #[must_use]
  pub fn kind(&self) -> GameControllerKind {
    if self.widget_id.is_some() {
      GameControllerKind::Widget
    } else {
      GameControllerKind::Package
    }
  }

  #[must_use]
  pub fn width(&self) -> f64 {
    self
      .window
      .as_ref()
      .map_or(DEFAULT_CONTROLLER_WIDTH, |window| window.width)
  }

  #[must_use]
  pub fn height(&self) -> f64 {
    self
      .window
      .as_ref()
      .map_or(DEFAULT_CONTROLLER_HEIGHT, |window| window.height)
  }

  #[must_use]
  pub fn min_width(&self) -> f64 {
    self
      .window
      .as_ref()
      .and_then(|window| window.min_width)
      .unwrap_or_else(|| self.width())
  }

  #[must_use]
  pub fn min_height(&self) -> f64 {
    self
      .window
      .as_ref()
      .and_then(|window| window.min_height)
      .unwrap_or_else(|| self.height())
  }

  #[must_use]
  pub fn resizable(&self) -> bool {
    self
      .window
      .as_ref()
      .is_some_and(|window| window.resizable)
  }

  #[must_use]
  pub fn always_on_top(&self) -> bool {
    self
      .window
      .as_ref()
      .is_some_and(|window| window.always_on_top)
  }
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
  /// 控制器窗口声明（0–8 个）。UI 由游戏包自带页面或外部 Widget 提供。
  #[serde(default)]
  pub controllers: Vec<GameController>,
  /// 旧的单数控制器声明；`from_dir` 会归一化进 `controllers`，仅为兼容保留。
  #[serde(default)]
  pub controller: Option<GameController>,
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
    let mut manifest = manifest;
    manifest.normalize();
    manifest.validate()?;
    Ok(manifest)
  }

  /// 兼容旧的单数 `controller`：归一化为 `controllers[0]`（id=`default`）。
  ///
  /// 两者同时声明时不做合并，交由 `validate()` 报错；`controllers` 已存在时
  /// 旧字段保持原样，保证校验能发现冲突。
  pub fn normalize(&mut self) {
    if !self.controllers.is_empty() {
      return;
    }
    let Some(mut legacy) = self.controller.take() else {
      return;
    };
    if legacy.id.is_empty() {
      legacy.id = "default".to_string();
    }
    self.controllers.push(legacy);
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

    if !self.controllers.is_empty() && self.controller.is_some() {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        "controller 与 controllers 不能同时声明：单数 controller 已废弃，请改用 controllers 数组",
      ));
    }
    if self.controllers.len() > MAX_CONTROLLERS {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("controllers 最多声明 {MAX_CONTROLLERS} 个"),
      ));
    }
    let mut controller_ids = std::collections::HashSet::new();
    let mut controller_widgets = std::collections::HashSet::new();
    for controller in &self.controllers {
      self.validate_controller(controller)?;
      if !controller_ids.insert(controller.id.as_str()) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("controllers.id 重复：{}", controller.id),
        ));
      }
      if let Some(widget_id) = controller.widget_id.as_deref() {
        if !controller_widgets.insert(widget_id) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!("同一个游戏不能重复声明控制器 Widget：{widget_id}"),
          ));
        }
      }
    }
    if let Some(legacy) = &self.controller {
      if legacy.entry.is_some()
        || legacy.commands.is_some()
        || legacy.events.is_some()
        || legacy.window.is_some()
      {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          "旧 controller 只支持 widgetId / label，请改用 controllers 数组",
        ));
      }
      let Some(widget_id) = legacy.widget_id.as_deref() else {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          "controller.widgetId 必填",
        ));
      };
      if !crate::widget_package::manifest::valid_id(widget_id) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("controller.widgetId 非法：{widget_id}"),
        ));
      }
      if let Some(label) = &legacy.label {
        if label.trim().is_empty() || label.chars().count() > 64 {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            "controller.label 必须是 1-64 字符",
          ));
        }
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

  fn validate_controller(&self, controller: &GameController) -> Result<(), ManifestError> {
    if !valid_controller_id(&controller.id) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("controllers.id 非法：{}", controller.id),
      ));
    }
    let has_entry = controller.entry.is_some();
    let has_widget = controller.widget_id.is_some();
    if has_entry == has_widget {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!(
          "controllers.{} 必须且只能声明 entry 或 widgetId 之一",
          controller.id
        ),
      ));
    }
    if let Some(entry) = &controller.entry {
      if !is_safe_entry(entry) || !entry.starts_with("controllers/") {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!(
            "controllers.{}.entry 必须是 controllers/ 下的包内相对 .html：{entry}",
            controller.id
          ),
        ));
      }
    }
    if let Some(widget_id) = &controller.widget_id {
      if !crate::widget_package::manifest::valid_id(widget_id) {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!("controllers.{}.widgetId 非法：{widget_id}", controller.id),
        ));
      }
    }
    if let Some(label) = &controller.label {
      if label.trim().is_empty() || label.chars().count() > 64 {
        return Err(ManifestError::new(
          "game.manifest_invalid",
          format!(
            "controllers.{}.label 必须是 1-64 字符",
            controller.id
          ),
        ));
      }
    }
    if let Some(commands) = &controller.commands {
      let mut seen = std::collections::HashSet::new();
      for kind in commands {
        if !valid_symbol(kind) || !self.commands.contains_key(kind) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!(
              "controllers.{}.commands 含未声明或非法命令：{kind}",
              controller.id
            ),
          ));
        }
        if !seen.insert(kind.as_str()) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!("controllers.{}.commands 重复：{kind}", controller.id),
          ));
        }
      }
    }
    if let Some(events) = &controller.events {
      let mut seen = std::collections::HashSet::new();
      for kind in events {
        if !valid_symbol(kind) || !self.events.contains_key(kind) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!(
              "controllers.{}.events 含未声明或非法事件：{kind}",
              controller.id
            ),
          ));
        }
        if !seen.insert(kind.as_str()) {
          return Err(ManifestError::new(
            "game.manifest_invalid",
            format!("controllers.{}.events 重复：{kind}", controller.id),
          ));
        }
      }
    }
    if let Some(window) = &controller.window {
      validate_controller_window(&controller.id, window)?;
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

/// 控制器槽位 id：小写字母开头，1–32 字符，只允许小写字母/数字/连字符。
#[must_use]
pub fn valid_controller_id(id: &str) -> bool {
  let count = id.chars().count();
  if !(1..=32).contains(&count) {
    return false;
  }
  let mut chars = id.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !first.is_ascii_lowercase() {
    return false;
  }
  id.chars()
    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn validate_controller_window(
  id: &str,
  window: &GameControllerWindow,
) -> Result<(), ManifestError> {
  let width_ok = window.width.is_finite()
    && (MIN_CONTROLLER_WIDTH..=MAX_CONTROLLER_WIDTH).contains(&window.width);
  let height_ok = window.height.is_finite()
    && (MIN_CONTROLLER_HEIGHT..=MAX_CONTROLLER_HEIGHT).contains(&window.height);
  if !width_ok || !height_ok {
    return Err(ManifestError::new(
      "game.manifest_invalid",
      format!(
        "controllers.{id}.window 尺寸必须在 {MIN_CONTROLLER_WIDTH}×{MIN_CONTROLLER_HEIGHT} – \
         {MAX_CONTROLLER_WIDTH}×{MAX_CONTROLLER_HEIGHT} 之间"
      ),
    ));
  }
  if let Some(min_width) = window.min_width {
    if !min_width.is_finite() || !(MIN_CONTROLLER_WIDTH..=window.width).contains(&min_width) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!("controllers.{id}.window.minWidth 必须在 {MIN_CONTROLLER_WIDTH} 到 width 之间"),
      ));
    }
  }
  if let Some(min_height) = window.min_height {
    if !min_height.is_finite() || !(MIN_CONTROLLER_HEIGHT..=window.height).contains(&min_height) {
      return Err(ManifestError::new(
        "game.manifest_invalid",
        format!(
          "controllers.{id}.window.minHeight 必须在 {MIN_CONTROLLER_HEIGHT} 到 height 之间"
        ),
      ));
    }
  }
  Ok(())
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
    let mut manifest: GameManifest = serde_json::from_value(value)
      .map_err(|error| ManifestError::new("game.manifest_invalid", error.to_string()))?;
    manifest.normalize();
    manifest.validate()?;
    Ok(manifest)
  }

  fn controller_value() -> serde_json::Value {
    serde_json::json!([
      {
        "id": "panel",
        "label": "世界控制台",
        "entry": "controllers/panel/index.html",
        "commands": ["plant.seed"],
        "events": ["world.changed"],
        "window": { "width": 380, "height": 520, "alwaysOnTop": true }
      },
      {
        "id": "remote",
        "widgetId": "lull-living-world-controller",
        "commands": []
      }
    ])
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
    assert!(manifest.controllers.is_empty());
  }

  #[test]
  fn controllers_accept_package_and_widget_carriers() {
    let mut value = default_manifest_value();
    value["controllers"] = controller_value();
    let manifest = parse(value).expect("controllers accepted");
    assert_eq!(manifest.controllers.len(), 2);
    let panel = &manifest.controllers[0];
    assert_eq!(panel.kind(), GameControllerKind::Package);
    assert_eq!(panel.width(), 380.0);
    assert_eq!(panel.height(), 520.0);
    assert!(panel.always_on_top());
    assert!(!panel.resizable());
    assert!(panel.auto_open);
    let remote = &manifest.controllers[1];
    assert_eq!(remote.kind(), GameControllerKind::Widget);
    assert_eq!(remote.commands.as_deref(), Some(&[][..]));
  }

  #[test]
  fn controllers_reject_unknown_fields_and_invalid_declarations() {
    let mut value = default_manifest_value();
    value["controllers"] = serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "unknown": 1 }]);
    assert!(parse(value).is_err());

    for bad in [
      serde_json::json!([{ "id": "panel" }]),                                        // 载体二选一
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "widgetId": "community-x" }]),
      serde_json::json!([{ "id": "Bad Id", "widgetId": "community-x" }]),
      serde_json::json!([{ "id": "panel", "entry": "authority/index.html" }]),       // 不在 controllers/
      serde_json::json!([{ "id": "panel", "entry": "controllers/../escape.html" }]),
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "commands": ["unknown.cmd"] }]),
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "events": ["unknown.event"] }]),
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "label": "" }]),
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "window": { "width": 100, "height": 200 } }]),
      serde_json::json!([{ "id": "panel", "entry": "controllers/a.html", "window": { "width": 900, "height": 300, "minWidth": 1000 } }]),
    ] {
      let mut value = default_manifest_value();
      value["controllers"] = bad;
      assert_eq!(
        parse(value).err().map(|error| error.code),
        Some("game.manifest_invalid")
      );
    }
  }

  #[test]
  fn controllers_require_unique_ids_and_widgets_and_at_most_eight() {
    let mut value = default_manifest_value();
    value["controllers"] = serde_json::json!([
      { "id": "panel", "entry": "controllers/a.html" },
      { "id": "panel", "entry": "controllers/b.html" }
    ]);
    assert!(parse(value).is_err());

    let mut value = default_manifest_value();
    value["controllers"] = serde_json::json!([
      { "id": "a", "widgetId": "lull-ambient-controller" },
      { "id": "b", "widgetId": "lull-ambient-controller" }
    ]);
    assert!(parse(value).is_err());

    let mut value = default_manifest_value();
    value["controllers"] = serde_json::Value::Array(
      (0..=MAX_CONTROLLERS)
        .map(|index| serde_json::json!({ "id": format!("c{index}"), "entry": "controllers/a.html" }))
        .collect(),
    );
    assert!(parse(value).is_err());
  }

  #[test]
  fn legacy_single_controller_is_normalized() {
    let mut value = default_manifest_value();
    value["controller"] = serde_json::json!({ "widgetId": "lull-living-world-controller" });
    let manifest = parse(value).expect("legacy accepted");
    assert_eq!(manifest.controllers.len(), 1);
    assert_eq!(manifest.controllers[0].id, "default");
    assert_eq!(
      manifest.controllers[0].widget_id.as_deref(),
      Some("lull-living-world-controller")
    );

    let mut value = default_manifest_value();
    value["controller"] = serde_json::json!({ "widgetId": "Bad Id!" });
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.manifest_invalid")
    );

    let mut value = default_manifest_value();
    value["controller"] = serde_json::json!({ "widgetId": "community-x", "label": "" });
    assert_eq!(
      parse(value).err().map(|error| error.code),
      Some("game.manifest_invalid")
    );

    // 同时声明两种形式 → 拒绝。
    let mut value = default_manifest_value();
    value["controller"] = serde_json::json!({ "widgetId": "community-x" });
    value["controllers"] = serde_json::json!([{ "id": "panel", "entry": "controllers/a.html" }]);
    assert!(parse(value).is_err());
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
    assert!(valid_controller_id("panel"));
    assert!(valid_controller_id("a"));
    assert!(!valid_controller_id("Panel"));
    assert!(!valid_controller_id("panel.one"));
    assert!(!valid_controller_id(&"a".repeat(33)));
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
