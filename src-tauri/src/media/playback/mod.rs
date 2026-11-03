//! 音乐播放服务：全局播放器、队列与隐藏音频引擎。
//!
//! 状态由 Rust 持有；引擎只负责发声。播放进度高频更新只存在内存与事件里，
//! 暂停/停止/切歌/音量/队列写入 SQLite。Noise 业务在 `media::noise`。

pub mod model;
pub mod smart;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, WebviewWindow};

use self::model::{PlayerStateView, QueueStateView};
use self::smart::{RecentPlay, RoundState, SmartRng, Source, TrackFeatures};
use super::api::dto::TrackSummary;
use super::api::errors::MediaError;
use super::engine;
use super::repository::{history, now_ms, tracks};

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

struct Service {
  player: PlayerData,
  current_track: Option<TrackSummary>,
  status: String,
  duration_ms: Option<i64>,
  error: Option<Value>,
  queue: Vec<String>,
  /// 当前 UI 页签的曲目顺序；自然播完时优先按它选下一首。
  advance_list: Option<Vec<String>>,
  /// `shuffle` 模式的轮次袋与随机源；其他模式保持为空/未使用。
  round: Option<RoundState>,
  rng: SmartRng,
  revision: u64,
  engine_ready: bool,
  syncing: bool,
  sync_pending: bool,
  load_seq: u64,
  current_load_id: Option<String>,
}

static SERVICE: OnceLock<Mutex<Service>> = OnceLock::new();
/// 智能随机选曲串行化：避免连点下一首或「播完 + 手动」并发选中同一首。
static SELECT_LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();

fn select_lock() -> &'static tauri::async_runtime::Mutex<()> {
  SELECT_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

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

/// 一次加锁取出 Player/Queue 视图，避免快照内部出现跨 revision 的撕裂。
pub(crate) fn snapshot_parts() -> Result<(PlayerStateView, QueueStateView), MediaError> {
  let service = lock()?;
  Ok((player_view(&service), queue_view(&service)))
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

/// 资料库初始化完成后加载播放状态；引擎窗口仍按需创建。
pub async fn init(pool: &SqlitePool) -> Result<(), MediaError> {
  if SERVICE.get().is_some() {
    return Ok(());
  }
  let (mut player, queue) = store::load(pool).await?;
  // 旧播放器把“静音”写成 volume=0 且 muted=false；这种状态重启后无法出声。
  // 新 UI 只用 muted 表达静音，这里把历史坏状态修回默认音量（muted 保持原值）。
  if player.volume <= f64::EPSILON && !player.muted {
    player.volume = PlayerData::default().volume;
    let _ = store::save_player(pool, &player).await;
  }
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
    advance_list: None,
    round: None,
    rng: SmartRng::seeded(u64::try_from(now_ms()).unwrap_or(0)),
    revision: 0,
    engine_ready: false,
    syncing: false,
    sync_pending: false,
    load_seq: 0,
    current_load_id: None,
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
  let (player, queue) = match lock() {
    Ok(service) => (service.player.clone(), service.queue.clone()),
    Err(_) => return,
  };
  if let Ok(pool) = super::library::pool() {
    let pool = pool.clone();
    // 退出事件里 spawn 的任务可能来不及跑完；这里同步等一次小写入。
    let _ = tauri::async_runtime::block_on(async {
      store::save_player(&pool, &player).await?;
      store::save_queue(&pool, &queue).await
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
    ("player", "setAdvanceList") => {
      let ids = args
        .get("trackIds")
        .and_then(Value::as_array)
        .ok_or_else(|| MediaError::invalid("缺少 trackIds"))?;
      let mut track_ids = Vec::with_capacity(ids.len());
      for id in ids {
        if let Some(id) = id.as_str() {
          track_ids.push(id.to_string());
        }
      }
      let mut service = lock()?;
      let empty = track_ids.is_empty();
      service.advance_list = if empty { None } else { Some(track_ids) };
      if empty {
        service.round = None;
      }
      Ok(Value::Null)
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
  super::library::record_history(app, &id, track.duration_ms).await;
  let player = {
    let mut service = lock()?;
    service.player.current_track_id = Some(id.clone());
    service.player.position_ms = 0;
    service.current_track = Some(TrackSummary::from(track));
    service.duration_ms = service
      .current_track
      .as_ref()
      .and_then(|track| track.duration_ms);
    service.status = "loading".to_string();
    service.error = None;
    // 手动点播同样消耗本轮名额，避免下一轮之前又被随机选中。
    if let Some(round) = service.round.as_mut() {
      round.mark_played(&id);
    }
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
    // 轮次只在随机模式内有意义；切出时丢弃，切回时从新一轮开始。
    if mode != model::PlayMode::Shuffle {
      service.round = None;
    }
    touch(&mut service);
    emit_state(app, &service);
    service.player.clone()
  };
  save_player(app, pool, &player);
  Ok(())
}

async fn next(app: &AppHandle, pool: &SqlitePool, direction: i32) -> Result<(), MediaError> {
  let shuffle = {
    let service = lock()?;
    service.player.mode == "shuffle"
  };
  if shuffle {
    return advance_shuffle_or_queue(app, pool, direction).await;
  }
  next_from_queue(app, pool, direction).await
}

/// 智能随机选曲失败时回退队列顺序播放，避免播完或点下一首直接停住。
async fn advance_shuffle_or_queue(
  app: &AppHandle,
  pool: &SqlitePool,
  direction: i32,
) -> Result<(), MediaError> {
  match advance_shuffle(app, pool).await {
    Ok(()) => Ok(()),
    Err(error) => {
      crate::wallpaper::wlog(&format!("智能随机选曲失败，回退队列：{error}"));
      next_from_queue(app, pool, direction).await
    }
  }
}

/// 队列顺序播放（原 `next` 逻辑）；shuffle 兜底与其他模式共用。
async fn next_from_queue(
  app: &AppHandle,
  pool: &SqlitePool,
  direction: i32,
) -> Result<(), MediaError> {
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
      let index = match current {
        Some(index) => {
          if direction > 0 {
            (index + 1) % len
          } else {
            (index + len - 1) % len
          }
        }
        None => 0,
      };
      service.queue[index].clone()
    }
  };
  play(app, pool, Some(target)).await
}

fn feature_map(rows: Vec<tracks::FeatureRow>) -> HashMap<String, TrackFeatures> {
  rows
    .into_iter()
    .map(|row| {
      let artists = row
        .artist_ids
        .as_deref()
        .map(|value| {
          value
            .split('\u{1f}')
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect()
        })
        .unwrap_or_default();
      let genre = row
        .genre
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
      (
        row.id,
        TrackFeatures {
          artists,
          album: row.album_id,
          genre,
          favorite: row.favorite != 0,
        },
      )
    })
    .collect()
}

fn retryable(error: &MediaError) -> bool {
  matches!(error.code, "track.not-found" | "track.unavailable")
}

/// `shuffle` 模式的选曲入口：自然播完与手动上/下一首都走这里。
///
/// 候选来自播放器同步的当前页签列表，缺失时回退用户队列；优先查播放历史
/// 与曲目特征，再按权重抽一首。选曲与 `play` 全程串行化，保证轮次袋一致。
async fn advance_shuffle(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let _guard = select_lock().lock().await;
  let mut excluded: HashSet<String> = HashSet::new();
  let mut last_error: Option<MediaError> = None;

  for _ in 0..3 {
    let (ids, source, current) = {
      let service = lock()?;
      let (ids, source) = match service
        .advance_list
        .as_ref()
        .filter(|list| !list.is_empty())
      {
        Some(list) => (list.clone(), Source::Advance),
        None => (service.queue.clone(), Source::Queue),
      };
      (ids, source, service.player.current_track_id.clone())
    };
    if ids.is_empty() {
      return Err(MediaError::new("queue.empty", "播放队列为空"));
    }
    let candidates: Vec<String> = ids
      .into_iter()
      .filter(|id| !excluded.contains(id))
      .collect();
    if candidates.is_empty() {
      return Err(MediaError::new("track.unavailable", "没有可播放的曲目"));
    }

    let recent_ids = history::recent_ids(
      pool,
      now_ms() - smart::RECENT_WINDOW_MS,
      smart::RECENT_LIMIT,
    )
    .await
    .unwrap_or_else(|error| {
      crate::wallpaper::wlog(&format!("读取最近播放失败，忽略降权：{error}"));
      Vec::new()
    });
    let mut feature_ids = candidates.clone();
    feature_ids.extend(recent_ids.iter().cloned());
    feature_ids.sort_unstable();
    feature_ids.dedup();
    let (features, features_loaded) = match tracks::features_for(pool, &feature_ids).await {
      Ok(rows) => (feature_map(rows), true),
      Err(error) => {
        crate::wallpaper::wlog(&format!("读取选曲特征失败，按中性权重继续：{error}"));
        (HashMap::new(), false)
      }
    };

    let target = {
      let mut service = lock()?;
      if service.player.mode != "shuffle" {
        return Err(MediaError::new("mode.changed", "播放模式已切换"));
      }
      let service = &mut *service;
      let playable: Vec<String> = if features_loaded {
        candidates
          .into_iter()
          .filter(|id| features.contains_key(id))
          .collect()
      } else {
        candidates
      };
      if playable.is_empty() {
        return Err(MediaError::new("track.unavailable", "没有可播放的曲目"));
      }
      let recent: Vec<RecentPlay> = recent_ids
        .iter()
        .map(|id| RecentPlay {
          id: id.clone(),
          features: features.get(id).cloned(),
        })
        .collect();
      let round = service.round.get_or_insert_with(RoundState::new);
      round.reconcile(source, &playable, current.as_deref());
      smart::pick(&playable, &features, &recent, round, &mut service.rng)
    };

    let Some(target) = target else {
      return Err(MediaError::new("track.unavailable", "没有可播放的曲目"));
    };
    match play(app, pool, Some(target.clone())).await {
      Ok(()) => return Ok(()),
      Err(error) if retryable(&error) => {
        crate::wallpaper::wlog(&format!("曲目不可播放，重试下一首：{error}"));
        excluded.insert(target.clone());
        if let Ok(mut service) = lock() {
          if let Some(round) = service.round.as_mut() {
            round.exclude(&target);
          }
        }
        last_error = Some(error);
      }
      Err(error) => return Err(error),
    }
  }

  Err(last_error.unwrap_or_else(|| MediaError::new("track.unavailable", "没有可播放的曲目")))
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
  let (ready, track_id, position, status, volume, muted) = {
    let service = lock()?;
    (
      service.engine_ready,
      service.player.current_track_id.clone(),
      service.player.position_ms,
      service.status.clone(),
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
  let summary = TrackSummary::from(row);
  let path = tracks::playable_path(pool, track_id).await?;
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
  Ok((summary, json!({ "kind": "asset", "url": url })))
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
          if let Err(error) = handle_ended(&app, &pool).await {
            crate::wallpaper::wlog(&format!("自动续播失败：{error}"));
          }
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

fn choose_advance_target(list: &[String], current: Option<&str>) -> Option<String> {
  if list.is_empty() {
    return None;
  }
  let index = current
    .and_then(|id| list.iter().position(|item| item == id))
    .map_or(0, |index| (index + 1) % list.len());
  list.get(index).cloned()
}

async fn handle_ended(app: &AppHandle, pool: &SqlitePool) -> Result<(), MediaError> {
  let (mode, advance_list, current) = {
    let service = lock()?;
    (
      service.player.mode.clone(),
      service.advance_list.clone(),
      service.player.current_track_id.clone(),
    )
  };
  if mode == "repeat-one" {
    seek(app, pool, 0)?;
    return resume(app, pool).await;
  }
  if mode == "shuffle" {
    return advance_shuffle_or_queue(app, pool, 1).await;
  }
  // UI 已把当前页签的列表同步过来时，自然播完按该列表顺序选下一首。
  if let Some(list) = advance_list {
    if let Some(target) = choose_advance_target(&list, current.as_deref()) {
      if play(app, pool, Some(target)).await.is_ok() {
        return Ok(());
      }
      // 列表里的曲目失效时回退到宿主队列，避免播完直接停住。
    }
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

#[cfg(test)]
mod tests {
  use super::{choose_advance_target, feature_map};

  fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
  }

  #[test]
  fn advance_target_follows_sequence_and_wraps() {
    let list = ids(&["a", "b", "c"]);
    assert_eq!(
      choose_advance_target(&list, Some("a")).as_deref(),
      Some("b")
    );
    assert_eq!(
      choose_advance_target(&list, Some("c")).as_deref(),
      Some("a")
    );
    assert_eq!(
      choose_advance_target(&list, Some("missing")).as_deref(),
      Some("a")
    );
  }

  #[test]
  fn advance_target_handles_single_and_empty() {
    assert_eq!(
      choose_advance_target(&ids(&["only"]), Some("only")).as_deref(),
      Some("only")
    );
    assert_eq!(choose_advance_target(&[], Some("a")), None);
  }

  #[test]
  fn feature_map_splits_artist_ids_and_normalizes_genre() {
    let rows = vec![crate::media::repository::tracks::FeatureRow {
      id: "trk_1".to_string(),
      genre: Some("  Ambient ".to_string()),
      album_id: Some("alb_1".to_string()),
      artist_ids: Some("art_1\u{1f}art_2".to_string()),
      favorite: 1,
    }];
    let features = feature_map(rows);
    let track = features.get("trk_1").expect("features");
    assert_eq!(track.artists, vec!["art_1", "art_2"]);
    assert_eq!(track.album.as_deref(), Some("alb_1"));
    assert_eq!(track.genre.as_deref(), Some("ambient"));
    assert!(track.favorite);
  }
}
