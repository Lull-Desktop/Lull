//! 显示配置持久化：`display.json` 的数据模型、版本校验与事务式写盘。
//!
//! 设计约束：
//! - 配置缺失 / 损坏 / 不兼容版本都不得让应用启动失败；
//! - 写盘失败必须回滚调用方的内存状态（由命令层负责）；
//! - 不读取、不迁移旧版 `wallpaper.json`；版本不匹配时回退默认值并记录警告。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::media::video::config::MediaConfig;

/// 当前配置 schema 版本。v2 = Lull 命名空间。
pub const CURRENT_VERSION: u32 = 2;

/// 默认场景 id，与前端 `src/core/wallpaper/params.ts` 的 DEFAULT_SCENE_ID 对齐。
/// 竹影是随包官方场景扩展；缺包时由前端回退到内置媒体场景。
pub const DEFAULT_SCENE_ID: &str = "lull.bamboo";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MonitorConfig {
  #[serde(default = "default_true")]
  pub enabled: bool,
  /// 每屏场景覆盖（仅 independent 模式消费；None = 跟随全局）。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub scene: Option<String>,
  /// 每屏游戏覆盖（仅 independent 模式消费；None = 跟随全局）。
  /// 与场景覆盖同时存在时游戏优先；显式选场景会清掉该屏游戏。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub game: Option<String>,
}

impl Default for MonitorConfig {
  fn default() -> Self {
    Self {
      enabled: true,
      scene: None,
      game: None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WallpaperConfig {
  pub version: u32,
  #[serde(default = "default_true")]
  pub master_visible: bool,
  #[serde(default)]
  pub display: DisplayConfig,
  #[serde(default)]
  pub monitors: BTreeMap<String, MonitorConfig>,
}

fn default_true() -> bool {
  true
}

fn default_scene() -> String {
  DEFAULT_SCENE_ID.to_string()
}

/// 显示模式：复制 / 独立 / 跨屏。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
  #[default]
  Mirror,
  Independent,
  Span,
}

/// mode 宽松反序列化：未知/缺失 → Mirror（配置文件与命令参数两路统一，不因一个坏值整文件回退）。
impl<'de> serde::Deserialize<'de> for DisplayMode {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let s: Option<String> = serde::Deserialize::deserialize(deserializer)?;
    Ok(match s.as_deref() {
      Some("span") => DisplayMode::Span,
      Some("independent") => DisplayMode::Independent,
      _ => DisplayMode::Mirror,
    })
  }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DisplayConfig {
  #[serde(default)]
  pub mode: DisplayMode,
  #[serde(default = "default_true")]
  pub sync: bool,
  #[serde(default = "default_scene")]
  pub scene: String,
  /// 非空时壁纸直接渲染该游戏包的 `entry.replica`；`scene` 保留为清空游戏后的回退。
  /// mirror / span 下这是唯一内容源；independent 下作为未逐屏覆盖的显示器的回退。
  /// 与 `scene` 是两个独立字段：游戏 id 永远不会写进 `scene`。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub game: Option<String>,
  /// 按场景 id 保存的参数；值统一存字符串，由前端按 Manifest 类型还原。
  #[serde(
    default,
    skip_serializing_if = "BTreeMap::is_empty",
    rename = "sceneParams"
  )]
  pub scene_params: BTreeMap<String, BTreeMap<String, String>>,
  /// 视频壁纸配置；默认值不落盘，旧配置无需迁移。
  #[serde(default, skip_serializing_if = "MediaConfig::is_default")]
  pub media: MediaConfig,
}

impl Default for DisplayConfig {
  fn default() -> Self {
    Self {
      mode: DisplayMode::default(),
      sync: true,
      scene: default_scene(),
      game: None,
      scene_params: BTreeMap::new(),
      media: MediaConfig::default(),
    }
  }
}

impl DisplayConfig {
  /// 部分更新（None = 不改）。
  pub fn apply_patch(
    &mut self,
    mode: Option<DisplayMode>,
    sync: Option<bool>,
    scene: Option<String>,
  ) {
    if let Some(m) = mode {
      self.mode = m;
    }
    if let Some(s) = sync {
      self.sync = s;
    }
    if let Some(s) = scene {
      self.scene = s;
      // 显式选择场景 = 退出“游戏自带 renderer 作为壁纸”的状态。
      self.game = None;
    }
  }

  /// 切换壁纸内容源：`Some(game_id)` = 直接渲染游戏包自带 replica；`None` = 回到场景。
  /// 调用方负责校验 id 与包内是否存在 `entry.replica`。
  pub fn set_game(&mut self, game: Option<String>) {
    self.game = game;
  }

  /// 当前生效的游戏壁纸 id（`None` = 使用场景）。
  #[must_use]
  pub fn game_content(&self) -> Option<&str> {
    self.game.as_deref()
  }

  /// 覆盖某个场景的参数；空 map 表示恢复默认值（删除该场景的记录）。
  pub fn set_scene_params(&mut self, scene: &str, params: BTreeMap<String, String>) {
    if params.is_empty() {
      self.scene_params.remove(scene);
    } else {
      self.scene_params.insert(scene.to_string(), params);
    }
  }

  /// 某个场景已保存的参数；没有记录时返回空 map。
  pub fn params_for_scene(&self, scene: &str) -> BTreeMap<String, String> {
    self.scene_params.get(scene).cloned().unwrap_or_default()
  }
}

impl Default for WallpaperConfig {
  fn default() -> Self {
    Self {
      version: CURRENT_VERSION,
      master_visible: true,
      display: DisplayConfig::default(),
      monitors: BTreeMap::new(),
    }
  }
}

/// 配置读取结果：让上层可以记录“为什么回退”，而不是静默吞掉损坏文件。
#[derive(Debug, Clone)]
pub struct LoadOutcome {
  pub config: WallpaperConfig,
  /// 回退提示；正常读取为 None。
  pub warning: Option<String>,
}

impl WallpaperConfig {
  /// 带诊断信息的读取，启动日志与测试使用。
  pub fn load_outcome(path: &Path) -> LoadOutcome {
    let fallback = |warning: String| LoadOutcome {
      config: Self::default(),
      warning: Some(warning),
    };

    let Ok(text) = std::fs::read_to_string(path) else {
      return LoadOutcome {
        config: Self::default(),
        warning: None,
      };
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
      return fallback(format!(
        "配置不是合法 JSON，已回退默认值: {}",
        path.display()
      ));
    };
    if !value.is_object() {
      return fallback(format!(
        "配置根节点必须是 JSON 对象，已回退默认值: {}",
        path.display()
      ));
    }

    let version = value
      .get("version")
      .and_then(serde_json::Value::as_u64)
      .unwrap_or(1);
    let version = u32::try_from(version).unwrap_or(u32::MAX);

    if version != CURRENT_VERSION {
      return fallback(format!(
        "配置版本 {version} 与当前支持的 {CURRENT_VERSION} 不兼容，已回退默认值（不再迁移旧版配置）"
      ));
    }

    match serde_json::from_value::<Self>(value) {
      Ok(mut config) => {
        config.display.media = config.display.media.normalized();
        LoadOutcome {
          config,
          warning: None,
        }
      }
      Err(error) => fallback(format!("配置字段不合法，已回退默认值: {error}")),
    }
  }

  /// 事务式写盘：先写同目录临时文件，再原子替换；失败时保留原文件。
  pub fn save(&self, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
    let tmp = temp_file_path(path);
    {
      use std::io::Write;
      let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
      file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
      file.sync_all().map_err(|e| e.to_string())?;
    }
    match std::fs::rename(&tmp, path) {
      Ok(()) => Ok(()),
      Err(first) => {
        // Windows 上目标文件被占用时 rename 会失败；删除旧文件后重试一次。
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path).map_err(|second| {
          let _ = std::fs::remove_file(&tmp);
          format!("写入配置失败: {first}; 重试失败: {second}")
        })
      }
    }
  }

  /// 该显示器是否启用壁纸。没有记录 = true（新插入的显示器默认开，维持现行为）。
  pub fn monitor_enabled(&self, device: &str) -> bool {
    self.monitors.get(device).is_none_or(|m| m.enabled)
  }

  /// 记录该显示器的启用状态（保留 scene 等其它字段；离线设备也照样记）。
  pub fn set_monitor_enabled(&mut self, device: &str, enabled: bool) {
    self.monitors.entry(device.to_string()).or_default().enabled = enabled;
  }

  /// 记录该显示器的场景覆盖（None = 移除覆盖、跟随全局）。
  /// 显式选场景同时清掉该屏的游戏覆盖，保证“选了什么就显示什么”。
  pub fn set_monitor_scene(&mut self, device: &str, scene: Option<String>) {
    let monitor = self.monitors.entry(device.to_string()).or_default();
    monitor.scene = scene;
    monitor.game = None;
  }

  /// 记录该显示器的游戏覆盖（None = 移除覆盖、回退到全局/场景）。
  pub fn set_monitor_game(&mut self, device: &str, game: Option<String>) {
    self.monitors.entry(device.to_string()).or_default().game = game;
  }

  /// 全局设置游戏：同步覆盖每屏的逐屏游戏。
  ///
  /// 显式“设为壁纸 / 取消游戏壁纸”是全局动作；如果只改 `display.game`，旧逐屏游戏
  /// 会在切回 independent 时复活，和用户刚做的选择矛盾。
  pub fn set_game_all(&mut self, game: Option<String>) {
    self.display.set_game(game.clone());
    for monitor in self.monitors.values_mut() {
      monitor.game = game.clone();
    }
  }

  /// 该屏**实际渲染**的游戏，与 `wallpaper::protocol::monitor_url` 同一套解析：
  /// - mirror / span：只认全局游戏，忽略每屏覆盖；
  /// - independent：每屏游戏优先；只有场景覆盖时表示“这块屏不要游戏”；
  /// - 都没有时回退到全局游戏。
  #[must_use]
  pub fn effective_game(&self, device: &str) -> Option<String> {
    if self.display.mode != DisplayMode::Independent {
      return self.display.game.clone();
    }
    if let Some(monitor) = self.monitors.get(device) {
      if monitor.game.is_some() {
        return monitor.game.clone();
      }
      if monitor.scene.is_some() {
        return None;
      }
    }
    self.display.game.clone()
  }

  /// 当前“壁纸激活”的游戏集合：全局游戏 + independent 下逐屏游戏，去重排序。
  #[must_use]
  pub fn active_games(&self) -> Vec<String> {
    let mut games: BTreeSet<String> = BTreeSet::new();
    if let Some(game) = &self.display.game {
      games.insert(game.clone());
    }
    if self.display.mode == DisplayMode::Independent {
      for monitor in self.monitors.values() {
        if let Some(game) = &monitor.game {
          games.insert(game.clone());
        }
      }
    }
    games.into_iter().collect()
  }

  /// 某个游戏是否仍被任何显示器实际使用（含全局与 independent 逐屏覆盖）。
  #[must_use]
  pub fn game_in_use(&self, game_id: &str) -> bool {
    if self.display.game.as_deref() == Some(game_id) {
      return true;
    }
    self.display.mode == DisplayMode::Independent
      && self
        .monitors
        .values()
        .any(|monitor| monitor.game.as_deref() == Some(game_id))
  }

  /// 该屏生效的场景：每屏覆盖 → 全局回退。
  ///
  /// 注意：这是**原始解析**，不区分显示模式。mirror / span 下每屏覆盖不参与
  /// 渲染，判断“这块屏实际在放什么”必须用 [`Self::effective_scene`]。
  pub fn resolved_scene(&self, device: &str) -> String {
    self
      .monitors
      .get(device)
      .and_then(|m| m.scene.clone())
      .unwrap_or_else(|| self.display.scene.clone())
  }

  /// 该屏**实际渲染**的场景，与 `wallpaper::protocol::monitor_url` 同一套解析：
  /// 只有 independent 模式消费每屏覆盖，mirror / span 一律用全局场景。
  ///
  /// 媒体生命周期靠它判断“这块屏还在不在视频场景”。用错解析会让一块正在放
  /// 视频的屏被判成非视频屏，从而在关闭别的屏时被连带回收、黑屏。
  pub fn effective_scene(&self, device: &str) -> String {
    if self.display.mode == DisplayMode::Independent {
      self.resolved_scene(device)
    } else {
      self.display.scene.clone()
    }
  }

  /// 场景是否仍在任何屏幕上实际生效。
  ///
  /// 不能用 `resolved_scene`：mirror/span 下每屏覆盖被忽略，残留的 monitor.scene
  /// 不应阻止卸载场景（否则切换了全局壁纸也卸载不掉）。
  /// independent 下逐屏游戏会让该屏的场景不参与画面，同样不算“在用”。
  pub fn scene_in_use(&self, scene: &str) -> bool {
    if self.display.mode != DisplayMode::Independent {
      // 全局游戏直接渲染时场景不参与任何画面。
      return self.display.game.is_none() && self.display.scene == scene;
    }
    // 全局场景仍是未覆盖显示器的回退；只有全局有游戏时它才完全退场。
    if self.display.game.is_none() && self.display.scene == scene {
      return true;
    }
    self.monitors.keys().any(|device| {
      self.effective_game(device).is_none() && self.effective_scene(device) == scene
    })
  }
}

fn temp_file_path(path: &Path) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(".tmp");
  PathBuf::from(name)
}

#[cfg(test)]
mod tests {
  use super::*;

  const D1: &str = "\\\\.\\DISPLAY1";
  const D2: &str = "\\\\.\\DISPLAY2";
  const D9: &str = "\\\\.\\DISPLAY9";

  fn temp_path(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("lull_display_config_tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(format!("{tag}.json"))
  }

  #[test]
  fn default_master_visible_and_new_monitor_enabled() {
    let c = WallpaperConfig::default();
    assert_eq!(c.version, CURRENT_VERSION);
    assert!(c.master_visible);
    assert!(c.monitor_enabled(D9), "没有记录的显示器应为默认启用");
    assert_eq!(c.display.scene, DEFAULT_SCENE_ID);
  }

  #[test]
  fn save_then_load_roundtrips() {
    let path = temp_path("roundtrip");
    let mut c = WallpaperConfig {
      master_visible: false,
      ..Default::default()
    };
    c.set_monitor_enabled(D1, false);
    c.set_monitor_enabled(D2, true);
    c.save(&path).unwrap();

    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded, c);
    assert!(!loaded.monitor_enabled(D1));
    assert!(loaded.monitor_enabled(D2));
    assert!(!loaded.master_visible);
  }

  #[test]
  fn save_is_atomic_and_leaves_no_temp_file() {
    let path = temp_path("atomic");
    WallpaperConfig::default().save(&path).unwrap();
    assert!(path.exists());
    assert!(!temp_file_path(&path).exists());
  }

  #[test]
  fn load_missing_file_returns_default_without_warning() {
    let path = temp_path("missing");
    let _ = std::fs::remove_file(&path);
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config, WallpaperConfig::default());
    assert!(outcome.warning.is_none());
  }

  #[test]
  fn load_corrupt_file_returns_default_with_warning() {
    let path = temp_path("corrupt");
    std::fs::write(&path, "not json {{{").unwrap();
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config, WallpaperConfig::default());
    assert!(outcome.warning.is_some());
  }

  #[test]
  fn non_object_root_falls_back_without_panicking() {
    let path = temp_path("non_object_root");
    std::fs::write(&path, "[]").unwrap();
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config, WallpaperConfig::default());
    assert!(outcome.warning.unwrap().contains("根节点"));
  }

  #[test]
  fn future_version_is_rejected_without_destroying_data() {
    let path = temp_path("future_version");
    let raw = r#"{"version":99,"master_visible":false,"display":{"scene":"custom.scene"}}"#;
    std::fs::write(&path, raw).unwrap();
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config, WallpaperConfig::default());
    assert!(outcome.warning.unwrap().contains("不兼容"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
  }

  #[test]
  fn old_version_is_rejected_without_migration() {
    let path = temp_path("old_version");
    std::fs::write(
      &path,
      r#"{"version":1,"display":{"scene":"legacy.scene"},"monitors":{"\\\\.\\DISPLAY2":{"enabled":false}}}"#,
    )
    .unwrap();
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config, WallpaperConfig::default());
    assert!(outcome.warning.unwrap().contains("不兼容"));
  }

  #[test]
  fn unknown_scene_id_in_current_config_is_preserved() {
    let path = temp_path("unknown_scene_current");
    std::fs::write(
      &path,
      r#"{"version":2,"display":{"scene":"community.custom"}}"#,
    )
    .unwrap();
    let outcome = WallpaperConfig::load_outcome(&path);
    assert_eq!(outcome.config.display.scene, "community.custom");
  }

  #[test]
  fn offline_monitor_keys_survive_later_edits() {
    let path = temp_path("offline_keys");
    let mut c = WallpaperConfig::default();
    c.set_monitor_enabled(D2, false);
    c.set_monitor_enabled(D1, false);
    c.set_monitor_enabled(D1, true);
    c.save(&path).unwrap();

    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert!(!loaded.monitor_enabled(D2), "离线显示器的记录应保留");
    assert!(loaded.monitor_enabled(D1));
  }

  #[test]
  fn display_defaults_when_section_missing() {
    let path = temp_path("display_defaults");
    std::fs::write(
      &path,
      r#"{"version":2,"master_visible":true,"monitors":{}}"#,
    )
    .unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded.display.mode, DisplayMode::Mirror);
    assert!(loaded.display.sync);
    assert_eq!(loaded.display.scene, DEFAULT_SCENE_ID);
  }

  #[test]
  fn display_roundtrips() {
    let path = temp_path("display_roundtrip");
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Span;
    c.display.sync = false;
    c.display.scene = "lull.aurora".into();
    c.save(&path).unwrap();
    assert_eq!(
      WallpaperConfig::load_outcome(&path).config.display,
      c.display
    );
  }

  #[test]
  fn media_config_roundtrips_and_omits_default() {
    let path = temp_path("display_media");
    let mut c = WallpaperConfig::default();
    c.display.media.asset_id = Some("m_abc".into());
    c.display.media.fit = "contain".into();
    c.display.media.loop_playback = false;
    c.save(&path).unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded.display.media.asset_id.as_deref(), Some("m_abc"));
    assert_eq!(loaded.display.media.fit, "contain");
    assert!(!loaded.display.media.loop_playback);

    let default_path = temp_path("display_media_default");
    WallpaperConfig::default().save(&default_path).unwrap();
    let raw = std::fs::read_to_string(&default_path).unwrap();
    assert!(!raw.contains("\"media\""), "默认媒体配置不应落盘: {raw}");
  }

  #[test]
  fn invalid_media_field_falls_back_without_dropping_display() {
    let path = temp_path("display_media_invalid");
    std::fs::write(
      &path,
      r#"{"version":2,"display":{"scene":"lull.video","media":{"fit":"bogus","preferredFps":12,"rate":9.0,"assetId":" m_1 "}}}"#,
    )
    .unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded.display.scene, "lull.video");
    assert_eq!(loaded.display.media.asset_id.as_deref(), Some("m_1"));
    assert_eq!(loaded.display.media.fit, "cover");
    assert_eq!(loaded.display.media.preferred_fps, 30);
    assert_eq!(loaded.display.media.rate, 4.0);
  }

  #[test]
  fn invalid_mode_falls_back_without_losing_other_fields() {
    let path = temp_path("display_invalid_mode");
    std::fs::write(
      &path,
      r#"{"version":2,"display":{"mode":"bogus","scene":"lull.aurora"},"monitors":{"\\\\.\\DISPLAY1":{"enabled":false}}}"#,
    )
    .unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded.display.mode, DisplayMode::Mirror);
    assert_eq!(loaded.display.scene, "lull.aurora");
    assert!(!loaded.monitor_enabled(D1));
  }

  #[test]
  fn apply_patch_updates_only_given_fields() {
    let mut d = DisplayConfig::default();
    d.apply_patch(None, Some(false), None);
    assert_eq!(d.mode, DisplayMode::Mirror);
    assert!(!d.sync);
    assert_eq!(d.scene, DEFAULT_SCENE_ID);
    d.apply_patch(
      Some(DisplayMode::Independent),
      None,
      Some("lull.aurora".into()),
    );
    assert_eq!(d.mode, DisplayMode::Independent);
    assert!(!d.sync);
    assert_eq!(d.scene, "lull.aurora");
  }

  #[test]
  fn effective_scene_ignores_overrides_outside_independent_mode() {
    // 回归：DISPLAY1 残留 lull.aurora 覆盖、全局场景是 lull.video、模式是 mirror。
    // 关闭 DISPLAY2 时 video_devices() 曾用 resolved_scene 把 DISPLAY1 判成非视频屏，
    // 连带回收仍在放视频的会话，表现为“关一屏、另一屏黑屏”。
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Mirror;
    c.display.scene = "lull.video".into();
    c.set_monitor_scene(D1, Some("lull.aurora".into()));
    assert_eq!(c.resolved_scene(D1), "lull.aurora");
    assert_eq!(c.effective_scene(D1), "lull.video");
    assert_eq!(c.effective_scene(D2), "lull.video");

    c.display.mode = DisplayMode::Span;
    assert_eq!(c.effective_scene(D1), "lull.video");

    c.display.mode = DisplayMode::Independent;
    assert_eq!(c.effective_scene(D1), "lull.aurora");
    assert_eq!(c.effective_scene(D2), "lull.video");
  }

  #[test]
  fn scene_in_use_ignores_stale_overrides_outside_independent_mode() {
    // 用户把全局壁纸切回 video，但 DISPLAY2 残留 overlay 覆盖；mirror 下该覆盖
    // 不参与渲染，不能阻止卸载场景。
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Mirror;
    c.display.scene = "lull.video".into();
    c.set_monitor_scene(D2, Some("community.stability-probe-overlay".into()));
    assert!(!c.scene_in_use("community.stability-probe-overlay"));

    c.display.mode = DisplayMode::Independent;
    assert!(c.scene_in_use("community.stability-probe-overlay"));

    c.display.mode = DisplayMode::Mirror;
    c.set_monitor_scene(D2, None);
    assert!(!c.scene_in_use("community.stability-probe-overlay"));

    c.display.scene = "community.stability-probe-overlay".into();
    assert!(c.scene_in_use("community.stability-probe-overlay"));
  }

  #[test]
  fn monitor_scene_survives_enabled_toggles_and_resolves_with_fallback() {
    let mut c = WallpaperConfig::default();
    c.set_monitor_scene(D2, Some("lull.aurora".into()));
    c.set_monitor_enabled(D2, false);
    assert_eq!(c.resolved_scene(D2), "lull.aurora");
    assert_eq!(c.resolved_scene(D1), DEFAULT_SCENE_ID);

    let path = temp_path("monitor_scene");
    c.save(&path).unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(loaded.resolved_scene(D2), "lull.aurora");
    assert_eq!(
      loaded.monitors.get(D2).and_then(|m| m.scene.clone()),
      Some("lull.aurora".into())
    );
  }

  #[test]
  fn scene_in_use_skips_monitor_that_renders_a_game() {
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Independent;
    c.display.scene = "lull.aurora".into();
    c.set_monitor_scene(D2, Some("lull.video".into()));
    assert!(c.scene_in_use("lull.video"));

    // 同一块屏再选游戏：游戏优先，残留的 scene 不再算“在用”。
    c.set_monitor_game(D2, Some("community.two".into()));
    assert!(!c.scene_in_use("lull.video"));
  }

  #[test]
  fn scene_params_roundtrip_and_empty_resets_defaults() {
    let path = temp_path("scene_params");
    let mut c = WallpaperConfig::default();
    assert!(c.display.params_for_scene("lull.bamboo").is_empty());
    c.display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("density".to_string(), "0.6".to_string())]),
    );
    c.save(&path).unwrap();

    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(
      loaded.display.params_for_scene("lull.bamboo"),
      BTreeMap::from([("density".to_string(), "0.6".to_string())])
    );

    let mut loaded = loaded;
    loaded
      .display
      .set_scene_params("lull.bamboo", BTreeMap::new());
    assert!(loaded.display.params_for_scene("lull.bamboo").is_empty());
  }

  #[test]
  fn game_content_roundtrips_and_scene_selection_clears_it() {
    let path = temp_path("game_content");
    let mut c = WallpaperConfig::default();
    c.display.set_game(Some("community.stability-probe".into()));
    assert_eq!(c.display.game_content(), Some("community.stability-probe"));
    assert!(!c.scene_in_use(DEFAULT_SCENE_ID));

    c.save(&path).unwrap();
    let mut loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(
      loaded.display.game_content(),
      Some("community.stability-probe")
    );

    // 显式选择场景 = 退出游戏壁纸；清空后场景恢复“在用”。
    loaded
      .display
      .apply_patch(None, None, Some("lull.aurora".into()));
    assert_eq!(loaded.display.game_content(), None);
    assert_eq!(loaded.display.scene, "lull.aurora");
    assert!(loaded.scene_in_use("lull.aurora"));
  }

  #[test]
  fn game_field_is_omitted_when_unset() {
    let json = serde_json::to_string(&DisplayConfig::default()).unwrap();
    assert!(!json.contains("\"game\""));
  }

  #[test]
  fn monitor_game_follows_mode_and_scene_override() {
    let mut c = WallpaperConfig::default();
    c.display.set_game(Some("community.global".into()));
    c.set_monitor_game(D1, Some("community.local".into()));

    // mirror / span 忽略逐屏游戏，只看全局。
    assert_eq!(
      c.effective_game(D1).as_deref(),
      Some("community.global")
    );
    c.display.mode = DisplayMode::Independent;
    assert_eq!(c.effective_game(D1).as_deref(), Some("community.local"));
    assert_eq!(
      c.effective_game(D2).as_deref(),
      Some("community.global")
    );

    // 显式选场景会清掉该屏游戏，并在 independent 下压过全局游戏。
    c.set_monitor_scene(D2, Some("lull.video".into()));
    assert!(c.monitors.get(D2).is_some_and(|monitor| monitor.game.is_none()));
    assert_eq!(c.effective_game(D2), None);
    assert_eq!(c.effective_scene(D2), "lull.video");
    assert!(c.game_in_use("community.global"));
    assert!(c.game_in_use("community.local"));
  }

  #[test]
  fn monitor_game_is_ignored_outside_independent_mode() {
    let mut c = WallpaperConfig::default();
    c.display.set_game(Some("community.global".into()));
    c.set_monitor_game(D1, Some("community.local".into()));
    assert!(c.game_in_use("community.global"));
    assert!(!c.game_in_use("community.local"));
    assert_eq!(c.active_games(), vec!["community.global".to_string()]);

    c.display.mode = DisplayMode::Independent;
    assert_eq!(
      c.active_games(),
      vec![
        "community.global".to_string(),
        "community.local".to_string()
      ]
    );
  }

  #[test]
  fn global_game_sets_every_monitor_in_independent_mode() {
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Independent;
    c.set_monitor_game(D1, Some("community.one".into()));
    c.set_monitor_game(D2, Some("community.two".into()));
    c.set_game_all(Some("community.three".into()));
    assert_eq!(
      c.effective_game(D1).as_deref(),
      Some("community.three")
    );
    assert_eq!(
      c.effective_game(D2).as_deref(),
      Some("community.three")
    );

    c.set_game_all(None);
    assert_eq!(c.effective_game(D1), None);
    assert_eq!(c.effective_game(D2), None);
    assert!(c.active_games().is_empty());
  }

  #[test]
  fn global_game_clears_stale_monitor_games_outside_independent_mode() {
    let mut c = WallpaperConfig::default();
    c.set_monitor_game(D1, Some("community.old".into()));
    c.set_game_all(Some("community.new".into()));
    assert_eq!(
      c.monitors.get(D1).and_then(|monitor| monitor.game.as_deref()),
      Some("community.new")
    );

    c.display.mode = DisplayMode::Independent;
    assert_eq!(
      c.effective_game(D1).as_deref(),
      Some("community.new")
    );
  }

  #[test]
  fn monitor_game_roundtrips_and_omits_none() {
    let path = temp_path("monitor_game");
    let mut c = WallpaperConfig::default();
    c.display.mode = DisplayMode::Independent;
    c.set_monitor_game(D2, Some("community.local".into()));
    c.save(&path).unwrap();
    let loaded = WallpaperConfig::load_outcome(&path).config;
    assert_eq!(
      loaded.monitors.get(D2).and_then(|monitor| monitor.game.clone()),
      Some("community.local".into())
    );

    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"game\": \"community.local\""), "{raw}");
    let default_path = temp_path("monitor_game_default");
    WallpaperConfig::default().save(&default_path).unwrap();
    let raw = std::fs::read_to_string(&default_path).unwrap();
    assert!(!raw.contains("\"game\""), "无游戏时不应落盘 game 字段: {raw}");
  }

  #[test]
  fn scene_params_serialize_as_camel_case() {
    let mut display = DisplayConfig::default();
    display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("density".to_string(), "0.6".to_string())]),
    );
    let json = serde_json::to_string(&display).unwrap();
    assert!(json.contains("\"sceneParams\""));
    assert!(!json.contains("\"scene_params\""));
  }
}
