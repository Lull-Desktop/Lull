//! 状态提交规则：revision、epoch/lease、配额与事件构造。
//!
//! 这里是"Host 是最终裁决者"的纯逻辑入口：不碰窗口、不碰磁盘；
//! 返回给上层要广播的快照/事件/渲染态，写盘由 `repository` 负责。

use serde_json::Value;

use super::error::{codes, GameError, GameResult};
use super::instance::{now_ms, GameInstance};
use super::protocol::{
  event_id, GameEvent, GameEventDraft, GameRenderPublishRequest, GameRenderState, GameSnapshot,
  GameStateUpdate, PROTOCOL_VERSION,
};

#[derive(Debug, Clone)]
pub struct CommitOutcome {
  pub snapshot: GameSnapshot,
  pub events: Vec<GameEvent>,
  pub render_state: Option<GameRenderState>,
}

fn serialized_len(value: &Value) -> GameResult<usize> {
  serde_json::to_vec(value)
    .map(|bytes| bytes.len())
    .map_err(|error| GameError::new(codes::STATE_INVALID, format!("状态不是合法 JSON：{error}")))
}

/// 校验并应用一次权威提交。成功时实例已被推进到新 revision。
pub fn apply_commit(
  instance: &mut GameInstance,
  token: &str,
  update: GameStateUpdate,
  now: u64,
) -> GameResult<CommitOutcome> {
  if !instance.status.accepts_commits() {
    return Err(GameError::new(
      codes::INSTANCE_NOT_RUNNING,
      format!("实例当前状态 {} 不接受提交", instance.status.as_str()),
    ));
  }
  instance
    .lease
    .verify(&update.authority_id, update.authority_epoch, token, now)?;
  if update.base_revision != instance.revision {
    return Err(GameError::new(
      codes::STATE_REVISION_CONFLICT,
      format!(
        "baseRevision 不匹配：当前 {}，提交 {}",
        instance.revision, update.base_revision
      ),
    ));
  }
  if !instance.commit_allowed(now) {
    return Err(GameError::new(
      codes::STATE_COMMIT_RATE_LIMITED,
      "提交过于频繁（上限 8 次/秒）",
    ));
  }

  let state_bytes = serialized_len(&update.state)?;
  if u64::try_from(state_bytes).unwrap_or(u64::MAX) > instance.spec.limits.max_state_bytes {
    return Err(GameError::new(
      codes::STATE_TOO_LARGE,
      format!(
        "状态 {} 字节超过上限 {} 字节",
        state_bytes, instance.spec.limits.max_state_bytes
      ),
    ));
  }

  if update.events.len() > instance.spec.limits.max_events_per_commit {
    return Err(GameError::new(
      codes::EVENT_TOO_LARGE,
      format!(
        "单次提交事件数 {} 超过上限 {}",
        update.events.len(),
        instance.spec.limits.max_events_per_commit
      ),
    ));
  }
  for draft in &update.events {
    validate_event_draft(instance, draft)?;
  }

  let render_state = match &update.render_state {
    None => None,
    Some(state) => {
      let bytes = serialized_len(state)?;
      if bytes > instance.spec.limits.max_render_state_bytes {
        return Err(GameError::new(
          codes::STATE_TOO_LARGE,
          format!(
            "渲染态 {} 字节超过上限 {} 字节",
            bytes, instance.spec.limits.max_render_state_bytes
          ),
        ));
      }
      Some(state.clone())
    }
  };

  let simulation_time_ms = if update.simulation_time_ms == 0 {
    instance.simulation_time_ms
  } else {
    update.simulation_time_ms
  };
  if simulation_time_ms < instance.simulation_time_ms {
    return Err(GameError::new(
      codes::STATE_INVALID,
      "simulationTimeMs 不能回退",
    ));
  }
  if simulation_time_ms > now.saturating_add(3_600_000) {
    return Err(GameError::new(
      codes::STATE_INVALID,
      "simulationTimeMs 超前墙钟超过 1 小时",
    ));
  }

  instance.revision += 1;
  instance.state = update.state;
  instance.simulation_time_ms = simulation_time_ms;
  instance.last_commit_ms = now;
  instance.last_committed_at_ms = now;
  instance.updated_at_ms = now;
  instance.dirty = true;
  instance.commits_since_backup += 1;

  let mut events = Vec::with_capacity(update.events.len());
  for draft in update.events {
    instance.event_seq += 1;
    events.push(GameEvent {
      protocol: PROTOCOL_VERSION,
      game_id: instance.game_id.clone(),
      instance_id: instance.instance_id.clone(),
      event_id: event_id(&instance.instance_id, instance.revision, instance.event_seq),
      revision: instance.revision,
      authority_epoch: instance.epoch(),
      kind: draft.kind,
      payload: draft.payload,
      simulation_time_ms: instance.simulation_time_ms,
    });
  }

  let render_state = render_state.map(|state| GameRenderState {
    protocol: PROTOCOL_VERSION,
    game_id: instance.game_id.clone(),
    instance_id: instance.instance_id.clone(),
    revision: instance.revision,
    authority_epoch: instance.epoch(),
    state,
    published_at: now_ms(),
  });

  Ok(CommitOutcome {
    snapshot: instance.snapshot(),
    events,
    render_state,
  })
}

fn validate_event_draft(instance: &GameInstance, draft: &GameEventDraft) -> GameResult<()> {
  if !instance.spec.events.contains(&draft.kind) {
    return Err(GameError::new(
      codes::EVENT_UNDECLARED_TYPE,
      format!("事件类型未在 game.json.events 声明：{}", draft.kind),
    ));
  }
  let bytes = serde_json::to_vec(&draft.payload).map_err(|error| {
    GameError::new(
      codes::EVENT_TOO_LARGE,
      format!("事件 payload 非法：{error}"),
    )
  })?;
  if bytes.len() > instance.spec.limits.max_event_bytes {
    return Err(GameError::new(
      codes::EVENT_TOO_LARGE,
      format!(
        "事件 {} 超过 {} 字节上限",
        draft.kind, instance.spec.limits.max_event_bytes
      ),
    ));
  }
  Ok(())
}

/// 非状态事件：不推进 revision，只借用当前 revision 与 epoch。
pub fn publish_events(
  instance: &mut GameInstance,
  drafts: Vec<GameEventDraft>,
  now: u64,
) -> GameResult<Vec<GameEvent>> {
  if !instance.status.accepts_commits() {
    return Err(GameError::new(
      codes::INSTANCE_NOT_RUNNING,
      "实例未运行，不能发布事件",
    ));
  }
  if drafts.len() > instance.spec.limits.max_events_per_commit {
    return Err(GameError::new(
      codes::EVENT_TOO_LARGE,
      format!(
        "单次事件数超过上限 {}",
        instance.spec.limits.max_events_per_commit
      ),
    ));
  }
  let mut events = Vec::with_capacity(drafts.len());
  for draft in &drafts {
    validate_event_draft(instance, draft)?;
  }
  for draft in drafts {
    instance.event_seq += 1;
    instance.updated_at_ms = now;
    events.push(GameEvent {
      protocol: PROTOCOL_VERSION,
      game_id: instance.game_id.clone(),
      instance_id: instance.instance_id.clone(),
      event_id: event_id(&instance.instance_id, instance.revision, instance.event_seq),
      revision: instance.revision,
      authority_epoch: instance.epoch(),
      kind: draft.kind,
      payload: draft.payload,
      simulation_time_ms: instance.simulation_time_ms,
    });
  }
  Ok(events)
}

/// 渲染态：不落盘、可丢帧；revision 只能是当前值（不能超前）。
pub fn publish_render_state(
  instance: &GameInstance,
  request: GameRenderPublishRequest,
  now: u64,
) -> GameResult<GameRenderState> {
  if !instance.status.accepts_commits() {
    return Err(GameError::new(
      codes::INSTANCE_NOT_RUNNING,
      "实例未运行，不能发布渲染态",
    ));
  }
  if request.revision > instance.revision {
    return Err(GameError::new(
      codes::STATE_INVALID,
      "渲染态 revision 不能超前于当前状态",
    ));
  }
  let bytes = serialized_len(&request.state)?;
  if bytes > instance.spec.limits.max_render_state_bytes {
    return Err(GameError::new(
      codes::STATE_TOO_LARGE,
      format!(
        "渲染态 {} 字节超过上限 {} 字节",
        bytes, instance.spec.limits.max_render_state_bytes
      ),
    ));
  }
  Ok(GameRenderState {
    protocol: PROTOCOL_VERSION,
    game_id: instance.game_id.clone(),
    instance_id: instance.instance_id.clone(),
    revision: instance.revision,
    authority_epoch: instance.epoch(),
    state: request.state,
    published_at: now,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::game::instance::InstanceSpec;
  use crate::game::protocol::{GameLimits, GameStateUpdate};
  use serde_json::json;
  use std::collections::BTreeSet;

  fn instance() -> GameInstance {
    let spec = InstanceSpec {
      limits: GameLimits {
        max_state_bytes: 512,
        max_event_bytes: 64,
        max_events_per_commit: 2,
        max_render_state_bytes: 64,
        max_replicas: 2,
        tick_ms: 1_000,
      },
      commands: BTreeSet::new(),
      events: BTreeSet::from(["world.changed".to_string()]),
      state_schema_version: 1,
      authority_entry_url: "http://lullgame.localhost/demo/authority/index.html".into(),
      flush_ms: 1_000,
      authority_mode: "host-tick".into(),
      game_version: "1.0.0".into(),
      command_timeouts: std::collections::BTreeMap::new(),
    };
    let mut instance = GameInstance::new("demo.game", "i1", 2, 0, 0, json!({}), spec, 1_000);
    instance.status = crate::game::instance::InstanceStatus::Running;
    instance
  }

  fn update(instance: &GameInstance) -> GameStateUpdate {
    GameStateUpdate {
      authority_id: instance.authority_id.clone(),
      authority_epoch: instance.epoch(),
      base_revision: instance.revision,
      simulation_time_ms: 1_000,
      state: json!({"food": 2}),
      events: vec![GameEventDraft {
        kind: "world.changed".into(),
        payload: json!({"food": 2}),
      }],
      render_state: Some(json!({"x": 1})),
    }
  }

  #[test]
  fn commit_advances_revision_and_builds_events() {
    let mut instance = instance();
    let token = instance.lease.token.clone();
    let update = update(&instance);
    let outcome = apply_commit(&mut instance, &token, update, 1_100).expect("commit");
    assert_eq!(instance.revision, 1);
    assert_eq!(outcome.snapshot.revision, 1);
    assert_eq!(outcome.events.len(), 1);
    assert_eq!(outcome.events[0].event_id, "i1:1:1");
    let render = outcome.render_state.expect("render");
    assert_eq!(render.revision, 1);
    assert!(instance.dirty);
  }

  #[test]
  fn revision_conflict_is_rejected() {
    let mut instance = instance();
    let token = instance.lease.token.clone();
    let mut update = update(&instance);
    update.base_revision = 5;
    assert_eq!(
      apply_commit(&mut instance, &token, update, 1_100)
        .err()
        .map(|error| error.code),
      Some(codes::STATE_REVISION_CONFLICT)
    );
  }

  #[test]
  fn epoch_and_token_mismatch_are_rejected() {
    let mut instance = instance();
    let token = instance.lease.token.clone();
    let mut wrong_epoch = update(&instance);
    wrong_epoch.authority_epoch += 1;
    assert_eq!(
      apply_commit(&mut instance, &token, wrong_epoch, 1_100)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_EPOCH_MISMATCH)
    );
    let mut wrong_token = update(&instance);
    wrong_token.authority_id = "other".into();
    assert_eq!(
      apply_commit(&mut instance, &token, wrong_token, 1_100)
        .err()
        .map(|error| error.code),
      Some(codes::AUTHORITY_NOT_OWNER)
    );
  }

  #[test]
  fn oversized_state_and_undeclared_events_are_rejected() {
    let mut instance = instance();
    let token = instance.lease.token.clone();
    let mut too_large = update(&instance);
    too_large.state = json!({ "blob": "x".repeat(600) });
    assert_eq!(
      apply_commit(&mut instance, &token, too_large, 1_100)
        .err()
        .map(|error| error.code),
      Some(codes::STATE_TOO_LARGE)
    );
    let mut undeclared = update(&instance);
    undeclared.events[0].kind = "unknown".into();
    assert_eq!(
      apply_commit(&mut instance, &token, undeclared, 1_100)
        .err()
        .map(|error| error.code),
      Some(codes::EVENT_UNDECLARED_TYPE)
    );
  }

  #[test]
  fn commit_rate_limit_applies() {
    let mut instance = instance();
    let token = instance.lease.token.clone();
    let update = update(&instance);
    apply_commit(&mut instance, &token, update, 1_100).expect("first");
    let next = GameStateUpdate {
      authority_id: instance.authority_id.clone(),
      authority_epoch: instance.epoch(),
      base_revision: instance.revision,
      simulation_time_ms: 1_100,
      state: json!({"food": 3}),
      events: Vec::new(),
      render_state: None,
    };
    assert_eq!(
      apply_commit(&mut instance, &token, next.clone(), 1_150)
        .err()
        .map(|error| error.code),
      Some(codes::STATE_COMMIT_RATE_LIMITED)
    );
    assert!(apply_commit(&mut instance, &token, next, 1_220).is_ok());
  }
}
