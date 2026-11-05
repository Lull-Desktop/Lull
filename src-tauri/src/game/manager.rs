//! 全局 Game Manager：实例表、参与者表、命令去重/等待、事件分发与 ticker。
//!
//! 只在这里持有全局可变状态；窗口/磁盘细节在 `authority` 与 `repository`。
//! 读锁时间尽量短：需要写盘或发事件时先在锁内取数据，再在锁外执行。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::error::{codes, GameErrorBody};
use super::instance::{now_ms, GameInstance, InstanceStatus};
use super::permissions;
use super::protocol::{
  GameCommandResult, GameEvent, GameLifecycle, GameRenderContext, GameRenderState, GameSnapshot,
  GameTick,
};
use super::repository;
use super::{authority, lifecycle};

pub const EVENT_SNAPSHOT: &str = "game:snapshot";
pub const EVENT_GAME_EVENT: &str = "game:event";
pub const EVENT_RENDER: &str = "game:render";
pub const EVENT_LIFECYCLE: &str = "game:lifecycle";
pub const EVENT_COMMAND: &str = "game:command";
pub const EVENT_COMMAND_RESULT: &str = "game:command-result";
pub const EVENT_TICK: &str = "game:tick";
pub const EVENT_GAMES_CHANGED: &str = "games-changed";

const COMMAND_RECORD_CAP: usize = 256;
const COMMAND_RECORD_TTL_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone)]
#[allow(dead_code)] // 渲染几何/设备等字段在 P2 多屏分发时读取。
pub struct ReplicaEntry {
  pub replica_id: String,
  pub game_id: String,
  pub instance_id: String,
  pub window_label: String,
  pub display_device: String,
  pub mode: String,
  pub render: GameRenderContext,
  pub connected_at_ms: u64,
  pub ready: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // instance_id/connected_at_ms 留给 P2 诊断。
pub struct ControllerEntry {
  pub game_id: String,
  pub instance_id: Option<String>,
  pub window_label: String,
  pub connected_at_ms: u64,
}

pub struct PendingCommand {
  pub game_id: String,
  pub sender_label: String,
  pub sender: Sender<GameCommandResult>,
}

#[derive(Debug, Clone)]
pub struct CommandRecord {
  pub game_id: String,
  pub request_id: String,
  pub result: GameCommandResult,
  pub at_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct Bucket {
  pub tokens: f64,
  pub last_ms: u64,
}

impl Bucket {
  #[must_use]
  pub fn check(&mut self, capacity: f64, refill_per_second: f64, now: u64) -> bool {
    let elapsed = now.saturating_sub(self.last_ms) as f64 / 1_000.0;
    self.tokens = (self.tokens + elapsed * refill_per_second).min(capacity);
    self.last_ms = now;
    if self.tokens >= 1.0 {
      self.tokens -= 1.0;
      true
    } else {
      false
    }
  }
}

#[derive(Default)]
pub struct GameManager {
  pub instances: BTreeMap<String, GameInstance>,
  pub replicas: BTreeMap<String, ReplicaEntry>,
  pub controllers: BTreeMap<String, ControllerEntry>,
  pub pending: HashMap<String, PendingCommand>,
  pub records: VecDeque<CommandRecord>,
  pub buckets: HashMap<String, Bucket>,
}

static MANAGER: OnceLock<Mutex<GameManager>> = OnceLock::new();
static TICKER_STARTED: AtomicBool = AtomicBool::new(false);
static TICKER_RUNNING: AtomicBool = AtomicBool::new(true);

pub fn manager() -> MutexGuard<'static, GameManager> {
  MANAGER
    .get_or_init(|| Mutex::new(GameManager::default()))
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
}

/// 存活的实例数（含启动/停止过程中）。
#[must_use]
pub fn active_instance_count(manager: &GameManager) -> usize {
  manager
    .instances
    .values()
    .filter(|instance| instance.status.is_active())
    .count()
}

#[must_use]
pub fn game_for_instance(manager: &GameManager, instance_id: &str) -> Option<String> {
  manager
    .instances
    .iter()
    .find(|(_, instance)| instance.instance_id == instance_id)
    .map(|(game_id, _)| game_id.clone())
}

#[must_use]
pub fn replica_labels(manager: &GameManager, game_id: &str) -> Vec<String> {
  manager
    .replicas
    .values()
    .filter(|replica| replica.game_id == game_id)
    .map(|replica| replica.window_label.clone())
    .collect()
}

#[must_use]
pub fn controller_labels(manager: &GameManager, game_id: &str) -> Vec<String> {
  manager
    .controllers
    .values()
    .filter(|controller| controller.game_id == game_id)
    .map(|controller| controller.window_label.clone())
    .collect()
}

#[must_use]
pub fn counts(manager: &GameManager, game_id: &str) -> (usize, usize) {
  (
    replica_labels(manager, game_id).len(),
    controller_labels(manager, game_id).len(),
  )
}

fn emit<T: Serialize + Clone>(app: &AppHandle, label: &str, event: &str, payload: T) {
  let _ = app.emit_to(label, event, payload);
}

pub fn emit_games_changed(app: &AppHandle) {
  let _ = app.emit(EVENT_GAMES_CHANGED, ());
}

pub fn emit_snapshot(app: &AppHandle, snapshot: &GameSnapshot) {
  let labels = {
    let manager = manager();
    let mut labels = replica_labels(&manager, &snapshot.game_id);
    labels.extend(controller_labels(&manager, &snapshot.game_id));
    labels
  };
  for label in labels {
    emit(app, &label, EVENT_SNAPSHOT, snapshot.clone());
  }
}

pub fn emit_events(app: &AppHandle, game_id: &str, events: &[GameEvent]) {
  if events.is_empty() {
    return;
  }
  let labels = {
    let manager = manager();
    let mut labels = replica_labels(&manager, game_id);
    labels.extend(controller_labels(&manager, game_id));
    labels
  };
  for label in labels {
    for event in events {
      emit(app, &label, EVENT_GAME_EVENT, event.clone());
    }
  }
}

pub fn emit_render(app: &AppHandle, game_id: &str, render: &GameRenderState) {
  let labels = {
    let manager = manager();
    replica_labels(&manager, game_id)
  };
  for label in labels {
    emit(app, &label, EVENT_RENDER, render.clone());
  }
}

pub fn emit_lifecycle(app: &AppHandle, lifecycle: &GameLifecycle) {
  let labels = {
    let manager = manager();
    let mut labels = Vec::new();
    if let Some(instance) = manager.instances.get(&lifecycle.game_id) {
      labels.push(authority::label_for(&instance.instance_id));
    }
    labels.extend(replica_labels(&manager, &lifecycle.game_id));
    labels.extend(controller_labels(&manager, &lifecycle.game_id));
    labels
  };
  for label in labels {
    emit(app, &label, EVENT_LIFECYCLE, lifecycle.clone());
  }
}

pub fn emit_to_authority<T: Serialize + Clone>(
  app: &AppHandle,
  instance_id: &str,
  event: &str,
  payload: T,
) {
  emit(app, &authority::label_for(instance_id), event, payload);
}

pub fn emit_command_result(app: &AppHandle, label: &str, result: &GameCommandResult) {
  emit(app, label, EVENT_COMMAND_RESULT, result.clone());
}

/// 命令去重：命中时返回带 `deduplicated` 的已记录结果。
#[must_use]
pub fn recorded_command(
  manager: &GameManager,
  game_id: &str,
  request_id: &str,
  now: u64,
) -> Option<GameCommandResult> {
  manager
    .records
    .iter()
    .find(|record| {
      record.game_id == game_id
        && record.request_id == request_id
        && now.saturating_sub(record.at_ms) <= COMMAND_RECORD_TTL_MS
    })
    .map(|record| {
      let mut result = record.result.clone();
      result.deduplicated = true;
      result
    })
}

pub fn remember_command(
  manager: &mut GameManager,
  game_id: &str,
  request_id: &str,
  result: &GameCommandResult,
  now: u64,
) {
  manager.records.retain(|record| {
    let fresh = now.saturating_sub(record.at_ms) <= COMMAND_RECORD_TTL_MS;
    let same = record.game_id == game_id && record.request_id == request_id;
    fresh && !same
  });
  manager.records.push_back(CommandRecord {
    game_id: game_id.to_string(),
    request_id: request_id.to_string(),
    result: result.clone(),
    at_ms: now,
  });
  while manager.records.len() > COMMAND_RECORD_CAP {
    manager.records.pop_front();
  }
}

/// 控制器命令限流：8/s，burst 16（按窗口 label 分桶）。
pub fn allow_command(manager: &mut GameManager, label: &str, now: u64) -> bool {
  let bucket = manager.buckets.entry(label.to_string()).or_insert(Bucket {
    tokens: 16.0,
    last_ms: now,
  });
  bucket.check(16.0, 8.0, now)
}

/// 全局 ticker：host-tick 下发、合并落盘、租约过期检测。
pub fn spawn_ticker(app: AppHandle) {
  if TICKER_STARTED.swap(true, Ordering::SeqCst) {
    return;
  }
  thread::spawn(move || {
    while TICKER_RUNNING.load(Ordering::SeqCst) {
      thread::sleep(Duration::from_millis(100));
      tick_once(&app);
    }
  });
}

fn tick_once(app: &AppHandle) {
  let mut ticks: Vec<(String, GameTick)> = Vec::new();
  let mut lifecycles: Vec<GameLifecycle> = Vec::new();
  {
    let mut manager = manager();
    let now = now_ms();
    let mut participants: std::collections::BTreeMap<String, usize> =
      std::collections::BTreeMap::new();
    for replica in manager.replicas.values() {
      *participants.entry(replica.game_id.clone()).or_default() += 1;
    }
    for controller in manager.controllers.values() {
      *participants.entry(controller.game_id.clone()).or_default() += 1;
    }
    for (game_id, instance) in manager.instances.iter_mut() {
      if instance.lease.is_expired(now) && instance.status.can_tick() {
        instance.status = InstanceStatus::Failed;
        instance.set_error(GameErrorBody {
          code: codes::AUTHORITY_LEASE_EXPIRED.to_string(),
          message: "Authority 心跳超时".to_string(),
          detail: None,
        });
        lifecycles.push(instance.failed_lifecycle("authority.lease_expired"));
        continue;
      }
      // hidden：曾经有副本/控制器，现在全部离开；暂停 tick（用户显式后台运行除外）。
      let attached = participants.get(game_id).copied().unwrap_or(0);
      if instance.status == InstanceStatus::Running && instance.had_participants && attached == 0 {
        instance.enter_hidden(now);
        instance.dirty = true;
        let _ = repository::save(app, instance, false);
        lifecycles.push(instance.lifecycle("suspended", Some("hidden"), None));
      }
      if instance.status.can_tick() && instance.spec.authority_mode == "host-tick" {
        let interval = instance.spec.limits.tick_ms.max(200);
        if instance.last_tick_ms == 0 || now.saturating_sub(instance.last_tick_ms) >= interval {
          let delta = if instance.last_tick_ms == 0 {
            0
          } else {
            now.saturating_sub(instance.last_tick_ms)
          };
          instance.last_tick_ms = now;
          ticks.push((
            authority::label_for(&instance.instance_id),
            GameTick {
              simulation_time_ms: instance.simulation_time_ms,
              delta_ms: delta,
              wall_clock_ms: now,
            },
          ));
        }
      }
      if instance.dirty && now.saturating_sub(instance.last_flush_ms) >= instance.spec.flush_ms {
        if let Err(error) = repository::save(app, instance, false) {
          let body = error.body();
          instance.set_error(body);
          instance.status = InstanceStatus::Failed;
          lifecycles.push(instance.failed_lifecycle("io.error"));
        }
      }
    }
  }
  for (label, tick) in ticks {
    emit(app, &label, EVENT_TICK, tick);
  }
  for lifecycle in lifecycles {
    emit_lifecycle(app, &lifecycle);
    emit_games_changed(app);
  }
}

/// 窗口销毁：移除参与者；权威窗销毁触发停止收尾或 failover。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
  permissions::revoke_window_token(label);
  let mut failover_game: Option<String> = None;
  let mut failures: Vec<GameLifecycle> = Vec::new();
  {
    let mut manager = manager();
    manager.replicas.remove(label);
    manager.controllers.remove(label);
    let authority_instance = permissions::authority_instance_id(label).map(str::to_string);
    if let Some(instance_id) = authority_instance {
      let game_id = game_for_instance(&manager, &instance_id);
      if let Some(game_id) = game_id {
        if let Some(instance) = manager.instances.get_mut(&game_id) {
          if instance.status == InstanceStatus::Stopping {
            instance.authority_detached = true;
          } else if instance.status.is_active() {
            if instance.retries >= 2 {
              instance.status = InstanceStatus::Failed;
              instance.set_error(GameErrorBody {
                code: codes::AUTHORITY_NOT_READY.to_string(),
                message: "Authority 连续崩溃，已停止重试".to_string(),
                detail: None,
              });
              failures.push(instance.failed_lifecycle("authority.crash"));
            } else {
              instance.retries += 1;
              instance.status = InstanceStatus::Starting;
              instance.authority_detached = false;
              failover_game = Some(game_id);
            }
          }
        }
      }
    }
  }
  for failure in failures {
    emit_lifecycle(app, &failure);
    emit_games_changed(app);
  }
  if let Some(game_id) = failover_game {
    let app = app.clone();
    thread::spawn(move || lifecycle::failover(&app, &game_id));
  }
}

/// 应用退出：尽量把所有脏状态落盘（有界，不阻塞退出太久）。
pub fn shutdown(app: &AppHandle) {
  TICKER_RUNNING.store(false, Ordering::SeqCst);
  let mut manager = manager();
  let now = now_ms();
  for instance in manager.instances.values_mut() {
    instance.status = InstanceStatus::Stopped;
    instance.updated_at_ms = now;
    let _ = repository::save(app, instance, true);
  }
}

/// 供命令层使用：实例视图（找不到时返回 None）。
#[must_use]
pub fn instance_view(
  manager: &GameManager,
  game_id: &str,
) -> Option<super::protocol::GameInstanceView> {
  manager.instances.get(game_id).map(|instance| {
    let (replicas, controllers) = counts(manager, game_id);
    instance.view(replicas, controllers)
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn result(request_id: &str) -> GameCommandResult {
    GameCommandResult {
      request_id: request_id.to_string(),
      ok: true,
      result: Some(json!({ "accepted": true })),
      error: None,
      revision: Some(3),
      deduplicated: false,
    }
  }

  #[test]
  fn command_bucket_allows_burst_then_limits() {
    let mut manager = GameManager::default();
    for _ in 0..16 {
      assert!(allow_command(&mut manager, "widget-test", 1_000));
    }
    assert!(!allow_command(&mut manager, "widget-test", 1_000));
    // 1s 后补回 8 个令牌。
    assert!(allow_command(&mut manager, "widget-test", 2_000));
  }

  #[test]
  fn completed_command_is_replayed_with_dedup_flag() {
    let mut manager = GameManager::default();
    remember_command(&mut manager, "demo.game", "req-1", &result("req-1"), 1_000);
    let replayed = recorded_command(&manager, "demo.game", "req-1", 1_500).expect("dedupe hit");
    assert!(replayed.deduplicated);
    assert_eq!(replayed.revision, Some(3));
    // 不同 requestId 不命中。
    assert!(recorded_command(&manager, "demo.game", "req-2", 1_500).is_none());
    // TTL 过期后不再返回。
    assert!(recorded_command(
      &manager,
      "demo.game",
      "req-1",
      1_000 + COMMAND_RECORD_TTL_MS + 1
    )
    .is_none());
  }
}
