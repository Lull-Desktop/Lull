//! Game Runtime 的 Tauri 命令层。
//!
//! 角色只按窗口 label 判定；token 与授权账本在这里做前置校验，真正的提交
//! 校验在 `state::apply_commit`。所有命令都薄：编排在 `lifecycle`/`manager`。

use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window};

use super::authority;
use super::config::{self, GamesConfig};
use super::error::{codes, GameError, GameErrorBody, GameResult};
use super::instance::{now_ms, GameInstance};
use super::manager::{self, manager};
use super::permissions::{self, WindowRole};
use super::protocol::{
  GameCommandEnvelope, GameCommandResult, GameCommandResultRequest, GameCommandSendRequest,
  GameCommitResult, GameConnectRequest, GameConnectResult, GameContext, GameEventDraft,
  GameInstanceView, GameLimits, GameRenderContext, GameRenderPublishRequest,
  GameReportErrorRequest, GameRole, GameSnapshot, GameStateUpdate, GameView, HOST_API,
  MAX_COMMAND_PAYLOAD_BYTES, PROTOCOL_VERSION,
};
use super::{journal, lifecycle, repository, state};
use crate::game_package::store;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPublishResult {
  pub accepted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPublishResult {
  pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResult {
  pub expires_at: u64,
}

fn default_limits() -> GameLimits {
  GameLimits {
    max_state_bytes: 1_048_576,
    max_event_bytes: super::protocol::MAX_EVENT_BYTES,
    max_events_per_commit: super::protocol::MAX_EVENTS_PER_COMMIT,
    max_render_state_bytes: super::protocol::MAX_RENDER_STATE_BYTES,
    max_replicas: 8,
    tick_ms: 1_000,
  }
}

fn require_label_token(window: &Window, token: Option<&str>) -> GameResult<()> {
  permissions::require_window_token(window.label(), token)
}

fn authority_label_context(window: &Window) -> GameResult<(String, String)> {
  let instance_id = permissions::authority_instance_id(window.label())
    .map(str::to_string)
    .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "当前窗口不是 Authority 窗口"))?;
  let game_id = {
    let manager = manager();
    manager::game_for_instance(&manager, &instance_id)
      .ok_or_else(|| GameError::new(codes::INSTANCE_NOT_FOUND, "Authority 实例不存在"))?
  };
  Ok((game_id, instance_id))
}

fn verify_authority(window: &Window, token: Option<&str>) -> GameResult<String> {
  let (game_id, _) = authority_label_context(window)?;
  let manager = manager();
  let instance = manager
    .instances
    .get(&game_id)
    .ok_or_else(|| GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"))?;
  let token =
    token.ok_or_else(|| GameError::new(codes::AUTHORITY_TOKEN_INVALID, "缺少 authority token"))?;
  if token != instance.lease.token {
    return Err(GameError::new(
      codes::AUTHORITY_TOKEN_INVALID,
      "authority token 无效",
    ));
  }
  if instance.lease.is_expired(now_ms()) {
    return Err(GameError::new(
      codes::AUTHORITY_LEASE_EXPIRED,
      "Authority 租约已过期",
    ));
  }
  Ok(game_id)
}

fn context_for(
  role: GameRole,
  game_id: &str,
  instance: Option<&GameInstance>,
  render: Option<GameRenderContext>,
  locale: String,
) -> GameContext {
  let limits = instance.map_or_else(default_limits, |instance| instance.spec.limits);
  GameContext {
    protocol: PROTOCOL_VERSION,
    host_api: HOST_API,
    role,
    game_id: game_id.to_string(),
    instance_id: instance.map(|instance| instance.instance_id.clone()),
    authority_id: instance.map(|instance| instance.authority_id.clone()),
    authority_epoch: instance.map_or(0, GameInstance::epoch),
    revision: instance.map_or(0, |instance| instance.revision),
    simulation_time_ms: instance.map_or(0, |instance| instance.simulation_time_ms),
    render,
    limits,
    locale,
  }
}

fn instance_or_error(game_id: &str) -> GameResult<GameInstance> {
  let manager = manager();
  manager.instances.get(game_id).cloned().ok_or_else(|| {
    GameError::new(
      codes::INSTANCE_NOT_FOUND,
      format!("游戏 {game_id} 没有活动实例"),
    )
  })
}

/// 参与者连接：authority / wallpaper replica / widget controller。
#[tauri::command]
pub fn game_connect(
  window: Window,
  request: Option<GameConnectRequest>,
  token: Option<String>,
) -> Result<GameConnectResult, GameError> {
  let app = window.app_handle().clone();
  let label = window.label().to_string();
  let request = request.unwrap_or_default();
  let locale = crate::i18n::current();
  let offline_cap = config::offline_max_ms(&app);
  match permissions::role_of(&label) {
    WindowRole::Authority => {
      let game_id = verify_authority(&window, token.as_deref())?;
      let instance = instance_or_error(&game_id)?;
      Ok(GameConnectResult {
        context: Some(context_for(
          GameRole::Authority,
          &game_id,
          Some(&instance),
          None,
          locale,
        )),
        replica_id: None,
      })
    }
    WindowRole::Replica => {
      require_label_token(&window, token.as_deref())?;
      let game_id = request
        .game_id
        .as_deref()
        .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "replica 缺少 gameId"))?;
      let mut render = request
        .render
        .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "replica 缺少渲染几何"))?;
      // displayId 由宿主按壁纸窗口 label 解析，不信任前端传入值。
      render.display_id =
        crate::wallpaper::runtime::device_for_label(&label).unwrap_or_else(|| label.clone());
      let instance = {
        let manager = manager();
        manager.instances.get(game_id).cloned()
      };
      let Some(instance) = instance else {
        return Ok(GameConnectResult {
          context: None,
          replica_id: None,
        });
      };
      if !instance.status.is_active() {
        return Ok(GameConnectResult {
          context: None,
          replica_id: None,
        });
      }
      let replica_id = uuid::Uuid::new_v4().simple().to_string();
      let resumed = {
        let mut manager = manager();
        let current = manager
          .replicas
          .values()
          .filter(|replica| replica.game_id == game_id && replica.window_label != label)
          .count();
        if current >= usize::try_from(instance.spec.limits.max_replicas).unwrap_or(8) {
          return Err(GameError::new(
            codes::REPLICA_LIMIT_REACHED,
            "渲染副本数量已达上限",
          ));
        }
        manager.replicas.insert(
          label.clone(),
          manager::ReplicaEntry {
            replica_id: replica_id.clone(),
            game_id: game_id.to_string(),
            instance_id: instance.instance_id.clone(),
            window_label: label.clone(),
            display_device: render.display_id.clone(),
            mode: render.mode.clone(),
            render: render.clone(),
            connected_at_ms: now_ms(),
            ready: false,
          },
        );
        manager.instances.get_mut(game_id).and_then(|instance| {
          let offline = instance.mark_participant(now_ms())?;
          Some(instance.lifecycle("resumed", Some("hidden"), Some(offline.min(offline_cap))))
        })
      };
      let instance = instance_or_error(game_id)?;
      if let Some(lifecycle) = resumed {
        manager::emit_lifecycle(&app, &lifecycle);
        manager::emit_games_changed(&app);
      }
      let context = context_for(
        GameRole::Replica,
        game_id,
        Some(&instance),
        Some(render),
        locale,
      );
      let _ = app.emit_to(&label, manager::EVENT_SNAPSHOT, instance.snapshot());
      Ok(GameConnectResult {
        context: Some(context),
        replica_id: Some(replica_id),
      })
    }
    WindowRole::Controller => {
      let widget_id =
        permissions::require_widget_controller(&app, &label, token.as_deref(), "game.state.read")?;
      let game_id = request
        .game_id
        .as_deref()
        .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "controller 缺少 gameId"))?;
      let instance = {
        let manager = manager();
        manager.instances.get(game_id).cloned()
      };
      let resumed = {
        let mut manager = manager();
        manager.controllers.insert(
          label.clone(),
          manager::ControllerEntry {
            game_id: game_id.to_string(),
            instance_id: instance
              .as_ref()
              .map(|instance| instance.instance_id.clone()),
            window_label: label.clone(),
            connected_at_ms: now_ms(),
          },
        );
        manager.instances.get_mut(game_id).and_then(|instance| {
          let offline = instance.mark_participant(now_ms())?;
          Some(instance.lifecycle("resumed", Some("hidden"), Some(offline.min(offline_cap))))
        })
      };
      if let Some(lifecycle) = resumed {
        manager::emit_lifecycle(&app, &lifecycle);
        manager::emit_games_changed(&app);
      }
      let instance = manager().instances.get(game_id).cloned();
      let _ = widget_id;
      Ok(GameConnectResult {
        context: Some(context_for(
          GameRole::Controller,
          game_id,
          instance.as_ref(),
          None,
          locale,
        )),
        replica_id: None,
      })
    }
    _ => Err(GameError::new(
      codes::PERMISSION_DENIED,
      "当前窗口不能连接游戏",
    )),
  }
}

#[tauri::command]
pub fn game_snapshot_get(
  window: Window,
  token: Option<String>,
) -> Result<Option<GameSnapshot>, GameError> {
  let app = window.app_handle().clone();
  let label = window.label().to_string();
  match permissions::role_of(&label) {
    WindowRole::Authority => {
      let game_id = verify_authority(&window, token.as_deref())?;
      Ok(
        instance_or_error(&game_id)
          .ok()
          .map(|instance| instance.snapshot()),
      )
    }
    WindowRole::Replica => {
      require_label_token(&window, token.as_deref())?;
      let game_id = {
        let manager = manager();
        manager
          .replicas
          .get(&label)
          .map(|replica| replica.game_id.clone())
          .ok_or_else(|| GameError::new(codes::REPLICA_NOT_ATTACHED, "replica 未连接"))?
      };
      Ok(
        instance_or_error(&game_id)
          .ok()
          .map(|instance| instance.snapshot()),
      )
    }
    WindowRole::Controller => {
      let _ =
        permissions::require_widget_controller(&app, &label, token.as_deref(), "game.state.read")?;
      let game_id = {
        let manager = manager();
        manager
          .controllers
          .get(&label)
          .map(|controller| controller.game_id.clone())
          .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "controller 未连接"))?
      };
      Ok(
        instance_or_error(&game_id)
          .ok()
          .map(|instance| instance.snapshot()),
      )
    }
    _ => Err(GameError::new(
      codes::PERMISSION_DENIED,
      "当前窗口不能读取快照",
    )),
  }
}

#[tauri::command]
pub fn game_state_commit(
  window: Window,
  request: GameStateUpdate,
  token: Option<String>,
) -> Result<GameCommitResult, GameError> {
  let app = window.app_handle().clone();
  let game_id = verify_authority(&window, token.as_deref())?;
  let token = token.unwrap_or_default();
  let (outcome, current_revision) = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(&game_id) else {
      return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"));
    };
    let before = instance.revision;
    match state::apply_commit(instance, &token, request, now_ms()) {
      Ok(outcome) => {
        instance.commits_total = instance.commits_total.saturating_add(1);
        instance.events_total = instance
          .events_total
          .saturating_add(outcome.events.len() as u64);
        instance.last_commit_at_ms = now_ms();
        (Ok(outcome), before)
      }
      Err(error) => (Err(error), instance.revision),
    }
  };
  match outcome {
    Ok(outcome) => {
      let _ = journal::append(&app, &outcome.snapshot, &outcome.events, now_ms());
      manager::emit_snapshot(&app, &outcome.snapshot);
      manager::emit_events(&app, &game_id, &outcome.events);
      if let Some(render) = &outcome.render_state {
        manager::emit_render(&app, &game_id, render);
      }
      Ok(GameCommitResult {
        ok: true,
        revision: outcome.snapshot.revision,
        error: None,
      })
    }
    Err(error) => Ok(GameCommitResult {
      ok: false,
      revision: current_revision,
      error: Some(error.body()),
    }),
  }
}

#[tauri::command]
pub fn game_event_publish(
  window: Window,
  events: Vec<GameEventDraft>,
  token: Option<String>,
) -> Result<EventPublishResult, GameError> {
  let app = window.app_handle().clone();
  let game_id = verify_authority(&window, token.as_deref())?;
  let published = {
    let mut manager = manager();
    let Some(instance) = manager.instances.get_mut(&game_id) else {
      return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"));
    };
    state::publish_events(instance, events, now_ms())?
  };
  let accepted = published.len();
  manager::emit_events(&app, &game_id, &published);
  Ok(EventPublishResult { accepted })
}

#[tauri::command]
pub fn game_render_state_publish(
  window: Window,
  request: GameRenderPublishRequest,
  token: Option<String>,
) -> Result<RenderPublishResult, GameError> {
  let app = window.app_handle().clone();
  let game_id = verify_authority(&window, token.as_deref())?;
  let render = {
    let mut manager = manager();
    let instance = manager
      .instances
      .get_mut(&game_id)
      .ok_or_else(|| GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"))?;
    let render = state::publish_render_state(instance, request, now_ms())?;
    instance.render_publishes_total = instance.render_publishes_total.saturating_add(1);
    render
  };
  manager::emit_render(&app, &game_id, &render);
  Ok(RenderPublishResult {
    revision: render.revision,
  })
}

#[tauri::command]
pub fn game_command_result(
  window: Window,
  request: GameCommandResultRequest,
  token: Option<String>,
) -> Result<(), GameError> {
  let app = window.app_handle().clone();
  let game_id = verify_authority(&window, token.as_deref())?;
  let pending_key = format!("{game_id}:{}", request.request_id);
  let mut manager = manager();
  let Some(pending) = manager.pending.remove(&pending_key) else {
    return Ok(());
  };
  if pending.game_id != game_id {
    manager.pending.insert(pending_key, pending);
    return Err(GameError::new(
      codes::PERMISSION_DENIED,
      "命令不属于当前实例",
    ));
  }
  let revision = manager
    .instances
    .get(&game_id)
    .map(|instance| instance.revision);
  let result = GameCommandResult {
    request_id: request.request_id.clone(),
    ok: request.ok,
    result: request.result,
    error: request.error,
    revision: request.revision.or(revision),
    deduplicated: false,
  };
  manager::remember_command(
    &mut manager,
    &game_id,
    &request.request_id,
    &result,
    now_ms(),
  );
  manager::emit_command_result(&app, &pending.sender_label, &result);
  let _ = pending.sender.send(result);
  Ok(())
}

#[tauri::command]
pub fn game_ready(window: Window, token: Option<String>) -> Result<(), GameError> {
  let label = window.label().to_string();
  match permissions::role_of(&label) {
    WindowRole::Authority => {
      let game_id = verify_authority(&window, token.as_deref())?;
      let mut manager = manager();
      let Some(instance) = manager.instances.get_mut(&game_id) else {
        return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"));
      };
      if instance.status == super::instance::InstanceStatus::Starting {
        instance.status = super::instance::InstanceStatus::Ready;
      }
      Ok(())
    }
    WindowRole::Replica => {
      require_label_token(&window, token.as_deref())?;
      let mut manager = manager();
      if let Some(replica) = manager.replicas.get_mut(&label) {
        replica.ready = true;
      }
      Ok(())
    }
    _ => Err(GameError::new(
      codes::PERMISSION_DENIED,
      "当前窗口不能上报 ready",
    )),
  }
}

#[tauri::command]
pub fn game_heartbeat(window: Window, token: Option<String>) -> Result<HeartbeatResult, GameError> {
  let game_id = verify_authority(&window, token.as_deref())?;
  let mut manager = manager();
  let Some(instance) = manager.instances.get_mut(&game_id) else {
    return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "实例不存在"));
  };
  instance.lease.renew(now_ms());
  Ok(HeartbeatResult {
    expires_at: instance.lease.expires_at_ms,
  })
}

#[tauri::command]
pub fn game_report_error(
  window: Window,
  request: GameReportErrorRequest,
  token: Option<String>,
) -> Result<(), GameError> {
  let app = window.app_handle().clone();
  let label = window.label().to_string();
  let body = GameErrorBody {
    code: request.code.clone(),
    message: request.message.clone(),
    detail: Some(request.scope.clone()),
  };
  match permissions::role_of(&label) {
    WindowRole::Authority => {
      let game_id = verify_authority(&window, token.as_deref())?;
      let lifecycle = {
        let mut manager = manager();
        let Some(instance) = manager.instances.get_mut(&game_id) else {
          return Ok(());
        };
        instance.set_error(body);
        if matches!(
          instance.status,
          super::instance::InstanceStatus::Starting | super::instance::InstanceStatus::Ready
        ) {
          instance.status = super::instance::InstanceStatus::Failed;
          let _ = repository::save(&app, instance, true);
          Some(instance.failed_lifecycle("authority.error"))
        } else {
          None
        }
      };
      if let Some(lifecycle) = lifecycle {
        manager::emit_lifecycle(&app, &lifecycle);
        manager::emit_games_changed(&app);
      }
      Ok(())
    }
    WindowRole::Replica => {
      require_label_token(&window, token.as_deref())?;
      let _ = (request.scope, request.code, request.message);
      Ok(())
    }
    WindowRole::Controller => {
      let _ =
        permissions::require_widget_controller(&app, &label, token.as_deref(), "game.state.read")?;
      Ok(())
    }
    _ => Err(GameError::new(
      codes::PERMISSION_DENIED,
      "当前窗口不能上报错误",
    )),
  }
}

#[tauri::command]
pub fn game_detach(window: Window, token: Option<String>) -> Result<(), GameError> {
  let label = window.label().to_string();
  match permissions::role_of(&label) {
    WindowRole::Authority => {
      let game_id = verify_authority(&window, token.as_deref())?;
      let mut manager = manager();
      if let Some(instance) = manager.instances.get_mut(&game_id) {
        instance.authority_detached = true;
        if instance.status != super::instance::InstanceStatus::Stopping {
          instance.status = super::instance::InstanceStatus::Failed;
          instance.set_error(GameErrorBody {
            code: codes::AUTHORITY_NOT_READY.to_string(),
            message: "Authority 主动断开".to_string(),
            detail: None,
          });
        }
      }
      Ok(())
    }
    WindowRole::Replica => {
      let mut manager = manager();
      manager.replicas.remove(&label);
      Ok(())
    }
    WindowRole::Controller => {
      let mut manager = manager();
      manager.controllers.remove(&label);
      Ok(())
    }
    _ => Err(GameError::new(
      codes::PERMISSION_DENIED,
      "当前窗口不能 detach",
    )),
  }
}

#[tauri::command]
pub fn game_command_send(
  app: AppHandle,
  window: Window,
  request: GameCommandSendRequest,
  token: Option<String>,
) -> Result<GameCommandResult, GameError> {
  let label = window.label().to_string();
  if permissions::role_of(&label) != WindowRole::Controller {
    return Err(GameError::new(
      codes::PERMISSION_DENIED,
      "只有 Controller Widget 可以发送命令",
    ));
  }
  let _ =
    permissions::require_widget_controller(&app, &label, token.as_deref(), "game.command.send")?;
  let game_id = {
    let manager = manager();
    manager
      .controllers
      .get(&label)
      .map(|controller| controller.game_id.clone())
      .ok_or_else(|| GameError::new(codes::PERMISSION_DENIED, "controller 未连接"))?
  };
  let now = now_ms();
  let pending_key = format!("{game_id}:{}", request.request_id);
  let (instance_id, timeout_ms, envelope) = {
    let mut manager = manager();
    let instance = manager.instances.get(&game_id).cloned();
    let Some(instance) = instance else {
      return Err(GameError::new(codes::INSTANCE_NOT_FOUND, "游戏未运行"));
    };
    if !instance.status.accepts_commands() {
      return Err(GameError::new(
        codes::INSTANCE_NOT_RUNNING,
        format!("实例当前状态 {} 不接受命令", instance.status.as_str()),
      ));
    }
    if !instance.spec.commands.contains(&request.kind) {
      return Err(GameError::new(
        codes::COMMAND_UNKNOWN_TYPE,
        format!("命令类型未在 game.json.commands 声明：{}", request.kind),
      ));
    }
    let size = serde_json::to_vec(&request.payload)
      .map(|bytes| bytes.len())
      .unwrap_or(0);
    if size > MAX_COMMAND_PAYLOAD_BYTES {
      return Err(GameError::new(
        codes::COMMAND_INVALID_PAYLOAD,
        format!("命令 payload {size} 字节超过 32 KiB 上限"),
      ));
    }
    if let Some(expected) = request.expected_revision {
      if expected != instance.revision {
        return Err(GameError::new(
          codes::STATE_REVISION_CONFLICT,
          format!("expectedRevision 不匹配：当前 {}", instance.revision),
        ));
      }
    }
    if !manager::allow_command(&mut manager, &label, now) {
      return Err(GameError::new(
        codes::COMMAND_RATE_LIMITED,
        "命令发送过快（8/s）",
      ));
    }
    if let Some(recorded) = manager::recorded_command(&manager, &game_id, &request.request_id, now)
    {
      return Ok(recorded);
    }
    if manager.pending.contains_key(&pending_key) {
      return Err(GameError::new(
        codes::COMMAND_RATE_LIMITED,
        "同一 requestId 仍在处理中",
      ));
    }
    let envelope = GameCommandEnvelope {
      protocol: PROTOCOL_VERSION,
      request_id: request.request_id.clone(),
      kind: request.kind.clone(),
      payload: request.payload,
      expected_revision: request.expected_revision,
    };
    (
      instance.instance_id.clone(),
      instance.spec.command_timeout_ms(&request.kind),
      envelope,
    )
  };
  let (sender, receiver) = mpsc::channel();
  {
    let mut manager = manager();
    manager.pending.insert(
      pending_key.clone(),
      manager::PendingCommand {
        game_id: game_id.clone(),
        sender_label: label.clone(),
        sender,
      },
    );
  }
  authority::send_command(&app, &instance_id, &envelope);
  match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
    Ok(result) => Ok(result),
    Err(_) => {
      let mut manager = manager();
      manager.pending.remove(&pending_key);
      Err(GameError::new(
        codes::COMMAND_TIMEOUT,
        format!("命令 {} 在 {timeout_ms}ms 内没有返回结果", request.kind),
      ))
    }
  }
}

#[tauri::command]
#[must_use]
pub fn games_list(app: AppHandle) -> Vec<GameView> {
  let packages = store::list(&app);
  let manager_guard = manager();
  packages
    .into_iter()
    .map(|package| {
      let instance = manager::instance_view(&manager_guard, &package.id);
      GameView {
        id: package.id,
        name: package.name,
        version: package.version,
        description: package.description,
        author: package.author,
        license: package.license,
        status: package.status,
        error: package.error,
        enabled: package.enabled,
        granted: package.granted,
        capabilities: package.capabilities,
        state_schema_version: package.state_schema_version,
        instance,
      }
    })
    .collect()
}

#[tauri::command]
pub async fn game_start(app: AppHandle, game_id: String) -> Result<GameInstanceView, GameError> {
  tauri::async_runtime::spawn_blocking(move || lifecycle::start(&app, &game_id))
    .await
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("启动任务失败：{error}")))?
}

/// 壁纸窗专用：按 `games.json.autoStartWithWallpaper` 自动启动场景绑定的游戏。
/// 未启用/已关闭自动启动时返回 null，由场景保持静态视觉。
#[tauri::command]
pub async fn game_auto_start(
  app: AppHandle,
  game_id: String,
) -> Result<Option<GameInstanceView>, GameError> {
  if !config::auto_start_with_wallpaper(&app) || !store::is_enabled(&app, &game_id) {
    return Ok(None);
  }
  tauri::async_runtime::spawn_blocking(move || lifecycle::start(&app, &game_id).map(Some))
    .await
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("自动启动任务失败：{error}")))?
}

#[tauri::command]
#[must_use]
pub fn games_config_get(app: AppHandle) -> GamesConfig {
  config::load(&app)
}

#[tauri::command]
pub fn games_config_set(app: AppHandle, config: GamesConfig) -> Result<GamesConfig, GameError> {
  let saved = config::save(&app, config)?;
  manager::emit_games_changed(&app);
  Ok(saved)
}

#[tauri::command]
pub async fn game_stop(app: AppHandle, game_id: String) -> Result<GameInstanceView, GameError> {
  tauri::async_runtime::spawn_blocking(move || lifecycle::stop(&app, &game_id))
    .await
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("停止任务失败：{error}")))?
}

#[tauri::command]
pub fn game_flush(app: AppHandle, game_id: String) -> Result<GameInstanceView, GameError> {
  lifecycle::flush(&app, &game_id)
}

#[tauri::command]
pub fn game_suspend(app: AppHandle, game_id: String) -> Result<GameInstanceView, GameError> {
  lifecycle::suspend(&app, &game_id)
}

#[tauri::command]
pub fn game_resume(app: AppHandle, game_id: String) -> Result<GameInstanceView, GameError> {
  lifecycle::resume(&app, &game_id)
}

#[tauri::command]
pub fn game_set_background(
  app: AppHandle,
  game_id: String,
  enabled: bool,
) -> Result<GameInstanceView, GameError> {
  lifecycle::set_background(&app, &game_id, enabled)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstanceDiagnostics {
  pub game_id: String,
  pub instance_id: String,
  pub status: String,
  pub authority_mode: String,
  pub authority_epoch: u32,
  pub revision: u64,
  pub simulation_time_ms: u64,
  pub ticks_total: u64,
  pub commits_total: u64,
  pub events_total: u64,
  pub render_publishes_total: u64,
  pub last_commit_at_ms: u64,
  pub last_tick_age_ms: u64,
  pub lease_remaining_ms: u64,
  pub replicas: usize,
  pub controllers: usize,
  pub last_error_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRuntimeDiagnostics {
  pub uptime_ms: u64,
  pub instance_count: usize,
  pub replica_count: usize,
  pub controller_count: usize,
  pub pending_commands: usize,
  pub instances: Vec<GameInstanceDiagnostics>,
}

/// 稳定性报告/诊断用：只读运行时计数，不改变任何状态。
#[tauri::command]
#[must_use]
pub fn game_runtime_diagnostics() -> GameRuntimeDiagnostics {
  let manager = manager();
  let now = now_ms();
  let uptime_ms = if manager.started_at_ms == 0 {
    0
  } else {
    now.saturating_sub(manager.started_at_ms)
  };
  let mut instances: Vec<GameInstanceDiagnostics> = manager
    .instances
    .values()
    .map(|instance| GameInstanceDiagnostics {
      game_id: instance.game_id.clone(),
      instance_id: instance.instance_id.clone(),
      status: instance.status.as_str().to_string(),
      authority_mode: instance.spec.authority_mode.clone(),
      authority_epoch: instance.epoch(),
      revision: instance.revision,
      simulation_time_ms: instance.simulation_time_ms,
      ticks_total: instance.ticks_total,
      commits_total: instance.commits_total,
      events_total: instance.events_total,
      render_publishes_total: instance.render_publishes_total,
      last_commit_at_ms: instance.last_commit_at_ms,
      last_tick_age_ms: if instance.last_tick_ms == 0 {
        0
      } else {
        now.saturating_sub(instance.last_tick_ms)
      },
      lease_remaining_ms: instance.lease.expires_at_ms.saturating_sub(now),
      replicas: manager
        .replicas
        .values()
        .filter(|replica| replica.game_id == instance.game_id)
        .count(),
      controllers: manager
        .controllers
        .values()
        .filter(|controller| controller.game_id == instance.game_id)
        .count(),
      last_error_code: instance.last_error.as_ref().map(|error| error.code.clone()),
    })
    .collect();
  instances.sort_by(|left, right| left.game_id.cmp(&right.game_id));
  GameRuntimeDiagnostics {
    uptime_ms,
    instance_count: instances.len(),
    replica_count: manager.replicas.len(),
    controller_count: manager.controllers.len(),
    pending_commands: manager.pending.len(),
    instances,
  }
}

#[tauri::command]
pub fn game_save_delete(app: AppHandle, game_id: String) -> Result<(), GameError> {
  {
    let mut manager = manager();
    if let Some(instance) = manager.instances.get(&game_id) {
      if instance.status.is_active() {
        return Err(GameError::new(
          codes::INSTANCE_NOT_RUNNING,
          "请先停止游戏再删除存档",
        ));
      }
    }
    manager.instances.remove(&game_id);
  }
  repository::delete(&app, &game_id)?;
  manager::emit_games_changed(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_limits_match_design() {
    let limits = default_limits();
    assert_eq!(limits.max_state_bytes, 1_048_576);
    assert_eq!(limits.max_replicas, 8);
    assert_eq!(limits.tick_ms, 1_000);
  }

  #[test]
  fn context_without_instance_uses_defaults() {
    let context = context_for(
      GameRole::Controller,
      "demo.game",
      None,
      None,
      "zh-CN".into(),
    );
    assert_eq!(context.authority_epoch, 0);
    assert_eq!(context.revision, 0);
    assert!(context.instance_id.is_none());
    assert_eq!(context.limits.max_replicas, 8);
  }
}
