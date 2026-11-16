//! Noise 业务域门面。
//!
//! N2 提供 Session/Track 运行时、内置 procedural Asset 与旧 5 层 `noise.*`
//! 兼容门面；本地素材、分类/收藏与 Preset CRUD 在 N3/N4 扩展。

pub mod assets;
pub mod catalog;
pub mod dto;
pub mod library;
pub mod presets;
mod repository;
mod session;

#[tauri::command]
pub fn wallpaper_environment_snapshot(window: tauri::WebviewWindow) -> Result<dto::EnvironmentTargetSnapshot, String> {
  if !window.label().starts_with("wallpaper-") { return Err("只有壁纸窗口可以读取环境状态".into()); }
  session::environment_target_snapshot().map_err(|error| format!("{error:?}"))
}

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tauri::AppHandle;

use crate::media::api::errors::MediaError;
use dto::{NoiseSessionView, NoiseStateView};

static LIBRARY_REVISION: AtomicU64 = AtomicU64::new(0);

fn next_library_revision() -> u64 {
  LIBRARY_REVISION.fetch_add(1, Ordering::Relaxed) + 1
}

/// 启动：seed 内置 catalog，再构建一份 idle Session。失败时保留空 Session，
/// 避免 Noise 初始化问题拖垮 Music 的 `media_connect`。
pub async fn init(pool: &sqlx::SqlitePool) -> Result<(), MediaError> {
  let result = async {
    catalog::seed(pool).await?;
    session::init(pool).await
  }
  .await;
  if result.is_err() {
    session::init_fallback();
  }
  result
}

pub fn shutdown() {
  session::shutdown();
}

pub fn on_engine_ready(app: &AppHandle) {
  session::on_engine_ready(app);
}

pub fn on_engine_lost(app: &AppHandle) {
  session::on_engine_lost(app);
}

#[must_use]
pub fn revision() -> u64 {
  session::revision()
}

pub fn snapshots() -> Result<(NoiseSessionView, NoiseStateView), MediaError> {
  session::snapshots()
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, MediaError> {
  args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn bool_arg(args: &Value, key: &str) -> Result<bool, MediaError> {
  args
    .get(key)
    .and_then(Value::as_bool)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn f64_arg(args: &Value, key: &str) -> Result<f64, MediaError> {
  args
    .get(key)
    .and_then(Value::as_f64)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn u64_arg(args: &Value, key: &str) -> Result<usize, MediaError> {
  args
    .get(key)
    .and_then(Value::as_u64)
    .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn legacy_value() -> Result<Value, MediaError> {
  serde_json::to_value(session::legacy_snapshot()?)
    .map_err(|error| MediaError::internal(format!("序列化 Noise 状态失败：{error}")))
}

/// `noise` 命名空间分发。
pub async fn call(
  app: AppHandle,
  label: &str,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  if matches!(
    method,
    "listAssets"
      | "getAsset"
      | "getCategories"
      | "getTags"
      | "createCategory"
      | "updateCategory"
      | "deleteCategory"
      | "createTag"
      | "updateTag"
      | "deleteTag"
      | "setAssetFavorite"
      | "importAssets"
      | "importFolder"
      | "updateAsset"
      | "removeAsset"
      | "revalidateAssets"
  ) {
    return library::call(&app, label, method, args).await;
  }
  if matches!(
    method,
    "listPresets"
      | "getPreset"
      | "savePreset"
      | "updatePreset"
      | "duplicatePreset"
      | "deletePreset"
      | "loadPreset"
      | "exportPreset"
      | "importPreset"
      | "mapPresetTrack"
      | "setPresetFavorite"
  ) {
    return presets::call(&app, label, method, args).await;
  }
  match method {
    "getState" => legacy_value(),
    "getSounds" => serde_json::to_value(session::sounds().await?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise 声景失败：{error}"))),
    "activate" => {
      session::activate(&app).await?;
      legacy_value()
    }
    "setLayer" => {
      let sound_id = string_arg(args, "soundId")?;
      let enabled = args.get("enabled").and_then(Value::as_bool);
      let volume = args.get("volume").and_then(Value::as_f64);
      session::set_legacy_layer(&app, sound_id, enabled, volume).await?;
      legacy_value()
    }
    "setMaster" => {
      let volume = f64_arg(args, "volume")?;
      session::set_master_volume(&app, volume).await?;
      legacy_value()
    }
    "setMuted" => {
      let muted = bool_arg(args, "muted")?;
      session::set_muted(&app, muted).await?;
      legacy_value()
    }
    "setSleepTimer" => {
      let minutes = args
        .get("minutes")
        .and_then(Value::as_i64)
        .ok_or_else(|| MediaError::invalid("缺少 minutes"))?;
      session::set_sleep_timer(&app, minutes)?;
      legacy_value()
    }
    "reset" => {
      session::reset_default(&app).await?;
      legacy_value()
    }
    "getSession" => serde_json::to_value(session::snapshot()?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}"))),
    "getEnvironmentTargets" => serde_json::to_value(session::environment_target_snapshot()?)
      .map_err(|error| MediaError::internal(format!("序列化环境目标失败：{error}"))),
    "createSession" => serde_json::to_value(session::create_session(&app)?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}"))),
    "playSession" => serde_json::to_value(session::play_session(&app)?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}"))),
    "pauseSession" => serde_json::to_value(session::pause_session(&app)?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}"))),
    "stopSession" => serde_json::to_value(session::stop_session(&app)?)
      .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}"))),
    "setSessionVolume" => {
      let volume = f64_arg(args, "volume")?;
      serde_json::to_value(session::set_master_volume(&app, volume).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setSessionMuted" => {
      let muted = bool_arg(args, "muted")?;
      serde_json::to_value(session::set_muted(&app, muted).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setSessionSleepTimer" => {
      let minutes = args
        .get("minutes")
        .and_then(Value::as_i64)
        .ok_or_else(|| MediaError::invalid("缺少 minutes"))?;
      serde_json::to_value(session::set_sleep_timer(&app, minutes)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "addTrack" => {
      let asset_id = string_arg(args, "assetId")?;
      serde_json::to_value(session::add_track(&app, asset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 音轨失败：{error}")))
    }
    "configureTrackEnvironment" => {
      let track_id = string_arg(args, "trackId")?;
      let config = serde_json::from_value(args.get("environment").cloned()
        .ok_or_else(|| MediaError::invalid("缺少 environment"))?)
        .map_err(|error| MediaError::invalid(format!("环境配置无效：{error}")))?;
      serde_json::to_value(session::configure_environment(&app, track_id, config).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setTrackIntensity" => {
      let track_id = string_arg(args, "trackId")?;
      let intensity = f64_arg(args, "intensity")?;
      serde_json::to_value(session::set_environment_intensity(&app, track_id, intensity)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "removeTrack" => {
      let track_id = string_arg(args, "trackId")?;
      serde_json::to_value(session::remove_track(&app, track_id)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setTrackVolume" => {
      let track_id = string_arg(args, "trackId")?;
      let volume = f64_arg(args, "volume")?;
      serde_json::to_value(session::set_track_volume(&app, track_id, volume)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setTrackEnabled" => {
      let track_id = string_arg(args, "trackId")?;
      let enabled = bool_arg(args, "enabled")?;
      serde_json::to_value(session::set_track_enabled(&app, track_id, enabled)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "setTrackLoop" => {
      let track_id = string_arg(args, "trackId")?;
      let loop_ = bool_arg(args, "loop")?;
      serde_json::to_value(session::set_track_loop(&app, track_id, loop_)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    "reorderTracks" => {
      let track_id = string_arg(args, "trackId")?;
      let position = u64_arg(args, "position")?;
      serde_json::to_value(session::reorder_tracks(&app, track_id, position)?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Session 失败：{error}")))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的 Noise 方法：{method}"),
    )),
  }
}
