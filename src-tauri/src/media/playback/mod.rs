//! P2 播放服务：全局播放器、队列、白噪音混音与隐藏音频引擎。
//!
//! 状态由 Rust 持有；引擎只负责发声。播放进度高频更新只存在内存与事件里，
//! 暂停/停止/切歌/音量/队列/噪声参数写入 SQLite。

pub mod model;
pub mod store;

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, WebviewWindow};

use self::model::{
  NoiseLayerView, NoiseSleepView, NoiseSoundView, NoiseStateView, PlayerStateView, QueueStateView,
};
use super::api::dto::TrackSummary;
use super::api::errors::MediaError;
use super::engine;
use super::repository::{now_ms, tracks};

const ENGINE_LABEL: &str = engine::ENGINE_LABEL;

#[derive(Debug, Clone)]
pub struct PlayerData {
  pub current_track_id: Option<String>,
  pub position_ms: i64,
  pub volume: f64,
  pub muted: bool,
  pub mode: String,
}

impl Default for PlayerData {
  fn default() -> Self {
    Self {
      current_track_id: None,
      position_ms: 0,
      volume: 0.78,
      muted: false,
      mode: "sequence".to_string(),
    }
  }
}

#[derive(Debug, Clone)]
pub struct NoiseData {
  pub active: bool,
  pub master: f64,
  pub muted: bool,
  pub layers: Vec<NoiseLayerView>,
  pub sleep_minutes: i64,
  pub sleep_ends_at: Option<i64>,
}

impl Default for NoiseData {
  fn default() -> Self {
    Self {
      active: false,
      master: 0.75,
      muted: false,
      layers: default_layers(),
      sleep_minutes: 0,
      sleep_ends_at: None,
    }
  }
}

fn default_layers() -> Vec<NoiseLayerView> {
  vec![
    NoiseLayerView {
      sound_id: "rain".to_string(),
      enabled: true,
      volume: 0.7,
    },
    NoiseLayerView {
      sound_id: "thunder".to_string(),
      enabled: false,
      volume: 0.45,
    },
    NoiseLayerView {
      sound_id: "wind".to_string(),
      enabled: true,
      volume: 0.3,
    },
    NoiseLayerView {
      sound_id: "waves".to_string(),
      enabled: false,
      volume: 0.4,
    },
    NoiseLayerView {
      sound_id: "fire".to_string(),
      enabled: true,
      volume: 0.5,
    },
  ]
}

struct Service {
  player: PlayerData,
  current_track: Option<TrackSummary>,
  status: String,
  duration_ms: Option<i64>,
  error: Option<Value>,
  queue: Vec<String>,
  noise: NoiseData,
  revision: u64,
  engine_ready: bool,
  syncing: bool,
  sync_pending: bool,
  load_seq: u64,
  current_load_id: Option<String>,
  sleep_generation: u64,
}

static SERVICE: OnceLock<Mutex<Service>> = OnceLock::new();

fn lock() -> Result<MutexGuard<'static, Service>, MediaError> {
  SERVICE
    .get()
    .map(|service| service.lock().unwrap_or_else(PoisonError::into_inner))
    .ok_or_else(|| MediaError::unavailable("播放服务尚未初始化"))
}

fn touch(service: &mut Service) -> u64 {
  service.revision = service.revision.saturating_add(1);
  service.revision
}

fn queue_index(service: &Service) -> Option<usize> {
  service
    .player
    .current_track_id
    .as_ref()
    .and_then(|id| service.queue.iter().position(|item| item == id))
}

fn player_view(service: &Service) -> PlayerStateView {
  PlayerStateView {
    track: service.current_track.clone(),
    status: service.status.clone(),
    position_ms: service.player.position_ms.max(0),
    duration_ms: service.duration_ms,
    volume: service.player.volume.clamp(0.0, 1.0),
    muted: service.player.muted,
    mode: service.player.mode.clone(),
    revision: service.revision,
    error: service.error.clone(),
  }
}

fn queue_view(service: &Service) -> QueueStateView {
  QueueStateView {
    track_ids: service.queue.clone(),
    current_index: queue_index(service),
    revision: service.revision,
  }
}

fn noise_view(service: &Service) -> NoiseStateView {
  NoiseStateView {
    session_id: "default".to_string(),
    active: service.noise.active,
    master: service.noise.master.clamp(0.0, 1.0),
    muted: service.noise.muted,
    layers: service.noise.layers.clone(),
    sleep: NoiseSleepView {
      timer_minutes: service.noise.sleep_minutes,
      ends_at: service.noise.sleep_ends_at,
    },
    revision: service.revision,
  }
}

/// 一次加锁取出 Player/Queue/Noise 视图，避免快照内部出现跨 revision 的撕裂。
pub(crate) fn snapshot_parts(
) -> Result<(PlayerStateView, QueueStateView, NoiseStateView), MediaError> {
  let service = lock()?;
  Ok((
    player_view(&service),
    queue_view(&service),
    noise_view(&service),
  ))
}

fn emit(app: &AppHandle, service: &Service, topic: &str, payload: Value) {
  super::events::emit(app, topic, service.revision, payload);
}

fn emit_state(app: &AppHandle, service: &Service) {
  emit(
    app,
    service,
    "player.state",
    serde_json::to_value(player_view(service)).unwrap_or(Value::Null),
  );
  emit(
    app,
    service,
    "queue.changed",
    serde_json::to_value(queue_view(service)).unwrap_or(Value::Null),
  );
}

fn emit_noise(app: &AppHandle, service: &Service) {
  emit(
    app,
    service,
    "noise.state",
    serde_json::to_value(noise_view(service)).unwrap_or(Value::Null),
  );
}

fn save_player(app: &AppHandle, pool: &SqlitePool, player: &PlayerData) {
  let pool = pool.clone();
  let player = player.clone();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = store::save_player(&pool, &player).await {
      crate::wallpaper::wlog(&format!("保存播放状态失败：{error}"));
    }
    let _ = app;
  });
}

fn save_queue(app: &AppHandle, pool: &SqlitePool, queue: &[String]) {
  let pool = pool.clone();
  let queue = queue.to_vec();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = store::save_queue(&pool, &queue).await {
      crate::wallpaper::wlog(&format!("保存播放队列失败：{error}"));
    }
    let _ = app;
  });
}

fn save_noise(app: &AppHandle, pool: &SqlitePool, noise: &NoiseData) {
  let pool = pool.clone();
  let noise = noise.clone();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = store::save_noise(&pool, &noise).await {
      crate::wallpaper::wlog(&format!("保存噪声状态失败：{error}"));
    }
    let _ = app;
  });
}

/// 资料库初始化完成后加载播放状态；引擎窗口仍按需创建。
pub async fn init(pool: &SqlitePool) -> Result<(), MediaError> {
  if SERVICE.get().is_some() {
    return Ok(());
  }
  let (mut player, queue, mut noise) = store::load(pool).await?;
  // 旧播放器把“静音”写成 volume=0 且 muted=false；这种状态重启后无法出声。
  // 新 UI 只用 muted 表达静音，这里把历史坏状态修回默认音量（muted 保持原值）。
  if player.volume <= f64::EPSILON && !player.muted {
    player.volume = PlayerData::default().volume;
    let _ = store::save_player(pool, &player).await;
  }
  // 应用重启只恢复混音参数，不自动播放白噪音；首次用户手势才 activate。
  if noise.active || noise.sleep_minutes != 0 || noise.sleep_ends_at.is_some() {
    noise.active = false;
    noise.sleep_minutes = 0;
    noise.sleep_ends_at = None;
    let _ = store::save_noise(pool, &noise).await;
  }
  let queue = store::ensure_queue(pool, &queue).await?;
  let current_track_id = player
    .current_track_id
    .clone()
    .or_else(|| queue.first().cloned());
  player.current_track_id = current_track_id.clone();
  let status = if current_track_id.is_some() {
    "paused".to_string()
  } else {
    "idle".to_string()
  };
  let current_track = match current_track_id.as_deref() {
    Some(id) => tracks::get(pool, id).await?.map(TrackSummary::from),
    None => None,
  };
  let duration_ms = current_track.as_ref().and_then(|track| track.duration_ms);
  let service = Service {
    player,
    current_track,
    status,
    duration_ms,
    error: None,
    queue,
    noise,
    revision: 0,
    engine_ready: false,
    syncing: false,
    sync_pending: false,
    load_seq: 0,
    current_load_id: None,
    sleep_generation: 0,
  };
  let _ = SERVICE.set(Mutex::new(service));
  Ok(())
}

/// 引擎窗口丢失时降级播放状态；订阅清理由 `media::events` 负责。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
  if label != ENGINE_LABEL {
    return;
  }
  if let Ok(mut service) = lock() {
    service.engine_ready = false;
    if service.status == "playing" || service.status == "loading" {
      service.status = "paused".to_string();
      touch(&mut service);
      emit_state(app, &service);
    }
  }
  crate::wallpaper::wlog("media engine 窗口已销毁，播放暂停");
}

pub fn shutdown() {
  let (player, queue, noise) = match lock() {
    Ok(service) => (
      service.player.clone(),
      service.queue.clone(),
      service.noise.clone(),
    ),
    Err(_) => return,
  };
  if let Ok(pool) = super::library::pool() {
    let pool = pool.clone();
    // 退出事件里 spawn 的任务可能来不及跑完；这里同步等一次小写入。
    let _ = tauri::async_runtime::block_on(async {
      store::save_player(&pool, &player).await?;
      store::save_queue(&pool, &queue).await?;
      store::save_noise(&pool, &noise).await
    });
  }
}

/// `media_call` 的 playback 域入口。
pub async fn call(
  app: AppHandle,
  label: &str,
  namespace: &str,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  let pool = super::library::pool()?.clone();
  let result = match (namespace, method) {
    ("player", "getState") => {
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "play") => {
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .map(str::to_string);
      play(&app, &pool, track_id).await?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "pause") => {
      pause(&app, &pool)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "resume") => {
      resume(&app, &pool).await?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "stop") => {
      stop(&app, &pool)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "seek") => {
      let position = args
        .get("positionMs")
        .and_then(Value::as_i64)
        .ok_or_else(|| MediaError::invalid("缺少 positionMs"))?;
      seek(&app, &pool, position)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "next") => {
      next(&app, &pool, 1).await?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "previous") => {
      next(&app, &pool, -1).await?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "setVolume") => {
      let volume = args
        .get("volume")
        .and_then(Value::as_f64)
        .ok_or_else(|| MediaError::invalid("缺少 volume"))?;
      set_volume(&app, &pool, volume)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "setMuted") => {
      let muted = args
        .get("muted")
        .and_then(Value::as_bool)
        .ok_or_else(|| MediaError::invalid("缺少 muted"))?;
      set_muted(&app, &pool, muted)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("player", "setMode") => {
      let mode = args
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 mode"))?;
      set_mode(&app, &pool, mode)?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "get") => {
      let service = lock()?;
      Ok(serde_json::to_value(queue_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "add") => {
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"))?;
      queue_add(
        &app,
        &pool,
        track_id,
        args.get("index").and_then(Value::as_u64),
      )?;
      let service = lock()?;
      Ok(serde_json::to_value(queue_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "remove") => {
      let track_id = args
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"))?;
      queue_remove(&app, &pool, track_id)?;
      let service = lock()?;
      Ok(serde_json::to_value(queue_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "clear") => {
      queue_clear(&app, &pool)?;
      let service = lock()?;
      Ok(serde_json::to_value(queue_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "move") => {
      let from = args
        .get("fromIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| MediaError::invalid("缺少 fromIndex"))?;
      let to = args
        .get("toIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| MediaError::invalid("缺少 toIndex"))?;
      queue_move(&app, &pool, from, to)?;
      let service = lock()?;
      Ok(serde_json::to_value(queue_view(&service)).unwrap_or(Value::Null))
    }
    ("queue", "playAt") => {
      let index = args
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| MediaError::invalid("缺少 index"))?;
      queue_play_at(&app, &pool, index).await?;
      let service = lock()?;
      Ok(serde_json::to_value(player_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "getState") => {
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "getSounds") => serde_json::to_value(noise_sounds())
      .map_err(|error| MediaError::internal(format!("序列化噪声声景失败：{error}"))),
    ("noise", "activate") => {
      noise_activate(&app, &pool)?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "setLayer") => {
      let sound_id = args
        .get("soundId")
        .and_then(Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 soundId"))?;
      noise_set_layer(
        &app,
        &pool,
        sound_id,
        args.get("enabled").and_then(Value::as_bool),
        args.get("volume").and_then(Value::as_f64),
      )?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "setMaster") => {
      let volume = args
        .get("volume")
        .and_then(Value::as_f64)
        .ok_or_else(|| MediaError::invalid("缺少 volume"))?;
      noise_set_master(&app, &pool, volume)?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "setMuted") => {
      let muted = args
        .get("muted")
        .and_then(Value::as_bool)
        .ok_or_else(|| MediaError::invalid("缺少 muted"))?;
      noise_set_muted(&app, &pool, muted)?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "setSleepTimer") => {
      let minutes = args
        .get("minutes")
        .and_then(Value::as_i64)
        .ok_or_else(|| MediaError::invalid("缺少 minutes"))?;
      noise_set_sleep(&app, &pool, minutes)?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    ("noise", "reset") => {
      noise_reset(&app, &pool)?;
      let service = lock()?;
      Ok(serde_json::to_value(noise_view(&service)).unwrap_or(Value::Null))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的播放方法：{namespace}.{method}（{label}）"),
    )),
  }?;
  Ok(result)
}

pub fn revision() -> u64 {
  lock().map(|service| service.revision).unwrap_or(0)
}

#[must_use]
pub fn is_engine_ready() -> bool {
  lock().is_ok_and(|service| service.engine_ready)
}

fn noise_sounds() -> Vec<NoiseSoundView> {
  vec![
    NoiseSoundView {
      id: "rain".to_string(),
      name: "Rain".to_string(),
    },
    NoiseSoundView {
      id: "thunder".to_string(),
      name: "Thunder".to_string(),
    },
    NoiseSoundView {
      id: "wind".to_string(),
      name: "Wind".to_string(),
    },
    NoiseSoundView {
      id: "waves".to_string(),
      name: "Waves".to_string(),
    },
    NoiseSoundView {
      id: "fire".to_string(),
      name: "Fire".to_string(),
    },
  ]
}

async fn play(
  app: &AppHandle,
  pool: &SqlitePool,
  track_id: Option<String>,
) -> Result<(), MediaError> {
  let id = match track_id {
    Some(id) => Some(id),
    None => {
      let service = lock()?;
      service
        .player
        .current_track_id
        .clone()
        .or_else(|| service.queue.first().cloned())
    }
  };
  let Some(id) = id else {
    return Err(MediaError::new("queue.empty", "播放队列为空"));
  };
  let track = tracks::get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  let player = {
    let mut service = lock()?;
    service.player.current_track_id = Some(id);
    service.player.position_ms = 0;
    service.current_track = Some(TrackSummary::from(track));
    service.duration_ms = service
      .current_track
      .as_ref()
      .and_then(|track| track.duration_ms);
    service.status = "loading".to_string();
    service.error = None;
    touch(&mut service);
    emit_state(app, &service);
    service.player.clone()
  };
  save_player(app, pool, &player);
  engine::ensure_window(app);
  let pool = pool.clone();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = sync_engine(&app, &pool).await {
      set_error(&app, &error);
    }
  });
  Ok(())
}

async fn resume(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let (has_current, ready) = {
    let service = lock()?;
    (
      service.player.current_track_id.is_some(),
      service.engine_ready,
    )
  };
  if !has_current {
    return play(app, pool, None).await;
  }
  {
    let mut service = lock()?;
    service.status = "playing".to_string();
    service.error = None;
    touch(&mut service);
    emit_state(app, &service);
  }
  if ready {
    engine::send(app, engine::player_control("player.play"));
  } else {
    engine::ensure_window(app);
    let app = app.clone();
    let pool = pool.clone();
    tauri::async_runtime::spawn(async move {
      if let Err(error) = sync_engine(&app, &pool).await {
        set_error(&app, &error);
      }
    });
  }
  Ok(())
}

fn pause(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let player = {
    let mut service = lock()?;
    service.status = "paused".to_string();
    touch(&mut service);
    emit_state(app, &service);
    service.player.clone()
  };
  engine::send(app, engine::player_control("player.pause"));
  save_player(app, pool, &player);
  Ok(())
}

fn stop(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let player = {
    let mut service = lock()?;
    service.status = "idle".to_string();
    service.player.position_ms = 0;
    service.duration_ms = None;
    service.error = None;
    service.current_load_id = None;
    touch(&mut service);
    emit_state(app, &service);
    service.player.clone()
  };
  engine::send(app, engine::player_control("player.stop"));
  save_player(app, pool, &player);
  Ok(())
}

fn seek(app: &AppHandle, pool: &SqlitePool, position_ms: i64) -> Result<(), MediaError> {
  let (position, player) = {
    let mut service = lock()?;
    let max = service.duration_ms.unwrap_or(i64::MAX).max(0);
    let position = position_ms.clamp(0, max);
    service.player.position_ms = position;
    touch(&mut service);
    emit_state(app, &service);
    (position, service.player.clone())
  };
  engine::send(app, engine::player_seek(position));
  save_player(app, pool, &player);
  Ok(())
}

fn set_volume(app: &AppHandle, pool: &SqlitePool, volume: f64) -> Result<(), MediaError> {
  let (volume, muted, player) = {
    let mut service = lock()?;
    let volume = if volume.is_finite() {
      volume.clamp(0.0, 1.0)
    } else {
      0.0
    };
    service.player.volume = volume;
    let muted = service.player.muted;
    touch(&mut service);
    emit_state(app, &service);
    (volume, muted, service.player.clone())
  };
  engine::send(app, engine::player_volume(volume, muted));
  save_player(app, pool, &player);
  Ok(())
}

fn set_muted(app: &AppHandle, pool: &SqlitePool, muted: bool) -> Result<(), MediaError> {
  let (volume, player) = {
    let mut service = lock()?;
    service.player.muted = muted;
    let volume = service.player.volume;
    touch(&mut service);
    emit_state(app, &service);
    (volume, service.player.clone())
  };
  engine::send(app, engine::player_volume(volume, muted));
  save_player(app, pool, &player);
  Ok(())
}

fn set_mode(app: &AppHandle, pool: &SqlitePool, mode: &str) -> Result<(), MediaError> {
  let Some(mode) = model::PlayMode::parse(mode) else {
    return Err(MediaError::invalid("不支持的播放模式"));
  };
  let player = {
    let mut service = lock()?;
    service.player.mode = mode.as_str().to_string();
    touch(&mut service);
    emit_state(app, &service);
    service.player.clone()
  };
  save_player(app, pool, &player);
  Ok(())
}

async fn next(app: &AppHandle, pool: &SqlitePool, direction: i32) -> Result<(), MediaError> {
  let target = {
    let service = lock()?;
    if service.queue.is_empty() {
      return Err(MediaError::new("queue.empty", "播放队列为空"));
    }
    if service.queue.len() == 1 {
      service.queue[0].clone()
    } else {
      let current = service
        .player
        .current_track_id
        .as_ref()
        .and_then(|id| service.queue.iter().position(|item| item == id));
      let len = service.queue.len();
      let index = if service.player.mode == "shuffle" {
        // 不引入额外随机数依赖；用时间与当前索引轮转，避免连续重复。
        let offset = usize::try_from(now_ms()).unwrap_or(0) % (len - 1) + 1;
        (current.unwrap_or(0) + offset) % len
      } else {
        match current {
          Some(index) => {
            if direction > 0 {
              (index + 1) % len
            } else {
              (index + len - 1) % len
            }
          }
          None => 0,
        }
      };
      service.queue[index].clone()
    }
  };
  play(app, pool, Some(target)).await
}

/// 串行化引擎对账，避免 play/ready 并发产生多个 loadId，导致旧引擎事件全部
/// 被丢弃而服务端停在 loading。
async fn sync_engine(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  loop {
    {
      let mut service = lock()?;
      if service.syncing {
        service.sync_pending = true;
        return Ok(());
      }
      service.syncing = true;
    }
    let result = sync_engine_inner(app, pool).await;
    let rerun = match lock() {
      Ok(mut service) => {
        service.syncing = false;
        let pending = service.sync_pending;
        service.sync_pending = false;
        pending
      }
      Err(_) => false,
    };
    if !rerun {
      return result;
    }
  }
}

async fn sync_engine_inner(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let progress_ms = super::events::min_progress_ms();
  let levels = super::events::any_levels();
  let (ready, track_id, position, status, noise, volume, muted) = {
    let service = lock()?;
    (
      service.engine_ready,
      service.player.current_track_id.clone(),
      service.player.position_ms,
      service.status.clone(),
      service.noise.clone(),
      service.player.volume,
      service.player.muted,
    )
  };
  if !ready {
    return Ok(());
  }

  if let Some(track_id) = track_id.filter(|_| status != "idle") {
    let (track, source) = resolve_source(app, pool, &track_id).await?;
    let duration = track.duration_ms;
    let load_id = {
      let mut service = lock()?;
      service.load_seq = service.load_seq.saturating_add(1);
      service.current_load_id = Some(format!("load-{}", service.load_seq));
      service.current_track = Some(track);
      service.duration_ms = duration;
      service
        .current_load_id
        .clone()
        .unwrap_or_else(|| "load-unknown".to_string())
    };
    engine::send(
      app,
      engine::player_load(
        &load_id,
        &source,
        position,
        duration,
        status == "playing" || status == "loading",
      ),
    );
    engine::send(app, engine::player_volume(volume, muted));
  }

  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  super::output::sync(app);
  engine::send(app, engine::meters(true, levels, progress_ms));
  Ok(())
}

async fn resolve_source(
  app: &AppHandle,
  pool: &SqlitePool,
  track_id: &str,
) -> Result<(TrackSummary, Value), MediaError> {
  let row = tracks::get(pool, track_id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  let kind = row.kind.clone();
  let summary = TrackSummary::from(row);
  let source = if kind == "builtin" {
    let preset: Option<String> =
      sqlx::query_scalar("SELECT playback_preset_json FROM music_tracks WHERE id = ?")
        .bind(track_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| MediaError::internal(format!("读取内置曲预设失败：{error}")))?
        .flatten();
    let preset = preset.ok_or_else(|| MediaError::new("track.unavailable", "内置曲缺少预设"))?;
    let preset: Value = serde_json::from_str(&preset)
      .map_err(|error| MediaError::internal(format!("内置曲预设损坏：{error}")))?;
    json!({ "kind": "ambient", "preset": preset })
  } else {
    let path: Option<String> = sqlx::query_scalar(
      "SELECT path FROM music_files WHERE track_id = ? AND available = 1 \
       ORDER BY format LIMIT 1",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取曲目文件失败：{error}")))?
    .flatten();
    let path = path.ok_or_else(|| MediaError::new("track.unavailable", "曲目文件不可用"))?;
    app
      .asset_protocol_scope()
      .allow_file(&path)
      .map_err(|error| MediaError::internal(format!("媒体资源授权失败：{error}")))?;
    let window = app
      .get_webview_window(ENGINE_LABEL)
      .ok_or_else(|| MediaError::unavailable("音频引擎窗口未就绪"))?;
    let url = window
      .convert_file_src(&path, None)
      .map_err(|error| MediaError::internal(format!("媒体 URL 生成失败：{error}")))?;
    json!({ "kind": "asset", "url": url })
  };
  Ok((summary, source))
}

fn set_error(app: &AppHandle, error: &MediaError) {
  crate::wallpaper::wlog(&format!("播放错误 {}: {}", error.code, error.message));
  if let Ok(mut service) = lock() {
    service.status = "error".to_string();
    service.error = Some(
      error
        .body()
        .details
        .unwrap_or_else(|| serde_json::json!({ "code": error.code, "message": error.message })),
    );
    touch(&mut service);
    emit_state(app, &service);
  }
}

pub fn on_engine_ready(app: &AppHandle) {
  if let Ok(mut service) = lock() {
    service.engine_ready = true;
  }
  let app = app.clone();
  let pool = match super::library::pool() {
    Ok(pool) => pool.clone(),
    Err(error) => {
      set_error(&app, &error);
      return;
    }
  };
  tauri::async_runtime::spawn(async move {
    if let Err(error) = sync_engine(&app, &pool).await {
      set_error(&app, &error);
    }
  });
}

pub fn on_engine_event(app: &AppHandle, event: engine::EngineEvent) {
  match event {
    engine::EngineEvent::Ready { instance_id } => {
      if let Some(instance_id) = instance_id {
        crate::wallpaper::wlog(&format!("media engine ready instance={instance_id}"));
      }
      on_engine_ready(app);
    }
    engine::EngineEvent::PlayerLoaded {
      load_id,
      duration_ms,
    } => {
      if let Ok(mut service) = lock() {
        if service.current_load_id.as_deref() != Some(load_id.as_str()) {
          return;
        }
        // 只更新时长；紧随其后的 player.state 会带着最终状态和时长一起发。
        // 这里若 emit_state，会把已经变成 playing 的状态又写回 loading。
        service.duration_ms = duration_ms;
      }
    }
    engine::EngineEvent::PlayerState {
      load_id,
      status,
      position_ms,
      duration_ms,
      error,
    } => {
      let ended = status == "ended";
      if let Ok(mut service) = lock() {
        if service.current_load_id.as_deref() != Some(load_id.as_str()) {
          return;
        }
        service.player.position_ms = position_ms.max(0);
        service.duration_ms = duration_ms.or(service.duration_ms);
        service.error = error;
        if ended {
          service.status = "ended".to_string();
        } else if status == "error" {
          service.status = "error".to_string();
        } else {
          service.status = status;
        }
        touch(&mut service);
        emit_state(app, &service);
      }
      if ended {
        let pool = match super::library::pool() {
          Ok(pool) => pool.clone(),
          Err(_) => return,
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
          let _ = handle_ended(&app, &pool).await;
        });
      }
    }
    engine::EngineEvent::PlayerProgress {
      load_id,
      position_ms,
    } => {
      let payload = {
        let mut service = match lock() {
          Ok(service) => service,
          Err(_) => return,
        };
        if service.current_load_id.as_deref() != Some(load_id.as_str()) {
          return;
        }
        service.player.position_ms = position_ms.max(0);
        json!({
          "trackId": service.player.current_track_id,
          "positionMs": position_ms.max(0),
          "durationMs": service.duration_ms,
        })
      };
      if let Ok(service) = lock() {
        emit(app, &service, "player.progress", payload);
      }
    }
    engine::EngineEvent::Levels { player, noise } => {
      let payload = json!({ "player": player.clamp(0.0, 1.0), "noise": noise.clamp(0.0, 1.0) });
      if let Ok(service) = lock() {
        emit(app, &service, "player.level", payload.clone());
        emit(app, &service, "noise.level", payload);
      }
    }
    engine::EngineEvent::Error {
      scope,
      code,
      message,
    } => {
      crate::wallpaper::wlog(&format!("引擎错误 {scope}/{code}: {message}"));
      if let Ok(mut service) = lock() {
        service.status = "error".to_string();
        service.error = Some(json!({ "code": code, "message": message, "scope": scope }));
        touch(&mut service);
        emit_state(app, &service);
      }
    }
  }
}

async fn handle_ended(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let mode = lock().map(|service| service.player.mode.clone())?;
  if mode == "repeat-one" {
    seek(app, pool, 0)?;
    return resume(app, pool).await;
  }
  next(app, pool, 1).await
}

fn queue_add(
  app: &AppHandle,
  pool: &SqlitePool,
  track_id: &str,
  index: Option<u64>,
) -> Result<(), MediaError> {
  let mut service = lock()?;
  if service.queue.iter().any(|item| item == track_id) {
    return Ok(());
  }
  let position = index
    .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
    .unwrap_or(service.queue.len())
    .min(service.queue.len());
  service.queue.insert(position, track_id.to_string());
  touch(&mut service);
  emit_state(app, &service);
  let queue = service.queue.clone();
  save_queue(app, pool, &queue);
  Ok(())
}

fn queue_remove(app: &AppHandle, pool: &SqlitePool, track_id: &str) -> Result<(), MediaError> {
  let mut service = lock()?;
  let was_current = service.player.current_track_id.as_deref() == Some(track_id);
  service.queue.retain(|item| item != track_id);
  if was_current {
    service.player.current_track_id = None;
    service.current_track = None;
    service.status = "idle".to_string();
    service.player.position_ms = 0;
    service.current_load_id = None;
    engine::send(app, engine::player_control("player.stop"));
    save_player(app, pool, &service.player);
  }
  touch(&mut service);
  emit_state(app, &service);
  let queue = service.queue.clone();
  save_queue(app, pool, &queue);
  Ok(())
}

fn queue_clear(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let mut service = lock()?;
  service.queue.clear();
  service.player.current_track_id = None;
  service.current_track = None;
  service.status = "idle".to_string();
  service.player.position_ms = 0;
  service.current_load_id = None;
  touch(&mut service);
  emit_state(app, &service);
  engine::send(app, engine::player_control("player.stop"));
  save_queue(app, pool, &[]);
  let player = service.player.clone();
  save_player(app, pool, &player);
  Ok(())
}

fn queue_move(app: &AppHandle, pool: &SqlitePool, from: u64, to: u64) -> Result<(), MediaError> {
  let mut service = lock()?;
  let from = usize::try_from(from).unwrap_or(usize::MAX);
  let to = usize::try_from(to).unwrap_or(usize::MAX);
  if from >= service.queue.len() || to >= service.queue.len() {
    return Err(MediaError::invalid("队列索引越界"));
  }
  let item = service.queue.remove(from);
  service.queue.insert(to, item);
  touch(&mut service);
  emit_state(app, &service);
  let queue = service.queue.clone();
  save_queue(app, pool, &queue);
  Ok(())
}

async fn queue_play_at(app: &AppHandle, pool: &SqlitePool, index: u64) -> Result<(), MediaError> {
  let track_id = {
    let service = lock()?;
    let index = usize::try_from(index).unwrap_or(usize::MAX);
    service
      .queue
      .get(index)
      .cloned()
      .ok_or_else(|| MediaError::invalid("队列索引越界"))?
  };
  play(app, pool, Some(track_id)).await
}

fn noise_activate(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let noise = {
    let mut service = lock()?;
    service.noise.active = true;
    touch(&mut service);
    emit_noise(app, &service);
    service.noise.clone()
  };
  engine::ensure_window(app);
  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  save_noise(app, pool, &noise);
  Ok(())
}

fn noise_set_layer(
  app: &AppHandle,
  pool: &SqlitePool,
  sound_id: &str,
  enabled: Option<bool>,
  volume: Option<f64>,
) -> Result<(), MediaError> {
  let noise = {
    let mut service = lock()?;
    let layer = service
      .noise
      .layers
      .iter_mut()
      .find(|layer| layer.sound_id == sound_id)
      .ok_or_else(|| MediaError::invalid("未知的噪声声景"))?;
    if let Some(enabled) = enabled {
      layer.enabled = enabled;
    }
    if let Some(volume) = volume {
      layer.volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
      } else {
        0.0
      };
    }
    touch(&mut service);
    emit_noise(app, &service);
    service.noise.clone()
  };
  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  save_noise(app, pool, &noise);
  Ok(())
}

fn noise_set_master(app: &AppHandle, pool: &SqlitePool, volume: f64) -> Result<(), MediaError> {
  let noise = {
    let mut service = lock()?;
    service.noise.master = if volume.is_finite() {
      volume.clamp(0.0, 1.0)
    } else {
      0.0
    };
    touch(&mut service);
    emit_noise(app, &service);
    service.noise.clone()
  };
  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  save_noise(app, pool, &noise);
  Ok(())
}

fn noise_set_muted(app: &AppHandle, pool: &SqlitePool, muted: bool) -> Result<(), MediaError> {
  let noise = {
    let mut service = lock()?;
    service.noise.muted = muted;
    touch(&mut service);
    emit_noise(app, &service);
    service.noise.clone()
  };
  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  save_noise(app, pool, &noise);
  Ok(())
}

fn noise_set_sleep(app: &AppHandle, pool: &SqlitePool, minutes: i64) -> Result<(), MediaError> {
  let minutes = minutes.clamp(0, 180);
  let (noise, generation) = {
    let mut service = lock()?;
    service.sleep_generation = service.sleep_generation.saturating_add(1);
    let generation = service.sleep_generation;
    service.noise.sleep_minutes = minutes;
    service.noise.sleep_ends_at = if minutes > 0 {
      Some(now_ms() + minutes * 60_000)
    } else {
      None
    };
    touch(&mut service);
    emit_noise(app, &service);
    (service.noise.clone(), generation)
  };
  save_noise(app, pool, &noise);
  if minutes > 0 {
    let app = app.clone();
    let pool = pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
      std::thread::sleep(Duration::from_secs(
        u64::try_from(minutes * 60).unwrap_or(u64::MAX),
      ));
      let fired = {
        let mut service = match lock() {
          Ok(service) => service,
          Err(_) => return,
        };
        if service.sleep_generation != generation {
          false
        } else {
          service.noise.muted = true;
          service.noise.sleep_minutes = 0;
          service.noise.sleep_ends_at = None;
          touch(&mut service);
          emit_noise(&app, &service);
          true
        }
      };
      if fired {
        let noise = lock()
          .map(|service| service.noise.clone())
          .unwrap_or_default();
        save_noise(&app, &pool, &noise);
        engine::send(
          &app,
          engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
        );
      }
    });
  }
  Ok(())
}

fn noise_reset(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let noise = {
    let mut service = lock()?;
    service.noise.layers = default_layers();
    service.noise.master = 0.75;
    service.noise.muted = false;
    service.noise.sleep_minutes = 0;
    service.noise.sleep_ends_at = None;
    service.sleep_generation = service.sleep_generation.saturating_add(1);
    touch(&mut service);
    emit_noise(app, &service);
    service.noise.clone()
  };
  engine::send(
    app,
    engine::noise_sync(noise.active, noise.master, noise.muted, &noise.layers),
  );
  save_noise(app, pool, &noise);
  Ok(())
}

/// 引擎命令入口：校验调用窗口后转发事件。
pub fn handle_engine_event(
  window: &WebviewWindow,
  event: engine::EngineEvent,
) -> Result<(), MediaError> {
  if window.label() != ENGINE_LABEL {
    return Err(MediaError::new(
      "capability.denied",
      "只有媒体引擎窗口可以上报引擎事件",
    ));
  }
  on_engine_event(&window.app_handle().clone(), event);
  Ok(())
}
