//! 实例生命周期编排：启动、停止、立即保存、崩溃恢复（failover）。
//!
//! 启动/停止都会阻塞等待 Authority ready 或收尾；调用方在 blocking 线程里跑。
//! 状态机规则在 `instance`，提交规则在 `state`，窗口与磁盘分别在 `authority`/`repository`。

use std::collections::{BTreeMap, BTreeSet};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::AppHandle;

use super::authority;
use super::config;
use super::error::{codes, GameError, GameResult};
use super::instance::{new_instance_id, now_ms, GameInstance, InstanceSpec, InstanceStatus};
use super::lease::AuthorityLease;
use super::manager::{self, active_instance_count, counts, manager};
use super::protocol::{
  GameInstanceView, GameLimits, MAX_EVENTS_PER_COMMIT, MAX_EVENT_BYTES, MAX_RENDER_STATE_BYTES,
};
use super::repository;
use crate::game_package::manifest::GameManifest;
use crate::game_package::store;

const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_millis(2000);

fn spec_from_manifest(manifest: &GameManifest) -> InstanceSpec {
  InstanceSpec {
    limits: GameLimits {
      max_state_bytes: manifest.max_state_bytes(),
      max_event_bytes: MAX_EVENT_BYTES,
      max_events_per_commit: MAX_EVENTS_PER_COMMIT,
      max_render_state_bytes: MAX_RENDER_STATE_BYTES,
      max_replicas: manifest.max_replicas(),
      tick_ms: manifest.tick_ms(),
    },
    commands: manifest
      .commands
      .keys()
      .cloned()
      .collect::<BTreeSet<String>>(),
    events: manifest
      .events
      .keys()
      .cloned()
      .collect::<BTreeSet<String>>(),
    state_schema_version: manifest.state.schema_version,
    authority_entry_url: crate::game_package::protocol::entry_url(
      &manifest.id,
      &manifest.entry.authority,
    ),
    flush_ms: manifest.flush_ms(),
    authority_mode: manifest.runtime.authority.clone(),
    game_version: manifest.version.clone(),
    command_timeouts: manifest
      .commands
      .iter()
      .filter_map(|(kind, decl)| decl.timeout_ms.map(|timeout| (kind.clone(), timeout)))
      .collect::<BTreeMap<String, u64>>(),
  }
}

fn package_error(message: String) -> GameError {
  if message.contains("未启用") {
    GameError::new(codes::PACKAGE_DISABLED, message)
  } else {
    GameError::new(codes::MANIFEST_INVALID, message)
  }
}

/// 启动一个 Game Instance；幂等：已在运行返回当前视图。
pub fn start(app: &AppHandle, game_id: &str) -> GameResult<GameInstanceView> {
  let manifest = store::ensure_runnable(app, game_id).map_err(package_error)?;
  if manifest.runtime.authority != "host-tick" {
    return Err(GameError::new(
      codes::UNSUPPORTED_AUTHORITY_MODE,
      "当前版本只支持 runtime.authority=host-tick",
    ));
  }
  let spec = spec_from_manifest(&manifest);
  let loaded = repository::load(app, game_id, spec.state_schema_version)?;
  let (instance_id, epoch, revision, simulation_time_ms, state) = match loaded {
    Some(loaded) => (
      loaded.instance_id,
      loaded.authority_epoch.saturating_add(1).max(1),
      loaded.revision,
      loaded.simulation_time_ms,
      loaded.state,
    ),
    None => (new_instance_id(), 1, 0, 0, json!({})),
  };
  let entry_url = spec.authority_entry_url.clone();
  let limits = spec.limits;
  let max_running = usize::try_from(config::max_running(app)).unwrap_or(3);
  {
    let mut manager = manager();
    if let Some(existing) = manager.instances.get(game_id) {
      if existing.status.is_active() {
        let (replicas, controllers) = counts(&manager, game_id);
        return Ok(existing.view(replicas, controllers));
      }
    }
    if active_instance_count(&manager) >= max_running {
      return Err(GameError::new(
        codes::INSTANCE_LIMIT,
        format!("同时运行的游戏上限为 {max_running}"),
      ));
    }
    let instance = GameInstance::new(
      game_id,
      &instance_id,
      epoch,
      revision,
      simulation_time_ms,
      state,
      spec,
      now_ms(),
    );
    manager.instances.insert(game_id.to_string(), instance);
  }

  let instance_snapshot = {
    let manager = manager();
    manager
      .instances
      .get(game_id)
      .cloned()
      .ok_or_else(|| GameError::new(codes::INSTANCE_NOT_FOUND, "实例创建失败"))?
  };
  if let Err(error) = authority::create(app, &instance_snapshot, &entry_url, &limits) {
    let mut manager = manager();
    manager.instances.remove(game_id);
    return Err(error);
  }

  if !wait_ready(game_id, READY_TIMEOUT) {
    authority::destroy(app, &instance_id);
    let mut manager = manager();
    manager.instances.remove(game_id);
    return Err(GameError::new(
      codes::AUTHORITY_NOT_READY,
      "Authority 未在超时前就绪",
    ));
  }

  let (lifecycle, snapshot) = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例已消失"));
    };
    instance.status = InstanceStatus::Running;
    instance.last_tick_ms = now_ms();
    instance.last_running_ms = now_ms();
    instance.updated_at_ms = now_ms();
    (
      instance.lifecycle("started", None, None),
      instance.snapshot(),
    )
  };
  let view = {
    let manager = manager();
    let (replicas, controllers) = counts(&manager, game_id);
    manager
      .instances
      .get(game_id)
      .map(|instance| instance.view(replicas, controllers))
      .ok_or_else(|| GameError::new(codes::INSTANCE_NOT_FOUND, "实例已消失"))?
  };
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_snapshot(app, &snapshot);
  manager::emit_games_changed(app);
  Ok(view)
}

fn wait_ready(game_id: &str, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    {
      let manager = manager();
      match manager
        .instances
        .get(game_id)
        .map(|instance| instance.status)
      {
        Some(InstanceStatus::Ready) | Some(InstanceStatus::Running) => return true,
        Some(InstanceStatus::Failed) | Some(InstanceStatus::Stopping) => return false,
        None => return false,
        _ => {}
      }
    }
    if Instant::now() >= deadline {
      return false;
    }
    thread::sleep(Duration::from_millis(50));
  }
}

/// 停止：拒绝新命令 → 等权威收尾 → 最终落盘 → 销毁窗口。
pub fn stop(app: &AppHandle, game_id: &str) -> GameResult<GameInstanceView> {
  let (instance_id, lifecycle_stop, already_done) = {
    let mut manager = manager();
    let (replicas, controllers) = counts(&manager, game_id);
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return Err(GameError::new(
        codes::INSTANCE_NOT_FOUND,
        format!("游戏 {game_id} 没有活动实例"),
      ));
    };
    if !instance.status.is_active() {
      return Ok(instance.view(replicas, controllers));
    }
    if instance.status == InstanceStatus::Stopping {
      (instance.instance_id.clone(), None, true)
    } else {
      instance.status = InstanceStatus::Stopping;
      instance.authority_detached = false;
      instance.updated_at_ms = now_ms();
      (
        instance.instance_id.clone(),
        Some(instance.lifecycle("stopped", Some("stop-requested"), None)),
        false,
      )
    }
  };
  if let Some(lifecycle) = &lifecycle_stop {
    authority::send_lifecycle(app, &instance_id, lifecycle);
  }
  if !already_done {
    let deadline = Instant::now() + STOP_GRACE;
    loop {
      {
        let manager = manager();
        let detached = manager
          .instances
          .get(game_id)
          .is_some_and(|instance| instance.authority_detached);
        if detached {
          break;
        }
      }
      if Instant::now() >= deadline {
        break;
      }
      thread::sleep(Duration::from_millis(50));
    }
  }

  let (view, lifecycle) = {
    let mut manager = manager();
    let (replicas, controllers) = counts(&manager, game_id);
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例已消失"));
    };
    instance.status = InstanceStatus::Stopped;
    instance.updated_at_ms = now_ms();
    if let Err(error) = repository::save(app, instance, true) {
      instance.status = InstanceStatus::Failed;
      instance.set_error(error.body());
      let _ = repository::save(app, instance, true);
      return Err(error);
    }
    let view = instance.view(replicas, controllers);
    let lifecycle = instance.lifecycle("stopped", None, None);
    manager.instances.remove(game_id);
    manager
      .replicas
      .retain(|_, replica| replica.game_id != game_id);
    manager
      .controllers
      .retain(|_, controller| controller.game_id != game_id);
    (view, lifecycle)
  };
  authority::destroy(app, &instance_id);
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_games_changed(app);
  Ok(view)
}

/// 立即保存（不清空实例）。
pub fn flush(app: &AppHandle, game_id: &str) -> GameResult<GameInstanceView> {
  let mut manager_guard = manager();
  let (replicas, controllers) = counts(&manager_guard, game_id);
  let Some(instance) = manager_guard.instances.get_mut(game_id) else {
    return Err(GameError::new(
      codes::INSTANCE_NOT_FOUND,
      format!("游戏 {game_id} 没有活动实例"),
    ));
  };
  if !instance.status.is_active() {
    return Ok(instance.view(replicas, controllers));
  }
  repository::save(app, instance, true)?;
  Ok(instance.view(replicas, controllers))
}

/// 用户暂停：先落盘，再进入 Suspended；恢复时把暂停时长作为 offlineMs 下发。
pub fn suspend(app: &AppHandle, game_id: &str) -> GameResult<GameInstanceView> {
  let mut manager_guard = manager();
  let (replicas, controllers) = counts(&manager_guard, game_id);
  let Some(instance) = manager_guard.instances.get_mut(game_id) else {
    return Err(GameError::new(
      codes::INSTANCE_NOT_FOUND,
      format!("游戏 {game_id} 没有活动实例"),
    ));
  };
  if !matches!(
    instance.status,
    InstanceStatus::Running | InstanceStatus::Background
  ) {
    return Ok(instance.view(replicas, controllers));
  }
  repository::save(app, instance, true)?;
  instance.suspend(now_ms());
  let lifecycle = instance.lifecycle("suspended", Some("user"), None);
  let view = instance.view(replicas, controllers);
  let _ = repository::save(app, instance, true);
  drop(manager_guard);
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_games_changed(app);
  Ok(view)
}

/// 用户恢复：从 Suspended 回到 Running，并带上离线时长。
pub fn resume(app: &AppHandle, game_id: &str) -> GameResult<GameInstanceView> {
  let mut manager_guard = manager();
  let (replicas, controllers) = counts(&manager_guard, game_id);
  let Some(instance) = manager_guard.instances.get_mut(game_id) else {
    return Err(GameError::new(
      codes::INSTANCE_NOT_FOUND,
      format!("游戏 {game_id} 没有活动实例"),
    ));
  };
  if instance.status != InstanceStatus::Suspended {
    return Ok(instance.view(replicas, controllers));
  }
  let offline_ms = instance.resume(now_ms()).min(config::offline_max_ms(app));
  instance.dirty = true;
  let lifecycle = instance.lifecycle("resumed", Some("user"), Some(offline_ms));
  let view = instance.view(replicas, controllers);
  let _ = repository::save(app, instance, true);
  drop(manager_guard);
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_games_changed(app);
  Ok(view)
}

/// Authority 崩溃后的接管：epoch+1、新 token、重建窗口、从上次落盘恢复。
pub fn failover(app: &AppHandle, game_id: &str) {
  let (instance_id, entry_url, limits) = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return;
    };
    if !instance.status.is_active() || instance.status == InstanceStatus::Stopping {
      return;
    }
    let epoch = instance.epoch().saturating_add(1);
    instance.authority_id = super::lease::new_authority_id();
    instance.lease = AuthorityLease::issue(
      &instance.instance_id,
      &instance.authority_id,
      epoch,
      now_ms(),
    );
    instance.status = InstanceStatus::Starting;
    instance.authority_detached = false;
    instance.updated_at_ms = now_ms();
    (
      instance.instance_id.clone(),
      instance.spec.authority_entry_url.clone(),
      instance.spec.limits,
    )
  };
  let instance_snapshot = {
    let manager = manager();
    let Some(instance) = manager.instances.get(game_id) else {
      return;
    };
    instance.clone()
  };
  if let Err(error) = authority::create(app, &instance_snapshot, &entry_url, &limits) {
    mark_failed(app, game_id, error);
    return;
  }
  if !wait_ready(game_id, READY_TIMEOUT) {
    authority::destroy(app, &instance_id);
    mark_failed(
      app,
      game_id,
      GameError::new(codes::AUTHORITY_NOT_READY, "新 Authority 未在超时前就绪"),
    );
    return;
  }
  let (lifecycle, snapshot) = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return;
    };
    instance.status = InstanceStatus::Running;
    instance.last_tick_ms = now_ms();
    instance.last_running_ms = now_ms();
    instance.updated_at_ms = now_ms();
    (
      instance.lifecycle("authority-changed", None, None),
      instance.snapshot(),
    )
  };
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_snapshot(app, &snapshot);
  manager::emit_games_changed(app);
}

fn mark_failed(app: &AppHandle, game_id: &str, error: GameError) {
  let lifecycle = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(game_id) else {
      return;
    };
    instance.status = InstanceStatus::Failed;
    let body = error.body();
    instance.set_error(body);
    let _ = repository::save(app, instance, true);
    instance.failed_lifecycle("authority.failed")
  };
  manager::emit_lifecycle(app, &lifecycle);
  manager::emit_games_changed(app);
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn manifest_value() -> serde_json::Value {
    json!({
      "schemaVersion": 1,
      "type": "game",
      "id": "demo.game",
      "name": "Demo",
      "version": "1.2.3",
      "license": "MIT",
      "hostApi": 1,
      "entry": { "authority": "authority/index.html" },
      "runtime": { "authority": "host-tick", "tickMs": 500, "maxReplicas": 4 },
      "display": { "policy": "shared" },
      "capabilities": ["game.state.read", "game.state.write", "game.command.receive"],
      "commands": { "plant.seed": { "timeoutMs": 2500 } },
      "events": { "world.changed": {} },
      "state": { "schemaVersion": 7, "maxSizeBytes": 2048 }
    })
  }

  #[test]
  fn spec_maps_manifest_fields() {
    let manifest: GameManifest = serde_json::from_value(manifest_value()).expect("manifest");
    let spec = spec_from_manifest(&manifest);
    assert_eq!(spec.limits.tick_ms, 500);
    assert_eq!(spec.limits.max_replicas, 4);
    assert_eq!(spec.limits.max_state_bytes, 2048);
    assert_eq!(spec.state_schema_version, 7);
    assert_eq!(spec.authority_mode, "host-tick");
    assert_eq!(spec.game_version, "1.2.3");
    assert!(spec.commands.contains("plant.seed"));
    assert_eq!(spec.command_timeout_ms("plant.seed"), 2500);
    assert_eq!(spec.command_timeout_ms("unknown"), 5000);
    assert!(spec
      .authority_entry_url
      .contains("/demo.game/authority/index.html"));
    assert_eq!(spec.flush_ms, 1000);
  }
}
