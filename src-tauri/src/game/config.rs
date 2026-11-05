//! `games.json`：游戏运行偏好（与 display.json 分离）。
//!
//! 读取是容错的：文件缺失、字段缺省或数值越界都回落到默认值；写入先 clamp
//! 再原子替换，避免设置页写坏文件后整个游戏模块不可用。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::error::{codes, GameError, GameResult};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const MAX_RUNNING_MIN: u32 = 1;
pub const MAX_RUNNING_MAX: u32 = 3;
pub const OFFLINE_MAX_MIN_MS: u64 = 3_600_000;
pub const OFFLINE_MAX_MAX_MS: u64 = 30 * 24 * 3_600 * 1_000;

const DEFAULT_MAX_RUNNING: u32 = MAX_RUNNING_MAX;
const DEFAULT_OFFLINE_MAX_MS: u64 = 7 * 24 * 3_600 * 1_000;

/// 宿主级游戏偏好；`games.json` 的公开形状与设置页一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GamesConfig {
  pub schema_version: u32,
  /// 场景绑定游戏且实例未运行时，是否允许壁纸窗自动启动（默认开）。
  pub auto_start_with_wallpaper: bool,
  /// 应用启动时是否恢复上次仍在运行的实例（默认关；崩溃后恢复）。
  pub resume_on_launch: bool,
  /// 同时运行实例上限，clamp 1..=3。
  pub max_running: u32,
  /// 恢复/暂停补算离线时间的上限，clamp 1h..=30d。
  pub offline_max_ms: u64,
  /// 启动游戏时自动打开清单声明的控制器，停止时只关自动打开的那个（默认开）。
  pub controller_follows_game: bool,
}

impl Default for GamesConfig {
  fn default() -> Self {
    Self {
      schema_version: CONFIG_SCHEMA_VERSION,
      auto_start_with_wallpaper: true,
      resume_on_launch: false,
      max_running: DEFAULT_MAX_RUNNING,
      offline_max_ms: DEFAULT_OFFLINE_MAX_MS,
      controller_follows_game: true,
    }
  }
}

impl GamesConfig {
  #[must_use]
  pub fn sanitized(mut self) -> Self {
    self.schema_version = CONFIG_SCHEMA_VERSION;
    self.max_running = self.max_running.clamp(MAX_RUNNING_MIN, MAX_RUNNING_MAX);
    self.offline_max_ms = self
      .offline_max_ms
      .clamp(OFFLINE_MAX_MIN_MS, OFFLINE_MAX_MAX_MS);
    self
  }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = std::env::var_os("LULL_GAMES_CONFIG") {
    return Ok(PathBuf::from(path));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("games.json"))
    .map_err(|error| error.to_string())
}

/// 容错读取：失败/缺省时返回默认值，不阻塞游戏启动。
#[must_use]
pub fn load(app: &AppHandle) -> GamesConfig {
  let Ok(path) = config_path(app) else {
    return GamesConfig::default();
  };
  load_at(&path).unwrap_or_default().sanitized()
}

fn load_at(path: &Path) -> Option<GamesConfig> {
  let bytes = std::fs::read(path).ok()?;
  serde_json::from_slice::<GamesConfig>(&bytes).ok()
}

/// 校验 + clamp 后原子写盘；返回实际生效的值。
pub fn save(app: &AppHandle, config: GamesConfig) -> GameResult<GamesConfig> {
  let config = config.sanitized();
  let path = config_path(app)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("定位 games.json 失败：{error}")))?;
  let json = serde_json::to_vec_pretty(&config)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("序列化 games.json 失败：{error}")))?;
  write_atomic(&path, &json)?;
  Ok(config)
}

#[must_use]
pub fn max_running(app: &AppHandle) -> u32 {
  load(app).max_running
}

#[must_use]
pub fn offline_max_ms(app: &AppHandle) -> u64 {
  load(app).offline_max_ms
}

#[must_use]
pub fn auto_start_with_wallpaper(app: &AppHandle) -> bool {
  load(app).auto_start_with_wallpaper
}

#[must_use]
pub fn resume_on_launch(app: &AppHandle) -> bool {
  load(app).resume_on_launch
}

#[must_use]
pub fn controller_follows_game(app: &AppHandle) -> bool {
  load(app).controller_follows_game
}

fn write_atomic(path: &Path, bytes: &[u8]) -> GameResult<()> {
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, bytes)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("写临时配置失败：{error}")))?;
  if path.exists() {
    std::fs::remove_file(path)
      .map_err(|error| GameError::new(codes::IO_ERROR, format!("替换旧配置失败：{error}")))?;
  }
  std::fs::rename(&temp, path)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("原子替换配置失败：{error}")))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn defaults_are_safe_and_within_limits() {
    let config = GamesConfig::default().sanitized();
    assert_eq!(config.schema_version, CONFIG_SCHEMA_VERSION);
    assert!(config.auto_start_with_wallpaper);
    assert!(!config.resume_on_launch);
    assert_eq!(config.max_running, MAX_RUNNING_MAX);
    assert_eq!(config.offline_max_ms, DEFAULT_OFFLINE_MAX_MS);
    assert!(config.controller_follows_game);
  }

  #[test]
  fn sanitize_clamps_out_of_range_values() {
    let config = GamesConfig {
      schema_version: 99,
      auto_start_with_wallpaper: false,
      resume_on_launch: true,
      max_running: 0,
      offline_max_ms: 1,
      controller_follows_game: false,
    }
    .sanitized();
    assert_eq!(config.schema_version, CONFIG_SCHEMA_VERSION);
    assert!(config.resume_on_launch);
    assert_eq!(config.max_running, MAX_RUNNING_MIN);
    assert_eq!(config.offline_max_ms, OFFLINE_MAX_MIN_MS);

    let high = GamesConfig {
      max_running: 99,
      offline_max_ms: u64::MAX,
      ..GamesConfig::default()
    }
    .sanitized();
    assert_eq!(high.max_running, MAX_RUNNING_MAX);
    assert_eq!(high.offline_max_ms, OFFLINE_MAX_MAX_MS);
  }

  #[test]
  fn missing_file_falls_back_to_defaults() {
    let dir = std::env::temp_dir().join(format!("lull-games-config-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    assert!(load_at(&dir.join("games.json")).is_none());
    let _ = std::fs::remove_dir_all(dir);
  }
}
