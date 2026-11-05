//! 单个 Game Instance 的内存状态与状态机。
//!
//! 实例与显示器无关：它的生命周期由 `game_start` / `game_stop` 与 Authority
//! 租约驱动；壁纸窗口只是副本。这里只放纯数据与纯方法，窗口/磁盘操作在
//! `lifecycle` 与 `repository`。

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::error::GameErrorBody;
use super::lease::AuthorityLease;
use super::protocol::{
  GameInstanceView, GameLifecycle, GameLimits, GameSnapshot, PROTOCOL_VERSION,
};

#[must_use]
pub fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
    .unwrap_or(0)
}

#[must_use]
pub fn new_instance_id() -> String {
  uuid::Uuid::now_v7().simple().to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Hidden/Suspended/Background 在 P2 的暂停策略里启用。
pub enum InstanceStatus {
  Starting,
  Ready,
  Running,
  Hidden,
  Suspended,
  Background,
  Stopping,
  Stopped,
  Failed,
}

impl InstanceStatus {
  #[must_use]
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Starting => "starting",
      Self::Ready => "ready",
      Self::Running => "running",
      Self::Hidden => "hidden",
      Self::Suspended => "suspended",
      Self::Background => "background",
      Self::Stopping => "stopping",
      Self::Stopped => "stopped",
      Self::Failed => "failed",
    }
  }

  /// 仍在占用运行名额（含启动/停止过程中）。
  #[must_use]
  pub fn is_active(self) -> bool {
    matches!(
      self,
      Self::Starting
        | Self::Ready
        | Self::Running
        | Self::Hidden
        | Self::Suspended
        | Self::Background
        | Self::Stopping
    )
  }

  /// P1：hidden/suspended 不接受新命令；停止流程只允许最终提交。
  #[must_use]
  pub fn accepts_commands(self) -> bool {
    matches!(self, Self::Running | Self::Background)
  }

  /// 只有"运行中"的实例才允许打开/连接自己的控制器窗口。
  ///
  /// 与前端开关的可见范围一致：`starting/ready/stopping/stopped/failed` 一律拒绝，
  /// 避免出现"游戏还没就绪控制器就先连上"的空上下文。
  #[must_use]
  pub fn accepts_controller(self) -> bool {
    matches!(
      self,
      Self::Running | Self::Hidden | Self::Suspended | Self::Background
    )
  }

  #[must_use]
  pub fn accepts_commits(self) -> bool {
    matches!(self, Self::Ready | Self::Running | Self::Background)
  }

  #[must_use]
  pub fn can_tick(self) -> bool {
    matches!(self, Self::Running | Self::Background)
  }
}

/// 从游戏清单得到的运行时只读规格；实例创建后不再变化。
#[derive(Debug, Clone)]
pub struct InstanceSpec {
  pub limits: GameLimits,
  pub capabilities: BTreeSet<String>,
  pub commands: BTreeSet<String>,
  pub events: BTreeSet<String>,
  pub state_schema_version: u32,
  pub authority_entry_url: String,
  pub flush_ms: u64,
  pub authority_mode: String,
  pub game_version: String,
  pub command_timeouts: BTreeMap<String, u64>,
}

impl InstanceSpec {
  #[must_use]
  pub fn command_timeout_ms(&self, kind: &str) -> u64 {
    self
      .command_timeouts
      .get(kind)
      .copied()
      .unwrap_or(super::protocol::DEFAULT_COMMAND_TIMEOUT_MS)
  }
}

#[derive(Debug, Clone)]
pub struct GameInstance {
  pub game_id: String,
  pub instance_id: String,
  pub authority_id: String,
  pub lease: AuthorityLease,
  pub revision: u64,
  pub simulation_time_ms: u64,
  pub event_seq: u64,
  pub state: Value,
  pub status: InstanceStatus,
  pub spec: InstanceSpec,
  pub created_at_ms: u64,
  pub updated_at_ms: u64,
  pub last_committed_at_ms: u64,
  pub last_tick_ms: u64,
  pub last_flush_ms: u64,
  pub last_commit_ms: u64,
  pub dirty: bool,
  pub last_error: Option<GameErrorBody>,
  pub authority_detached: bool,
  pub retries: u32,
  pub commits_since_backup: u64,
  /// 进入 hidden（无可见副本/控制器）的时刻；用于恢复时补 offlineMs。
  pub hidden_since_ms: Option<u64>,
  /// 是否曾经有副本/控制器接入；从未接入的实例不自动进入 hidden。
  pub had_participants: bool,
  /// 最近一次处于运行态的时刻；suspend 恢复时据此计算离线时长。
  pub last_running_ms: u64,
  /// 诊断计数：ticker 实际发出的 tick 数。
  pub ticks_total: u64,
  /// 诊断计数：成功提交次数。
  pub commits_total: u64,
  /// 诊断计数：成功提交携带的事件总数。
  pub events_total: u64,
  /// 诊断计数：renderState 发布次数。
  pub render_publishes_total: u64,
  /// 最近一次成功提交的墙钟时间。
  pub last_commit_at_ms: u64,
}

impl GameInstance {
  #[allow(clippy::too_many_arguments)]
  #[must_use]
  pub fn new(
    game_id: &str,
    instance_id: &str,
    epoch: u32,
    revision: u64,
    simulation_time_ms: u64,
    state: Value,
    spec: InstanceSpec,
    now: u64,
  ) -> Self {
    let authority_id = super::lease::new_authority_id();
    let lease = AuthorityLease::issue(instance_id, &authority_id, epoch, now);
    Self {
      game_id: game_id.to_string(),
      instance_id: instance_id.to_string(),
      authority_id,
      lease,
      revision,
      simulation_time_ms,
      event_seq: 0,
      state,
      status: InstanceStatus::Starting,
      spec,
      created_at_ms: now,
      updated_at_ms: now,
      last_committed_at_ms: now,
      last_tick_ms: 0,
      last_flush_ms: now,
      last_commit_ms: 0,
      dirty: false,
      last_error: None,
      authority_detached: false,
      retries: 0,
      commits_since_backup: 0,
      hidden_since_ms: None,
      had_participants: false,
      last_running_ms: now,
      ticks_total: 0,
      commits_total: 0,
      events_total: 0,
      render_publishes_total: 0,
      last_commit_at_ms: 0,
    }
  }

  /// 有副本/控制器接入：记录参与历史；从 hidden 恢复时返回离线毫秒数。
  pub fn mark_participant(&mut self, now: u64) -> Option<u64> {
    self.had_participants = true;
    self.updated_at_ms = now;
    if self.status != InstanceStatus::Hidden {
      return None;
    }
    let offline = self
      .hidden_since_ms
      .map_or(0, |since| now.saturating_sub(since));
    self.status = InstanceStatus::Running;
    self.hidden_since_ms = None;
    self.last_running_ms = now;
    self.last_tick_ms = now;
    Some(offline)
  }

  /// 无参与者时进入 hidden；调用方负责广播 suspended 事件与落盘。
  pub fn enter_hidden(&mut self, now: u64) {
    self.status = InstanceStatus::Hidden;
    self.hidden_since_ms = Some(now);
    self.updated_at_ms = now;
  }

  /// 用户暂停：记录暂停起点，供恢复时结算离线时长。
  pub fn suspend(&mut self, now: u64) {
    self.status = InstanceStatus::Suspended;
    self.hidden_since_ms = None;
    self.last_running_ms = now;
    self.updated_at_ms = now;
  }

  /// 用户恢复：返回暂停期间经过的毫秒数。
  pub fn resume(&mut self, now: u64) -> u64 {
    let offline = now.saturating_sub(self.last_running_ms);
    self.status = InstanceStatus::Running;
    self.hidden_since_ms = None;
    self.last_running_ms = now;
    self.last_tick_ms = now;
    self.updated_at_ms = now;
    offline
  }

  #[must_use]
  pub fn epoch(&self) -> u32 {
    self.lease.epoch
  }

  #[must_use]
  pub fn snapshot(&self) -> GameSnapshot {
    GameSnapshot {
      protocol: PROTOCOL_VERSION,
      game_id: self.game_id.clone(),
      instance_id: self.instance_id.clone(),
      revision: self.revision,
      authority_epoch: self.epoch(),
      simulation_time_ms: self.simulation_time_ms,
      state: self.state.clone(),
    }
  }

  #[must_use]
  pub fn view(&self, replicas: usize, controllers: usize) -> GameInstanceView {
    GameInstanceView {
      game_id: self.game_id.clone(),
      instance_id: self.instance_id.clone(),
      authority_epoch: self.epoch(),
      revision: self.revision,
      simulation_time_ms: self.simulation_time_ms,
      status: self.status.as_str().to_string(),
      last_error: self.last_error.clone(),
      replicas,
      controllers,
      updated_at: self.updated_at_ms,
    }
  }

  #[must_use]
  pub fn lifecycle(
    &self,
    state: &str,
    reason: Option<&str>,
    offline_ms: Option<u64>,
  ) -> GameLifecycle {
    GameLifecycle {
      game_id: self.game_id.clone(),
      instance_id: self.instance_id.clone(),
      authority_epoch: self.epoch(),
      revision: self.revision,
      state: state.to_string(),
      reason: reason.map(str::to_string),
      offline_ms,
      error: None,
    }
  }

  #[must_use]
  pub fn failed_lifecycle(&self, reason: &str) -> GameLifecycle {
    let mut event = self.lifecycle("failed", Some(reason), None);
    event.error = self.last_error.clone();
    event
  }

  pub fn set_error(&mut self, error: GameErrorBody) {
    self.last_error = Some(error);
    self.updated_at_ms = now_ms();
  }

  /// 单实例的提交间隔（P1 host-tick 下也用 8/s 的硬上限兜底）。
  #[must_use]
  pub fn commit_allowed(&self, now: u64) -> bool {
    // self-loop 允许 4 次/秒；host-tick 由 tick 节流，额外兜底 8 次/秒。
    let interval = if self.spec.authority_mode == "self-loop" {
      240
    } else {
      120
    };
    self.last_commit_ms == 0 || now.saturating_sub(self.last_commit_ms) >= interval
  }

  /// 用户显式要求后台运行：即使没有副本/控制器也继续 tick（降频）。
  pub fn enter_background(&mut self, now: u64) -> bool {
    if !matches!(
      self.status,
      InstanceStatus::Running | InstanceStatus::Hidden
    ) {
      return false;
    }
    self.status = InstanceStatus::Background;
    self.hidden_since_ms = None;
    self.last_running_ms = now;
    self.last_tick_ms = now;
    self.updated_at_ms = now;
    true
  }

  /// 回到前台：有参与者或从未接入过参与者 → Running；否则 → Hidden。
  pub fn leave_background(&mut self, now: u64, attached: bool) -> bool {
    if self.status != InstanceStatus::Background {
      return false;
    }
    if attached || !self.had_participants {
      self.status = InstanceStatus::Running;
      self.hidden_since_ms = None;
      self.last_running_ms = now;
    } else {
      self.status = InstanceStatus::Hidden;
      self.hidden_since_ms = Some(now);
    }
    self.last_tick_ms = now;
    self.updated_at_ms = now;
    true
  }

  /// 稳定运行 60s 后清空崩溃重试计数，避免"历史两次崩溃永久失去 failover"。
  pub fn maybe_reset_retries(&mut self, now: u64) {
    if self.retries > 0
      && matches!(
        self.status,
        InstanceStatus::Running | InstanceStatus::Background
      )
      && now.saturating_sub(self.last_running_ms) >= 60_000
    {
      self.retries = 0;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::game::protocol::GameLimits;
  use serde_json::json;

  fn spec() -> InstanceSpec {
    InstanceSpec {
      limits: GameLimits {
        max_state_bytes: 1024,
        max_event_bytes: 64,
        max_events_per_commit: 4,
        max_render_state_bytes: 64,
        max_replicas: 2,
        tick_ms: 1_000,
      },
      commands: BTreeSet::from(["plant.seed".to_string()]),
      capabilities: BTreeSet::from(["game.command.receive".to_string()]),
      events: BTreeSet::new(),
      state_schema_version: 1,
      authority_entry_url: "http://lullgame.localhost/demo/authority/index.html".into(),
      flush_ms: 1_000,
      authority_mode: "host-tick".into(),
      game_version: "1.0.0".into(),
      command_timeouts: BTreeMap::new(),
    }
  }

  #[test]
  fn new_instance_starts_and_builds_snapshot() {
    let instance = GameInstance::new(
      "demo.game",
      "i1",
      2,
      0,
      0,
      json!({"food": 1}),
      spec(),
      1_000,
    );
    assert_eq!(instance.status, InstanceStatus::Starting);
    let snapshot = instance.snapshot();
    assert_eq!(snapshot.revision, 0);
    assert_eq!(snapshot.authority_epoch, 2);
    assert_eq!(snapshot.state["food"], 1);
  }

  #[test]
  fn status_permissions_match_design_table() {
    assert!(InstanceStatus::Running.accepts_commands());
    assert!(!InstanceStatus::Ready.accepts_commands());
    assert!(InstanceStatus::Ready.accepts_commits());
    assert!(!InstanceStatus::Starting.accepts_commits());
    assert!(!InstanceStatus::Suspended.accepts_commands());
    assert!(InstanceStatus::Stopping.is_active());
    assert!(!InstanceStatus::Stopped.is_active());
    assert!(InstanceStatus::Running.accepts_controller());
    assert!(InstanceStatus::Hidden.accepts_controller());
    assert!(InstanceStatus::Suspended.accepts_controller());
    assert!(InstanceStatus::Background.accepts_controller());
    assert!(!InstanceStatus::Starting.accepts_controller());
    assert!(!InstanceStatus::Ready.accepts_controller());
    assert!(!InstanceStatus::Stopping.accepts_controller());
    assert!(!InstanceStatus::Failed.accepts_controller());
  }

  #[test]
  fn commit_rate_limit_is_120ms() {
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec(), 0);
    assert!(instance.commit_allowed(1_000));
    instance.last_commit_ms = 1_000;
    assert!(!instance.commit_allowed(1_050));
    assert!(instance.commit_allowed(1_120));
  }

  #[test]
  fn self_loop_commit_limit_is_240ms() {
    let mut spec = spec();
    spec.authority_mode = "self-loop".to_string();
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec, 0);
    assert!(instance.commit_allowed(1_000));
    instance.last_commit_ms = 1_000;
    assert!(!instance.commit_allowed(1_200));
    assert!(instance.commit_allowed(1_240));
  }

  #[test]
  fn background_transitions_keep_attached_instances_running() {
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec(), 0);
    instance.status = InstanceStatus::Running;
    instance.had_participants = true;
    assert!(instance.enter_background(1_000));
    assert_eq!(instance.status, InstanceStatus::Background);
    assert!(instance.leave_background(2_000, true));
    assert_eq!(instance.status, InstanceStatus::Running);

    instance.had_participants = true;
    instance.status = InstanceStatus::Hidden;
    assert!(instance.enter_background(3_000));
    assert!(instance.leave_background(4_000, false));
    assert_eq!(instance.status, InstanceStatus::Hidden);

    let mut never_attached = GameInstance::new("g2", "i2", 1, 0, 0, json!({}), spec(), 0);
    never_attached.status = InstanceStatus::Running;
    assert!(never_attached.enter_background(1_000));
    assert!(never_attached.leave_background(2_000, false));
    assert_eq!(never_attached.status, InstanceStatus::Running);
  }

  #[test]
  fn retries_reset_after_stable_running() {
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec(), 0);
    instance.status = InstanceStatus::Running;
    instance.retries = 2;
    instance.last_running_ms = 10_000;
    instance.maybe_reset_retries(69_000);
    assert_eq!(instance.retries, 2);
    instance.maybe_reset_retries(70_000);
    assert_eq!(instance.retries, 0);
  }

  #[test]
  fn participant_resumes_hidden_instance_with_offline_time() {
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec(), 1_000);
    instance.status = InstanceStatus::Running;
    instance.last_running_ms = 10_000;
    instance.enter_hidden(12_000);
    assert_eq!(instance.status, InstanceStatus::Hidden);
    assert_eq!(instance.hidden_since_ms, Some(12_000));
    let offline = instance.mark_participant(15_000);
    assert_eq!(offline, Some(3_000));
    assert_eq!(instance.status, InstanceStatus::Running);
    assert!(instance.hidden_since_ms.is_none());
    assert!(instance.had_participants);
    // Running 状态下再次接入不重复补离线。
    assert_eq!(instance.mark_participant(16_000), None);
  }

  #[test]
  fn suspend_and_resume_report_elapsed_time() {
    let mut instance = GameInstance::new("g", "i", 1, 0, 0, json!({}), spec(), 1_000);
    instance.status = InstanceStatus::Running;
    instance.last_running_ms = 5_000;
    instance.suspend(9_000);
    assert_eq!(instance.status, InstanceStatus::Suspended);
    assert_eq!(instance.resume(14_000), 5_000);
    assert_eq!(instance.status, InstanceStatus::Running);
    assert_eq!(instance.last_tick_ms, 14_000);
  }
}
