//! 全局输出音量与静音（Master Output Volume）。
//!
//! 这是 Lull 所有音频（Music + Noise）在进入设备之前的最后一级增益；与 Windows
//! 系统音量、Music Volume、Noise Master Volume 相互独立。N1 先做最小实现：
//! 持久化到 `media_output`，变化时同步引擎并广播 `output.changed`。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::AppHandle;

use super::api::errors::MediaError;
use super::engine;
use super::events;
use super::repository::now_ms;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputView {
  pub volume: f64,
  pub muted: bool,
}

#[derive(Debug, Clone, Copy)]
struct OutputState {
  volume: f64,
  muted: bool,
}

impl Default for OutputState {
  fn default() -> Self {
    Self {
      volume: 1.0,
      muted: false,
    }
  }
}

static STATE: OnceLock<Mutex<OutputState>> = OnceLock::new();
static REVISION: AtomicU64 = AtomicU64::new(0);

fn state() -> &'static Mutex<OutputState> {
  STATE.get_or_init(|| Mutex::new(OutputState::default()))
}

fn lock() -> MutexGuard<'static, OutputState> {
  state().lock().unwrap_or_else(PoisonError::into_inner)
}

fn clamp_volume(value: f64) -> f64 {
  if value.is_finite() {
    value.clamp(0.0, 1.0)
  } else {
    0.0
  }
}

#[must_use]
pub fn view() -> OutputView {
  let current = *lock();
  OutputView {
    volume: current.volume,
    muted: current.muted,
  }
}

#[must_use]
pub fn revision() -> u64 {
  REVISION.load(Ordering::SeqCst)
}

/// 初始化：读取持久化值；没有行时写入默认值。
pub async fn init(pool: &SqlitePool) -> Result<(), MediaError> {
  let row: Option<(f64, i64)> =
    sqlx::query_as("SELECT volume, muted FROM media_output WHERE id = 1")
      .fetch_optional(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取输出音量失败：{error}")))?;

  let current = row.map_or_else(OutputState::default, |(volume, muted)| OutputState {
    volume: clamp_volume(volume),
    muted: muted != 0,
  });
  *lock() = current;

  if row.is_none() {
    sqlx::query(
      "INSERT INTO media_output (id, volume, muted, updated_at) VALUES (1, ?, ?, ?) \
       ON CONFLICT(id) DO NOTHING",
    )
    .bind(current.volume)
    .bind(if current.muted { 1_i64 } else { 0_i64 })
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("写入默认输出音量失败：{error}")))?;
  }
  Ok(())
}

/// 修改全局输出音量/静音；返回最新值。变化会写盘、同步引擎并广播。
pub async fn set(
  app: &AppHandle,
  pool: &SqlitePool,
  volume: Option<f64>,
  muted: Option<bool>,
) -> Result<OutputView, MediaError> {
  let (next, revision) = {
    let mut current = lock();
    if let Some(volume) = volume {
      current.volume = clamp_volume(volume);
    }
    if let Some(muted) = muted {
      current.muted = muted;
    }
    let next = *current;
    let revision = REVISION.fetch_add(1, Ordering::SeqCst) + 1;
    (next, revision)
  };

  let view = OutputView {
    volume: next.volume,
    muted: next.muted,
  };
  engine::send(app, engine::output_volume(view.volume, view.muted));
  events::emit(
    app,
    "output.changed",
    revision,
    serde_json::to_value(view).unwrap_or(serde_json::Value::Null),
  );

  let pool = pool.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = save(&pool, next).await {
      crate::wallpaper::wlog(&format!("保存输出音量失败：{error}"));
    }
  });
  Ok(view)
}

/// 引擎 ready 后重新下发当前输出音量。
pub fn sync(app: &AppHandle) {
  let view = view();
  engine::send(app, engine::output_volume(view.volume, view.muted));
}

/// 退出前同步落盘，避免“刚拖完音量就退出”丢失最后一次修改。
pub async fn persist(pool: &SqlitePool) -> Result<(), MediaError> {
  let state = *lock();
  save(pool, state).await
}

async fn save(pool: &SqlitePool, state: OutputState) -> Result<(), MediaError> {
  sqlx::query(
    "INSERT INTO media_output (id, volume, muted, updated_at) VALUES (1, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       volume = excluded.volume, muted = excluded.muted, updated_at = excluded.updated_at",
  )
  .bind(state.volume)
  .bind(if state.muted { 1_i64 } else { 0_i64 })
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存输出音量失败：{error}")))?;
  Ok(())
}
