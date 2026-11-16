//! Noise Session/Track 运行时。
//!
//! 进程内单例；Session 与 Track 不落盘。Asset/Preset 持久化在 DB，启动时从
//! 默认 Preset 构建一份 idle Session，不自动播放。旧 5 层 `noise.*` 通过本模块
//! 的兼容视图映射到同一份 Session。

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

use super::dto::{
  NoiseLayerView, NoiseSessionView, NoiseSleepView, NoiseStateView, NoiseTrackError, NoiseTrackView,
  EnvironmentTargetSnapshot, TrackEnvironment,
};
use super::repository;
use crate::media::api::errors::MediaError;
use crate::media::engine;
use crate::media::events;
use crate::media::repository::{new_id, now_ms};

const DEFAULT_PRESET_ID: &str = "noise:preset:default";
const MAX_TRACKS: usize = 32;

#[derive(Debug, Clone)]
enum TrackSource {
  Procedural { profile: String, version: u32 },
  File { storage_key: String },
  Missing,
}

#[derive(Debug, Clone)]
struct Track {
  id: String,
  asset_id: String,
  name: String,
  source: TrackSource,
  volume: f64,
  enabled: bool,
  loop_: bool,
  fade_in_ms: Option<i64>,
  fade_out_ms: Option<i64>,
  error: Option<NoiseTrackError>,
  environment: Option<EnvironmentTrack>,
}

#[derive(Debug, Clone)]
struct EnvironmentTrack {
  config: TrackEnvironment,
  sources: Vec<TrackSource>,
}

struct Session {
  id: String,
  name: Option<String>,
  state: String,
  master_volume: f64,
  muted: bool,
  tracks: Vec<Track>,
  sleep_minutes: i64,
  sleep_ends_at: Option<i64>,
  created_at: i64,
  revision: u64,
  sleep_generation: u64,
  last_preset_id: Option<String>,
}

static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();

fn lock() -> Result<MutexGuard<'static, Session>, MediaError> {
  SESSION
    .get()
    .map(|session| session.lock().unwrap_or_else(PoisonError::into_inner))
    .ok_or_else(|| MediaError::unavailable("Noise 服务尚未初始化"))
}

fn touch(session: &mut Session) -> u64 {
  session.revision = session.revision.saturating_add(1);
  session.revision
}

fn clamp_volume(value: f64) -> f64 {
  if value.is_finite() {
    value.clamp(0.0, 1.0)
  } else {
    0.0
  }
}

#[derive(Debug, Deserialize)]
struct Generator {
  profile: String,
  #[serde(default = "default_generator_version")]
  version: u32,
}

fn default_generator_version() -> u32 {
  1
}

fn source_from_asset(asset: &repository::AssetRow) -> (TrackSource, Option<NoiseTrackError>) {
  if asset.media_kind == "file" {
    if asset.status != "available" {
      return (
        TrackSource::Missing,
        Some(NoiseTrackError {
          code: "noise.asset.missing".to_string(),
          message: "音频文件不可用".to_string(),
        }),
      );
    }
    return match asset.storage_key.as_deref() {
      Some(storage_key) if !storage_key.is_empty() => (
        TrackSource::File {
          storage_key: storage_key.to_string(),
        },
        None,
      ),
      _ => (
        TrackSource::Missing,
        Some(NoiseTrackError {
          code: "noise.asset.invalid".to_string(),
          message: "文件素材缺少 storage_key".to_string(),
        }),
      ),
    };
  }
  if asset.media_kind != "procedural" {
    return (
      TrackSource::Missing,
      Some(NoiseTrackError {
        code: "noise.asset.unsupported".to_string(),
        message: "不支持的 Noise 素材类型".to_string(),
      }),
    );
  }
  let Some(generator) = asset.generator_json.as_deref() else {
    return (
      TrackSource::Missing,
      Some(NoiseTrackError {
        code: "noise.asset.invalid".to_string(),
        message: "程序化素材缺少 generator".to_string(),
      }),
    );
  };
  match serde_json::from_str::<Generator>(generator) {
    Ok(generator) => (
      TrackSource::Procedural {
        profile: generator.profile,
        version: generator.version,
      },
      None,
    ),
    Err(_) => (
      TrackSource::Missing,
      Some(NoiseTrackError {
        code: "noise.asset.invalid".to_string(),
        message: "程序化素材 generator 损坏".to_string(),
      }),
    ),
  }
}

async fn load_preset_tracks(pool: &SqlitePool, preset_id: &str) -> Result<Vec<Track>, MediaError> {
  let rows = repository::preset_tracks(pool, preset_id).await?;
  let mut tracks = Vec::new();
  for row in rows {
    let asset_id = row.asset_id.clone().unwrap_or_default();
    let (source, error) =
      if row.asset_id.is_none() || row.asset_status.as_deref() != Some("available") {
        (
          TrackSource::Missing,
          Some(NoiseTrackError {
            code: "noise.asset.missing".to_string(),
            message: "素材不存在或不可用".to_string(),
          }),
        )
      } else {
        let asset = repository::AssetRow {
          id: asset_id.clone(),
          name: row
            .asset_name
            .clone()
            .unwrap_or_else(|| row.expected_name.clone()),
          media_kind: row
            .media_kind
            .clone()
            .unwrap_or_else(|| "procedural".to_string()),
          generator_json: row.generator_json.clone(),
          storage_key: row.storage_key.clone(),
          status: row
            .asset_status
            .clone()
            .unwrap_or_else(|| "available".to_string()),
        };
        source_from_asset(&asset)
      };
    tracks.push(Track {
      id: new_id("noise_track"),
      asset_id,
      name: row
        .asset_name
        .clone()
        .unwrap_or_else(|| row.expected_name.clone()),
      source,
      volume: clamp_volume(row.volume),
      enabled: row.enabled != 0,
      loop_: row.loop_ != 0,
      fade_in_ms: row.fade_in_ms,
      fade_out_ms: row.fade_out_ms,
      error,
      environment: None,
    });
  }
  if tracks.is_empty() {
    for asset in repository::assets(pool).await? {
      let (source, error) = source_from_asset(&asset);
      tracks.push(Track {
        id: new_id("noise_track"),
        asset_id: asset.id,
        name: asset.name,
        source,
        volume: 0.7,
        enabled: true,
        loop_: true,
        fade_in_ms: Some(80),
        fade_out_ms: Some(120),
        error,
        environment: None,
      });
    }
  }
  Ok(tracks)
}

/// 启动：读取偏好，用默认 Preset 构建一份 idle Session；不自动播放。
pub async fn init(pool: &SqlitePool) -> Result<(), MediaError> {
  if SESSION.get().is_some() {
    return Ok(());
  }
  let preferences = repository::preferences(pool).await?;
  let tracks = load_preset_tracks(pool, DEFAULT_PRESET_ID).await?;
  let session = Session {
    id: new_id("noise_session"),
    name: Some("Noise Mix".to_string()),
    state: "idle".to_string(),
    master_volume: clamp_volume(preferences.master_volume),
    muted: preferences.muted != 0,
    tracks,
    sleep_minutes: 0,
    sleep_ends_at: None,
    created_at: now_ms(),
    revision: 0,
    sleep_generation: 0,
    last_preset_id: preferences.last_preset_id.clone(),
  };
  let _ = SESSION.set(Mutex::new(session));
  Ok(())
}

/// 启动失败时的兜底：保证 `media_connect` 仍能返回一份空 Session，而不是让
/// 整个 Media Service 不可用。
pub fn init_fallback() {
  if SESSION.get().is_some() {
    return;
  }
  let session = Session {
    id: new_id("noise_session"),
    name: Some("Noise Mix".to_string()),
    state: "idle".to_string(),
    master_volume: 0.75,
    muted: false,
    tracks: Vec::new(),
    sleep_minutes: 0,
    sleep_ends_at: None,
    created_at: now_ms(),
    revision: 0,
    sleep_generation: 0,
    last_preset_id: None,
  };
  let _ = SESSION.set(Mutex::new(session));
}

#[must_use]
pub fn revision() -> u64 {
  lock().map(|session| session.revision).unwrap_or(0)
}

pub fn snapshot() -> Result<NoiseSessionView, MediaError> {
  let session = lock()?;
  Ok(session_view(&session))
}

fn environment_targets(session: &Session) -> std::collections::BTreeMap<String, f64> {
  let mut targets = std::collections::BTreeMap::<String, f64>::new();
  if session.state != "playing" { return targets; }
  for track in &session.tracks {
    if !track.enabled { continue; }
    if let Some(environment) = &track.environment {
      if environment.sources.iter().all(|source| matches!(source, TrackSource::Missing)) { continue; }
      let value = environment.config.intensity;
      targets.entry(environment.config.environment_type.clone())
        .and_modify(|current| *current = current.max(value)).or_insert(value);
    }
  }
  targets
}

pub fn environment_target_snapshot() -> Result<EnvironmentTargetSnapshot, MediaError> {
  let session = lock()?;
  Ok(EnvironmentTargetSnapshot { targets: environment_targets(&session), timestamp: now_ms(), revision: session.revision })
}

pub fn snapshots() -> Result<(NoiseSessionView, NoiseStateView), MediaError> {
  let session = lock()?;
  Ok((session_view(&session), legacy_view(&session)))
}

pub fn legacy_snapshot() -> Result<NoiseStateView, MediaError> {
  let session = lock()?;
  Ok(legacy_view(&session))
}

/// 旧 UI 的 `getSounds`：从 DB 的 builtin procedural Asset 生成稳定 profile 列表。
pub async fn sounds() -> Result<Vec<super::dto::NoiseSoundView>, MediaError> {
  let pool = crate::media::library::pool()?;
  let mut sounds = Vec::new();
  for asset in repository::assets(pool).await? {
    let (source, _) = source_from_asset(&asset);
    if let TrackSource::Procedural { profile, .. } = source {
      sounds.push(super::dto::NoiseSoundView {
        id: profile,
        name: asset.name,
      });
    }
  }
  Ok(sounds)
}

fn track_state(session_state: &str, track: &Track) -> String {
  if track.error.is_some() {
    return "stopped".to_string();
  }
  match session_state {
    "playing" => "playing".to_string(),
    "paused" => "paused".to_string(),
    _ => "stopped".to_string(),
  }
}

fn track_view(session: &Session, track: &Track, order: usize) -> NoiseTrackView {
  NoiseTrackView {
    id: track.id.clone(),
    asset_id: track.asset_id.clone(),
    name: track.name.clone(),
    state: track_state(&session.state, track),
    volume: track.volume,
    enabled: track.enabled,
    loop_: track.loop_,
    position_ms: 0,
    fade_in_ms: track.fade_in_ms,
    fade_out_ms: track.fade_out_ms,
    order,
    error: track.error.clone().or_else(|| {
      track.environment.as_ref().and_then(|environment| {
        environment.sources.iter().any(|source| matches!(source, TrackSource::Missing)).then(|| NoiseTrackError {
          code: "noise.asset.missing".to_string(),
          message: "部分环境素材不可用".to_string(),
        })
      })
    }),
    environment: track.environment.as_ref().map(|env| env.config.clone()),
  }
}

fn session_view(session: &Session) -> NoiseSessionView {
  NoiseSessionView {
    id: session.id.clone(),
    name: session.name.clone(),
    state: session.state.clone(),
    master_volume: session.master_volume,
    muted: session.muted,
    tracks: session
      .tracks
      .iter()
      .enumerate()
      .map(|(index, track)| track_view(session, track, index))
      .collect(),
    sleep: NoiseSleepView {
      timer_minutes: session.sleep_minutes,
      ends_at: session.sleep_ends_at,
    },
    revision: session.revision,
    created_at: session.created_at,
  }
}

fn legacy_sound_id(track: &Track) -> String {
  match &track.source {
    TrackSource::Procedural { profile, .. } => profile.clone(),
    TrackSource::File { .. } | TrackSource::Missing => track.asset_id.clone(),
  }
}

fn legacy_layers(session: &Session) -> Vec<NoiseLayerView> {
  session
    .tracks
    .iter()
    .map(|track| NoiseLayerView {
      sound_id: legacy_sound_id(track),
      enabled: track.enabled,
      volume: track.volume,
    })
    .collect()
}

fn legacy_view(session: &Session) -> NoiseStateView {
  NoiseStateView {
    session_id: session.id.clone(),
    active: session.state == "playing",
    master: session.master_volume,
    muted: session.muted,
    layers: legacy_layers(session),
    sleep: NoiseSleepView {
      timer_minutes: session.sleep_minutes,
      ends_at: session.sleep_ends_at,
    },
    revision: session.revision,
  }
}

fn engine_source(app: &AppHandle, asset_id: &str, source: &TrackSource) -> Option<Value> {
  match source {
    TrackSource::Procedural { profile, version } => Some(json!({
      "kind": "procedural", "profile": profile, "version": version,
    })),
    TrackSource::File { storage_key } => {
      let path = super::assets::path_for(app, storage_key);
      if !path.is_file() { return None; }
      app.asset_protocol_scope().allow_file(&path).ok()?;
      let window = app.get_webview_window(engine::ENGINE_LABEL)?;
      let url = window.convert_file_src(&path, None).ok()?;
      Some(json!({ "kind": "asset", "assetKey": asset_id, "url": url }))
    }
    TrackSource::Missing => None,
  }
}

fn engine_tracks(app: &AppHandle, session: &Session) -> Vec<Value> {
  session
    .tracks
    .iter()
    .filter(|track| track.error.is_none())
    .filter_map(|track| {
      let source = engine_source(app, &track.asset_id, &track.source).or_else(|| {
        track.environment.as_ref()?.config.anchors.iter().zip(&track.environment.as_ref()?.sources)
          .find_map(|(anchor, source)| engine_source(app, &anchor.asset_id, source))
      })?;
      let environment = track.environment.as_ref().map(|environment| {
        let anchors: Vec<Value> = environment.config.anchors.iter().zip(&environment.sources)
          .filter_map(|(anchor, source)| Some(json!({
            "assetId": anchor.asset_id,
            "intensity": anchor.intensity,
            "source": engine_source(app, &anchor.asset_id, source)?,
          }))).collect();
        json!({ "type": environment.config.environment_type, "intensity": environment.config.intensity, "anchors": anchors })
      });
      if environment.as_ref().is_some_and(|value| value["anchors"].as_array().is_none_or(Vec::is_empty)) {
        return None;
      }
      Some(json!({
        "trackId": track.id,
        "assetId": track.asset_id,
        "source": source,
        "volume": track.volume,
        "enabled": track.enabled,
        "loop": track.loop_,
        "fadeInMs": track.fade_in_ms,
        "fadeOutMs": track.fade_out_ms,
        "state": track_state(&session.state, track),
        "environment": environment,
      }))
    })
    .collect()
}

/// 把当前 Session 全量下发给引擎；引擎窗口不存在时静默忽略，ready 后会重发。
pub fn sync_engine(app: &AppHandle) {
  let (state, master, muted, tracks) = match lock() {
    Ok(session) => (
      session.state.clone(),
      session.master_volume,
      session.muted,
      engine_tracks(app, &session),
    ),
    Err(_) => return,
  };
  engine::send(
    app,
    engine::noise_session_sync(&state, master, muted, &tracks),
  );
}

pub fn on_engine_ready(app: &AppHandle) {
  sync_engine(app);
}

pub fn on_engine_lost(app: &AppHandle) {
  let changed = if let Ok(mut session) = lock() {
    if session.state == "playing" {
      session.state = "paused".to_string();
      touch(&mut session);
      true
    } else {
      false
    }
  } else {
    false
  };
  if changed {
    emit_all(app);
    crate::wallpaper::wlog("media engine 窗口丢失，Noise Session 已暂停");
  }
}

fn emit_all(app: &AppHandle) {
  let (session_view, legacy, revision, environment) = match lock() {
    Ok(session) => (
      session_view(&session),
      legacy_view(&session),
      session.revision,
      EnvironmentTargetSnapshot { targets: environment_targets(&session), timestamp: now_ms(), revision: session.revision },
    ),
    Err(_) => return,
  };
  for (label, window) in app.webview_windows() {
    if label.starts_with("wallpaper-") {
      let _ = window.emit("wallpaper-environment", &environment);
    }
  }
  events::emit(
    app,
    "noise.state",
    revision,
    serde_json::to_value(legacy).unwrap_or(Value::Null),
  );
  events::emit(
    app,
    "noise.session.changed",
    revision,
    serde_json::to_value(&session_view).unwrap_or(Value::Null),
  );
  events::emit(
    app,
    "noise.session.state-changed",
    revision,
    json!({ "state": session_view.state }),
  );
}

fn save_preferences_async(
  pool: SqlitePool,
  master: f64,
  muted: bool,
  last_preset_id: Option<String>,
) {
  tauri::async_runtime::spawn(async move {
    let _ = repository::save_preferences(&pool, master, muted, last_preset_id.as_deref()).await;
  });
}

fn pool_and_save() {
  let Ok(pool) = crate::media::library::pool() else {
    return;
  };
  let (master, muted, last_preset) = match lock() {
    Ok(session) => (
      session.master_volume,
      session.muted,
      session.last_preset_id.clone(),
    ),
    Err(_) => return,
  };
  save_preferences_async(pool.clone(), master, muted, last_preset);
}

pub fn create_session(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    session.id = new_id("noise_session");
    session.name = Some("Noise Mix".to_string());
    session.state = "idle".to_string();
    session.tracks.clear();
    session.sleep_minutes = 0;
    session.sleep_ends_at = None;
    session.created_at = now_ms();
    session.last_preset_id = None;
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub fn play_session(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    if session.tracks.is_empty() {
      return Err(MediaError::new(
        "noise.session.empty",
        "Noise Session 没有音轨",
      ));
    }
    session.state = "playing".to_string();
    touch(&mut session);
  }
  engine::ensure_window(app);
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub fn pause_session(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    session.state = "paused".to_string();
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub fn stop_session(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    session.state = "idle".to_string();
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub async fn set_master_volume(
  app: &AppHandle,
  volume: f64,
) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    session.master_volume = clamp_volume(volume);
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  pool_and_save();
  snapshot()
}

pub async fn set_muted(app: &AppHandle, muted: bool) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    session.muted = muted;
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  pool_and_save();
  snapshot()
}

fn end_sleep(session: &mut Session) {
  if session.state == "playing" {
    session.state = "paused".to_string();
  }
  session.sleep_minutes = 0;
  session.sleep_ends_at = None;
  touch(session);
}

pub fn set_sleep_timer(app: &AppHandle, minutes: i64) -> Result<NoiseSessionView, MediaError> {
  let minutes = minutes.clamp(0, 180);
  let generation = {
    let mut session = lock()?;
    session.sleep_generation = session.sleep_generation.saturating_add(1);
    session.sleep_minutes = minutes;
    session.sleep_ends_at = if minutes > 0 {
      Some(now_ms() + minutes * 60_000)
    } else {
      None
    };
    touch(&mut session);
    session.sleep_generation
  };
  emit_all(app);
  if minutes > 0 {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
      std::thread::sleep(Duration::from_secs(
        u64::try_from(minutes * 60).unwrap_or(u64::MAX),
      ));
      let fired = if let Ok(mut session) = lock() {
        if session.sleep_generation != generation {
          false
        } else {
          // 睡眠到点走“暂停”而不是只置 muted：状态与听感一致，播放按钮可
          // 直接恢复；原 muted 偏好保留。
          end_sleep(&mut session);
          true
        }
      } else {
        false
      };
      if fired {
        emit_all(&app);
        sync_engine(&app);
        pool_and_save();
      }
    });
  }
  snapshot()
}

async fn find_asset(
  pool: &SqlitePool,
  id_or_profile: &str,
) -> Result<Option<repository::AssetRow>, MediaError> {
  if let Some(asset) = repository::asset(pool, id_or_profile).await? {
    return Ok(Some(asset));
  }
  for asset in repository::assets(pool).await? {
    let (source, _) = source_from_asset(&asset);
    if let TrackSource::Procedural { profile, .. } = source {
      if profile == id_or_profile {
        return Ok(Some(asset));
      }
    }
  }
  Ok(None)
}

pub async fn add_track(app: &AppHandle, asset_id: &str) -> Result<NoiseTrackView, MediaError> {
  let pool = crate::media::library::pool()?;
  let asset = find_asset(pool, asset_id)
    .await?
    .ok_or_else(|| MediaError::new("noise.asset.not-found", "Noise 素材不存在"))?;
  if asset.status != "available" {
    return Err(MediaError::new("noise.asset.missing", "Noise 素材不可用"));
  }
  let (source, error) = source_from_asset(&asset);
  let (track, track_view) = {
    let mut session = lock()?;
    if session.tracks.len() >= MAX_TRACKS {
      return Err(MediaError::new(
        "noise.track.limit",
        "Noise 音轨数量已达上限",
      ));
    }
    let track = Track {
      id: new_id("noise_track"),
      asset_id: asset.id.clone(),
      name: asset.name.clone(),
      source,
      volume: 0.7,
      enabled: true,
      loop_: true,
      fade_in_ms: Some(80),
      fade_out_ms: Some(120),
      error,
      environment: None,
    };
    session.tracks.push(track.clone());
    touch(&mut session);
    let order = session.tracks.len() - 1;
    let view = track_view(&session, &session.tracks[order], order);
    (track, view)
  };
  if track.error.is_none() {
    sync_engine(app);
  }
  let revision = revision();
  events::emit(
    app,
    "noise.track.added",
    revision,
    json!({ "track": &track_view, "sessionRevision": revision }),
  );
  emit_all(app);
  Ok(track_view)
}

pub(super) fn validate_environment(config: &TrackEnvironment) -> Result<(), MediaError> {
  if config.environment_type.trim().is_empty() || config.environment_type.len() > 64
    || !config.intensity.is_finite() || !(0.0..=1.0).contains(&config.intensity)
    || !(2..=8).contains(&config.anchors.len()) {
    return Err(MediaError::invalid("环境类型、强度或素材数量无效"));
  }
  let mut previous = -1.0;
  let mut ids = std::collections::HashSet::new();
  for anchor in &config.anchors {
    if anchor.asset_id.is_empty() || !ids.insert(&anchor.asset_id)
      || !anchor.intensity.is_finite() || !(0.0..=1.0).contains(&anchor.intensity)
      || anchor.intensity <= previous {
      return Err(MediaError::invalid("环境素材必须不同且按强度递增"));
    }
    previous = anchor.intensity;
  }
  Ok(())
}

pub async fn configure_environment(
  app: &AppHandle, track_id: &str, config: TrackEnvironment,
) -> Result<NoiseSessionView, MediaError> {
  validate_environment(&config)?;
  let pool = crate::media::library::pool()?;
  let mut sources = Vec::with_capacity(config.anchors.len());
  for anchor in &config.anchors {
    let asset = repository::asset(pool, &anchor.asset_id).await?
      .ok_or_else(|| MediaError::new("noise.asset.not-found", "环境素材不存在"))?;
    let (source, error) = source_from_asset(&asset);
    if error.is_some() { return Err(MediaError::new("noise.asset.missing", "环境素材不可用")); }
    sources.push(source);
  }
  {
    let mut session = lock()?;
    let track = session.tracks.iter_mut().find(|track| track.id == track_id)
      .ok_or_else(|| MediaError::new("noise.track.not-found", "Noise 音轨不存在"))?;
    track.environment = Some(EnvironmentTrack { config, sources });
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub fn set_environment_intensity(
  app: &AppHandle, track_id: &str, intensity: f64,
) -> Result<NoiseSessionView, MediaError> {
  if !intensity.is_finite() || !(0.0..=1.0).contains(&intensity) {
    return Err(MediaError::invalid("环境强度必须在 0–1"));
  }
  {
    let mut session = lock()?;
    let track = session.tracks.iter_mut().find(|track| track.id == track_id)
      .ok_or_else(|| MediaError::new("noise.track.not-found", "Noise 音轨不存在"))?;
    let environment = track.environment.as_mut()
      .ok_or_else(|| MediaError::invalid("该音轨未配置环境强度"))?;
    environment.config.intensity = intensity;
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

pub fn remove_track(app: &AppHandle, track_id: &str) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    let before = session.tracks.len();
    session.tracks.retain(|track| track.id != track_id);
    if session.tracks.len() == before {
      return Err(MediaError::new("noise.track.not-found", "Noise 音轨不存在"));
    }
    if session.tracks.is_empty() {
      session.state = "idle".to_string();
    }
    touch(&mut session);
  }
  sync_engine(app);
  events::emit(
    app,
    "noise.track.removed",
    revision(),
    json!({ "trackId": track_id }),
  );
  emit_all(app);
  snapshot()
}

/// Asset 被删除后，移除 Session 中引用它的轨道。
pub fn remove_tracks_for_asset(app: &AppHandle, asset_id: &str) {
  let changed = if let Ok(mut session) = lock() {
    let before = session.tracks.len();
    let mut modified = false;
    for track in &mut session.tracks {
      if let Some(environment) = &mut track.environment {
        for (anchor, source) in environment.config.anchors.iter().zip(&mut environment.sources) {
          if anchor.asset_id == asset_id { *source = TrackSource::Missing; modified = true; }
        }
        if track.asset_id == asset_id { track.source = TrackSource::Missing; modified = true; }
      }
    }
    session.tracks.retain(|track| track.environment.is_some() || track.asset_id != asset_id);
    if session.tracks.len() == before && !modified {
      false
    } else {
      if session.tracks.is_empty() {
        session.state = "idle".to_string();
      }
      touch(&mut session);
      true
    }
  } else {
    false
  };
  if changed {
    sync_engine(app);
    emit_all(app);
  }
}

pub fn set_track_volume(
  app: &AppHandle,
  track_id: &str,
  volume: f64,
) -> Result<NoiseSessionView, MediaError> {
  let track_view = {
    let mut session = lock()?;
    let order = session
      .tracks
      .iter()
      .position(|track| track.id == track_id)
      .ok_or_else(|| MediaError::new("noise.track.not-found", "Noise 音轨不存在"))?;
    session.tracks[order].volume = clamp_volume(volume);
    touch(&mut session);
    track_view(&session, &session.tracks[order], order)
  };
  sync_engine(app);
  let revision = revision();
  events::emit(
    app,
    "noise.track.updated",
    revision,
    serde_json::to_value(&track_view).unwrap_or(Value::Null),
  );
  events::emit(
    app,
    "noise.volume.changed",
    revision,
    json!({ "scope": "track", "trackId": track_id, "volume": track_view.volume }),
  );
  emit_all(app);
  snapshot()
}

pub fn set_track_enabled(
  app: &AppHandle,
  track_id: &str,
  enabled: bool,
) -> Result<NoiseSessionView, MediaError> {
  let view = {
    let mut session = lock()?;
    let order = session
      .tracks
      .iter()
      .position(|track| track.id == track_id)
      .ok_or_else(|| MediaError::new("noise.track.not-found", "Noise 音轨不存在"))?;
    session.tracks[order].enabled = enabled;
    touch(&mut session);
    track_view(&session, &session.tracks[order], order)
  };
  sync_engine(app);
  events::emit(
    app,
    "noise.track.updated",
    revision(),
    serde_json::to_value(&view).unwrap_or(Value::Null),
  );
  emit_all(app);
  snapshot()
}

pub fn set_track_loop(
  app: &AppHandle,
  track_id: &str,
  loop_: bool,
) -> Result<NoiseSessionView, MediaError> {
  let view = {
    let mut session = lock()?;
    let order = session
      .tracks
      .iter()
      .position(|track| track.id == track_id)
      .ok_or_else(|| MediaError::new("noise.track.not-found", "Noise 音轨不存在"))?;
    session.tracks[order].loop_ = loop_;
    touch(&mut session);
    track_view(&session, &session.tracks[order], order)
  };
  sync_engine(app);
  events::emit(
    app,
    "noise.track.updated",
    revision(),
    serde_json::to_value(&view).unwrap_or(Value::Null),
  );
  emit_all(app);
  snapshot()
}

pub fn reorder_tracks(
  app: &AppHandle,
  track_id: &str,
  position: usize,
) -> Result<NoiseSessionView, MediaError> {
  {
    let mut session = lock()?;
    let Some(current) = session.tracks.iter().position(|track| track.id == track_id) else {
      return Err(MediaError::new("noise.track.not-found", "Noise 音轨不存在"));
    };
    let track = session.tracks.remove(current);
    let target = position.min(session.tracks.len());
    session.tracks.insert(target, track);
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  snapshot()
}

/// 记录最近加载/保存的 Preset，只更新偏好，不改变 Session 音轨。
pub fn remember_preset(preset_id: Option<String>) {
  if let Ok(mut session) = lock() {
    session.last_preset_id = preset_id;
  }
  pool_and_save();
}

/// Preset 被删除时清掉内存中的 last_preset_id，避免偏好保存触发外键失败。
pub fn forget_preset_if(preset_id: &str) {
  let changed = if let Ok(mut session) = lock() {
    if session.last_preset_id.as_deref() == Some(preset_id) {
      session.last_preset_id = None;
      true
    } else {
      false
    }
  } else {
    false
  };
  if changed {
    pool_and_save();
  }
}

/// 旧 `reset`：恢复默认 Preset；保留当前播放状态。
pub async fn reset_default(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  let pool = crate::media::library::pool()?;
  let tracks = load_preset_tracks(pool, DEFAULT_PRESET_ID).await?;
  {
    let mut session = lock()?;
    session.tracks = tracks;
    session.master_volume = 0.75;
    session.muted = false;
    session.sleep_minutes = 0;
    session.sleep_ends_at = None;
    session.sleep_generation = session.sleep_generation.saturating_add(1);
    session.last_preset_id = Some(DEFAULT_PRESET_ID.to_string());
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  pool_and_save();
  snapshot()
}

/// 旧 `activate`：没有音轨时先恢复默认混音，再开始播放。
pub async fn activate(app: &AppHandle) -> Result<NoiseSessionView, MediaError> {
  let empty = lock()?.tracks.is_empty();
  if empty {
    reset_default(app).await?;
  }
  play_session(app)
}

/// N4 Preset 已解析的一条轨道；AssetRow 由 presets 模块查询后传入。
pub struct PresetSessionTrack {
  pub asset: Option<repository::AssetRow>,
  pub asset_id: String,
  pub environment: Option<(TrackEnvironment, Vec<Option<repository::AssetRow>>)>,
  pub name: String,
  pub volume: f64,
  pub enabled: bool,
  pub loop_: bool,
  pub fade_in_ms: Option<i64>,
  pub fade_out_ms: Option<i64>,
}

/// 用 Preset 替换 Session；不自动播放，保留 muted，清空睡眠定时。
pub fn replace_with_preset(
  app: &AppHandle,
  tracks: Vec<PresetSessionTrack>,
  master_volume: f64,
  preset_id: Option<String>,
) -> Result<NoiseSessionView, MediaError> {
  let mut next_tracks = Vec::with_capacity(tracks.len());
  for request in tracks {
    let (source, error) = request.asset.as_ref().map(source_from_asset).unwrap_or((TrackSource::Missing, None));
    let environment = request.environment.map(|(config, assets)| EnvironmentTrack {
      config,
      sources: assets.iter().map(|asset| asset.as_ref().map(|asset| source_from_asset(asset).0).unwrap_or(TrackSource::Missing)).collect(),
    });
    next_tracks.push(Track {
      id: new_id("noise_track"),
      asset_id: request.asset_id,
      name: request.name,
      source,
      volume: clamp_volume(request.volume),
      enabled: request.enabled,
      loop_: request.loop_,
      fade_in_ms: request.fade_in_ms,
      fade_out_ms: request.fade_out_ms,
      error,
      environment,
    });
  }
  {
    let mut session = lock()?;
    session.tracks = next_tracks;
    session.state = "idle".to_string();
    session.master_volume = clamp_volume(master_volume);
    session.sleep_minutes = 0;
    session.sleep_ends_at = None;
    session.sleep_generation = session.sleep_generation.saturating_add(1);
    session.last_preset_id = preset_id;
    touch(&mut session);
  }
  sync_engine(app);
  emit_all(app);
  pool_and_save();
  snapshot()
}

/// 旧 `setLayer`：按 profile / asset ID 找轨，必要时从 builtin Asset 补一条。
pub async fn set_legacy_layer(
  app: &AppHandle,
  sound_id: &str,
  enabled: Option<bool>,
  volume: Option<f64>,
) -> Result<NoiseSessionView, MediaError> {
  let existing = lock()?
    .tracks
    .iter()
    .find(|track| legacy_sound_id(track) == sound_id)
    .map(|track| track.id.clone());
  let track_id = if let Some(track_id) = existing {
    track_id
  } else {
    let pool = crate::media::library::pool()?;
    let mut asset_id = None;
    for asset in repository::assets(pool).await? {
      let (source, _) = source_from_asset(&asset);
      if let TrackSource::Procedural { profile, .. } = source {
        if profile == sound_id {
          asset_id = Some(asset.id);
          break;
        }
      }
    }
    let asset_id =
      asset_id.ok_or_else(|| MediaError::new("noise.asset.not-found", "未知的 Noise 声景"))?;
    let added = add_track(app, &asset_id).await?;
    added.id
  };
  if let Some(enabled) = enabled {
    set_track_enabled(app, &track_id, enabled)?;
  }
  if let Some(volume) = volume {
    set_track_volume(app, &track_id, volume)?;
  }
  snapshot()
}

/// 退出/窗口丢失：保存偏好，不保留 Session/Track。
pub fn shutdown() {
  let Ok(pool) = crate::media::library::pool() else {
    return;
  };
  let (master, muted, last_preset) = match lock() {
    Ok(session) => (
      session.master_volume,
      session.muted,
      session.last_preset_id.clone(),
    ),
    Err(_) => return,
  };
  let _ = tauri::async_runtime::block_on(repository::save_preferences(
    pool,
    master,
    muted,
    last_preset.as_deref(),
  ));
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  #[test]
  fn environment_requires_distinct_ordered_anchors_and_normalized_intensity() {
    use crate::media::noise::dto::EnvironmentAnchor;
    let mut config = TrackEnvironment {
      environment_type: "rain".to_string(),
      intensity: 0.5,
      anchors: vec![
        EnvironmentAnchor { asset_id: "drizzle".to_string(), intensity: 0.0, asset_hash: None, expected_name: None },
        EnvironmentAnchor { asset_id: "storm".to_string(), intensity: 1.0, asset_hash: None, expected_name: None },
      ],
    };
    assert!(validate_environment(&config).is_ok());
    config.anchors[1].asset_id = "drizzle".to_string();
    assert!(validate_environment(&config).is_err());
    config.anchors[1].asset_id = "storm".to_string();
    config.anchors[1].intensity = 0.0;
    assert!(validate_environment(&config).is_err());
    config.anchors[1].intensity = 1.0;
    config.intensity = f64::NAN;
    assert!(validate_environment(&config).is_err());
  }

  #[test]
  fn session_view_maps_legacy_sound_ids() {
    let session = Session {
      id: "session".to_string(),
      name: None,
      state: "playing".to_string(),
      master_volume: 0.7,
      muted: false,
      tracks: vec![Track {
        id: "track".to_string(),
        asset_id: "noise:builtin:rain".to_string(),
        name: "雨声".to_string(),
        source: TrackSource::Procedural {
          profile: "rain".to_string(),
          version: 1,
        },
        volume: 0.5,
        enabled: true,
        loop_: true,
        fade_in_ms: None,
        fade_out_ms: None,
        error: None,
        environment: None,
      }],
      sleep_minutes: 0,
      sleep_ends_at: None,
      created_at: 1,
      revision: 3,
      sleep_generation: 0,
      last_preset_id: None,
    };
    let view = legacy_view(&session);
    assert!(view.active);
    assert_eq!(view.layers[0].sound_id, "rain");
    let session_view = session_view(&session);
    assert_eq!(session_view.tracks[0].state, "playing");
    assert_eq!(session_view.revision, 3);
  }

  #[test]
  fn environment_targets_use_max_and_ignore_volume_and_mute() {
    let source = TrackSource::Procedural { profile: "rain".into(), version: 1 };
    let make_track = |intensity, enabled| Track {
      id: format!("track-{intensity}"), asset_id: "rain".into(), name: "rain".into(),
      source: source.clone(), volume: 0.0, enabled, loop_: true, fade_in_ms: None,
      fade_out_ms: None, error: None,
      environment: Some(EnvironmentTrack {
        config: TrackEnvironment { environment_type: "rain".into(), intensity, anchors: vec![] },
        sources: vec![source.clone()],
      }),
    };
    let mut session = Session {
      id: "test".into(), name: None, state: "playing".into(), master_volume: 0.0,
      muted: true, tracks: vec![make_track(0.3, true), make_track(0.7, true), make_track(0.9, false)],
      sleep_minutes: 0, sleep_ends_at: None, created_at: 0, revision: 0,
      sleep_generation: 0, last_preset_id: None,
    };
    assert_eq!(environment_targets(&session).get("rain"), Some(&0.7));
    session.tracks.remove(1);
    assert_eq!(environment_targets(&session).get("rain"), Some(&0.3));
    session.state = "paused".into();
    assert!(environment_targets(&session).is_empty());
    session.state = "idle".into();
    assert!(environment_targets(&session).is_empty());
  }

  #[test]
  fn sleep_end_pauses_session_and_keeps_muted_preference() {
    let mut session = Session {
      id: "session".to_string(),
      name: None,
      state: "playing".to_string(),
      master_volume: 0.7,
      muted: true,
      tracks: Vec::new(),
      sleep_minutes: 1,
      sleep_ends_at: Some(1),
      created_at: 1,
      revision: 3,
      sleep_generation: 1,
      last_preset_id: None,
    };
    end_sleep(&mut session);
    assert_eq!(session.state, "paused");
    assert!(session.muted);
    assert_eq!(session.sleep_minutes, 0);
    assert_eq!(session.sleep_ends_at, None);
    assert_eq!(session.revision, 4);
    assert!(!legacy_view(&session).active);
  }

  #[test]
  fn preset_tracks_load_builtin_assets() {
    let path = std::env::temp_dir().join(format!("lull-noise-session-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      super::super::catalog::seed(&pool).await.expect("seed");
      let tracks = load_preset_tracks(&pool, DEFAULT_PRESET_ID)
        .await
        .expect("load preset");
      assert_eq!(tracks.len(), 5);
      assert!(tracks.iter().all(|track| track.error.is_none()));
      db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
