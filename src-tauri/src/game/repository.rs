//! 存档仓储：`game-data/<gameId>/<instanceId>/{metadata.json,state.json,backups/}`。
//!
//! 游戏包在 `games/<gameId>/`，存档故意放在独立根：包摘要扫描不罩存档，
//! 卸载包也不连坐存档。写入统一"临时文件 + 原子替换"。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::error::{codes, GameError, GameErrorBody, GameResult};
use super::instance::{now_ms, GameInstance, InstanceStatus};

const METADATA_FILE: &str = "metadata.json";
const STATE_FILE: &str = "state.json";
const BACKUP_DIR: &str = "backups";
const BACKUP_KEEP: usize = 3;
const BACKUP_EVERY: u64 = 60;
const META_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMetadata {
  pub schema_version: u32,
  pub game_id: String,
  pub instance_id: String,
  pub game_version: String,
  pub state_schema_version: u32,
  pub status: String,
  pub authority_epoch: u32,
  pub revision: u64,
  pub simulation_time_ms: u64,
  pub last_committed_at: u64,
  pub created_at: u64,
  pub last_started_at: u64,
  pub last_stopped_at: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub last_error: Option<GameErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
  pub schema_version: u32,
  pub revision: u64,
  pub authority_epoch: u32,
  pub simulation_time_ms: u64,
  pub updated_at: u64,
  pub state: Value,
}

#[derive(Debug, Clone)]
pub struct LoadedGame {
  pub instance_id: String,
  pub revision: u64,
  pub authority_epoch: u32,
  pub simulation_time_ms: u64,
  pub state: Value,
}

/// 存档根目录：`LULL_GAME_DATA_DIR` 优先，否则 app_data_dir/game-data。
pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("LULL_GAME_DATA_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("game-data"))
    .map_err(|error| error.to_string())
}

pub fn game_dir(root: &Path, game_id: &str) -> PathBuf {
  root.join(game_id)
}

/// 读取最近一次存档；目录不存在返回 `None`。
pub fn load(
  app: &AppHandle,
  game_id: &str,
  expected_schema: u32,
) -> GameResult<Option<LoadedGame>> {
  let root = data_root(app).map_err(|error| GameError::new(codes::IO_ERROR, error))?;
  load_at(&root, game_id, expected_schema)
}

/// `resumeOnLaunch` 用：扫描上次仍处于活动状态的实例（在 mark_interrupted 之前调用）。
#[must_use]
pub fn active_game_ids(app: &AppHandle) -> Vec<String> {
  data_root(app)
    .map(|root| active_game_ids_at(&root))
    .unwrap_or_default()
}

fn active_game_ids_at(root: &Path) -> Vec<String> {
  let Ok(games) = std::fs::read_dir(root) else {
    return Vec::new();
  };
  let mut ids = Vec::new();
  for game in games.flatten() {
    let game_dir = game.path();
    if !game_dir.is_dir() {
      continue;
    }
    let Ok(instances) = std::fs::read_dir(&game_dir) else {
      continue;
    };
    for instance in instances.flatten() {
      let instance_dir = instance.path();
      if !instance_dir.is_dir() {
        continue;
      }
      let Some(metadata) = read_metadata(&instance_dir.join(METADATA_FILE)) else {
        continue;
      };
      if matches!(
        metadata.status.as_str(),
        "starting" | "ready" | "running" | "background" | "hidden" | "suspended"
      ) {
        ids.push(metadata.game_id);
      }
    }
  }
  ids.sort();
  ids.dedup();
  ids
}

/// 落盘当前实例；`force_backup` 用于干净停止。
pub fn save(app: &AppHandle, instance: &mut GameInstance, force_backup: bool) -> GameResult<()> {
  let root = data_root(app).map_err(|error| GameError::new(codes::IO_ERROR, error))?;
  save_at(&root, instance, force_backup)
}

pub fn delete(app: &AppHandle, game_id: &str) -> GameResult<()> {
  let root = data_root(app).map_err(|error| GameError::new(codes::IO_ERROR, error))?;
  delete_at(&root, game_id)
}

/// 删除一个游戏的全部存档（所有 instance、备份与 metadata），保留其他游戏。
pub fn delete_at(root: &Path, game_id: &str) -> GameResult<()> {
  let dir = game_dir(root, game_id);
  if dir.exists() {
    std::fs::remove_dir_all(&dir)
      .map_err(|error| GameError::new(codes::IO_ERROR, format!("删除存档失败：{error}")))?;
  }
  Ok(())
}

/// 启动时把残留运行态标成 interrupted；读不懂的 metadata 原样跳过。
pub fn mark_interrupted(app: &AppHandle) {
  let Ok(root) = data_root(app) else {
    return;
  };
  let Ok(entries) = std::fs::read_dir(&root) else {
    return;
  };
  let stale = ["running", "starting", "ready", "stopping"];
  for entry in entries.filter_map(Result::ok) {
    let game_path = entry.path();
    if !game_path.is_dir() {
      continue;
    }
    let Ok(instances) = std::fs::read_dir(&game_path) else {
      continue;
    };
    for instance in instances.filter_map(Result::ok) {
      let path = instance.path().join(METADATA_FILE);
      let Ok(text) = std::fs::read_to_string(&path) else {
        continue;
      };
      let Ok(mut metadata) = serde_json::from_str::<InstanceMetadata>(&text) else {
        continue;
      };
      if !stale.contains(&metadata.status.as_str()) {
        continue;
      }
      metadata.status = "interrupted".to_string();
      metadata.last_stopped_at = Some(now_ms());
      if let Ok(json) = serde_json::to_vec_pretty(&metadata) {
        let _ = write_atomic(&path, &json);
      }
    }
  }
}

fn load_at(root: &Path, game_id: &str, expected_schema: u32) -> GameResult<Option<LoadedGame>> {
  let dir = game_dir(root, game_id);
  let Ok(entries) = std::fs::read_dir(&dir) else {
    return Ok(None);
  };
  let mut candidates: Vec<PathBuf> = entries
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.is_dir() && path.join(METADATA_FILE).is_file())
    .collect();
  // instanceId 是 UUIDv7（时间有序），倒序即"最近一次"。
  candidates.sort();
  for candidate in candidates.iter().rev() {
    if let Some(loaded) = load_instance(candidate, expected_schema)? {
      return Ok(Some(loaded));
    }
  }
  Ok(None)
}

fn load_instance(dir: &Path, expected_schema: u32) -> GameResult<Option<LoadedGame>> {
  let instance_id = dir
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| GameError::new(codes::IO_ERROR, "存档目录名非法"))?
    .to_string();
  let metadata = read_metadata(&dir.join(METADATA_FILE));
  let state = read_state(&dir.join(STATE_FILE))
    .or_else(|| read_latest_backup(dir))
    .ok_or_else(|| {
      GameError::new(
        codes::STATE_INCOMPATIBLE,
        "存档损坏且没有可用备份；请打开存档目录处理",
      )
    })?;
  if state.schema_version != expected_schema {
    return Err(GameError::new(
      codes::STATE_INCOMPATIBLE,
      format!(
        "存档 schemaVersion={} 与游戏声明的 {} 不匹配",
        state.schema_version, expected_schema
      ),
    ));
  }
  let authority_epoch = metadata.as_ref().map_or(1, |meta| meta.authority_epoch);
  Ok(Some(LoadedGame {
    instance_id,
    revision: state.revision,
    authority_epoch,
    simulation_time_ms: state.simulation_time_ms,
    state: state.state,
  }))
}

fn save_at(root: &Path, instance: &mut GameInstance, force_backup: bool) -> GameResult<()> {
  if !instance.dirty && !force_backup {
    return Ok(());
  }
  let dir = game_dir(root, &instance.game_id).join(&instance.instance_id);
  std::fs::create_dir_all(&dir)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("创建存档目录失败：{error}")))?;

  let state = PersistedState {
    schema_version: instance.spec.state_schema_version,
    revision: instance.revision,
    authority_epoch: instance.epoch(),
    simulation_time_ms: instance.simulation_time_ms,
    updated_at: instance.updated_at_ms,
    state: instance.state.clone(),
  };
  let json = serde_json::to_vec_pretty(&state)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("序列化存档失败：{error}")))?;
  write_atomic(&dir.join(STATE_FILE), &json)?;

  let metadata = InstanceMetadata {
    schema_version: META_SCHEMA_VERSION,
    game_id: instance.game_id.clone(),
    instance_id: instance.instance_id.clone(),
    game_version: instance.spec.game_version.clone(),
    state_schema_version: instance.spec.state_schema_version,
    status: instance.status.as_str().to_string(),
    authority_epoch: instance.epoch(),
    revision: instance.revision,
    simulation_time_ms: instance.simulation_time_ms,
    last_committed_at: instance.last_committed_at_ms,
    created_at: instance.created_at_ms,
    last_started_at: instance.created_at_ms,
    last_stopped_at: if instance.status == InstanceStatus::Stopped {
      Some(now_ms())
    } else {
      None
    },
    last_error: instance.last_error.clone(),
  };
  let json = serde_json::to_vec_pretty(&metadata)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("序列化 metadata 失败：{error}")))?;
  write_atomic(&dir.join(METADATA_FILE), &json)?;

  let backup_now = force_backup || instance.commits_since_backup >= BACKUP_EVERY;
  if backup_now && instance.revision > 0 {
    let backup_dir = dir.join(BACKUP_DIR);
    let _ = std::fs::create_dir_all(&backup_dir);
    if let Ok(json) = serde_json::to_vec_pretty(&state) {
      let _ = write_atomic(
        &backup_dir.join(format!("state-{}.json", instance.revision)),
        &json,
      );
      prune_backups(&backup_dir);
    }
    instance.commits_since_backup = 0;
  }

  instance.dirty = false;
  instance.last_flush_ms = now_ms();
  Ok(())
}

fn prune_backups(dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  let mut files: Vec<PathBuf> = entries
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.is_file())
    .collect();
  files.sort();
  if files.len() <= BACKUP_KEEP {
    return;
  }
  for path in &files[..files.len() - BACKUP_KEEP] {
    let _ = std::fs::remove_file(path);
  }
}

fn read_metadata(path: &Path) -> Option<InstanceMetadata> {
  let text = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&text).ok()
}

fn read_state(path: &Path) -> Option<PersistedState> {
  let text = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&text).ok()
}

fn read_latest_backup(dir: &Path) -> Option<PersistedState> {
  let backup_dir = dir.join(BACKUP_DIR);
  let entries = std::fs::read_dir(backup_dir).ok()?;
  let mut files: Vec<PathBuf> = entries
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.is_file())
    .collect();
  files.sort();
  files.iter().rev().find_map(|path| read_state(path))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> GameResult<()> {
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, bytes)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("写临时文件失败：{error}")))?;
  if path.exists() {
    std::fs::remove_file(path)
      .map_err(|error| GameError::new(codes::IO_ERROR, format!("替换旧存档失败：{error}")))?;
  }
  std::fs::rename(&temp, path)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("原子替换失败：{error}")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::game::instance::InstanceSpec;
  use crate::game::protocol::GameLimits;
  use serde_json::json;
  use std::collections::BTreeSet;

  fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "lull-game-repo-{name}-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp root");
    dir
  }

  fn instance() -> GameInstance {
    let spec = InstanceSpec {
      limits: GameLimits {
        max_state_bytes: 4096,
        max_event_bytes: 64,
        max_events_per_commit: 4,
        max_render_state_bytes: 64,
        max_replicas: 2,
        tick_ms: 1_000,
      },
      commands: BTreeSet::new(),
      capabilities: BTreeSet::new(),
      events: BTreeSet::new(),
      state_schema_version: 1,
      authority_entry_url: "http://lullgame.localhost/demo/authority/index.html".into(),
      flush_ms: 1_000,
      authority_mode: "host-tick".into(),
      game_version: "1.0.0".into(),
      command_timeouts: std::collections::BTreeMap::new(),
    };
    let mut instance = GameInstance::new(
      "demo.game",
      "0192f3a0000000000000000000000001",
      2,
      0,
      0,
      json!({ "food": 1 }),
      spec,
      1_000,
    );
    instance.status = InstanceStatus::Running;
    instance.dirty = true;
    instance
  }

  #[test]
  fn active_game_ids_only_reports_non_stopped_instances() {
    let root = temp_root("active");
    let mut running = instance();
    running.instance_id = "0192f3a0000000000000000000000002".into();
    save_at(&root, &mut running, false).expect("save running");

    let mut stopped = instance();
    stopped.game_id = "other.game".into();
    stopped.instance_id = "0192f3a0000000000000000000000003".into();
    stopped.status = InstanceStatus::Stopped;
    save_at(&root, &mut stopped, false).expect("save stopped");

    assert_eq!(active_game_ids_at(&root), vec!["demo.game".to_string()]);
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn same_instance_id_in_two_games_keeps_state_isolated() {
    let root = temp_root("game-isolation");
    let mut first = instance();
    first.game_id = "demo.one".into();
    first.instance_id = "0192f3a0000000000000000000000001".into();
    first.state = json!({ "seed": 11 });
    first.dirty = true;
    save_at(&root, &mut first, false).expect("save first");

    let mut second = instance();
    second.game_id = "demo.two".into();
    second.instance_id = "0192f3a0000000000000000000000001".into();
    second.state = json!({ "seed": 22 });
    second.dirty = true;
    save_at(&root, &mut second, false).expect("save second");

    let loaded_first = load_at(&root, "demo.one", 1)
      .expect("load first")
      .expect("first exists");
    let loaded_second = load_at(&root, "demo.two", 1)
      .expect("load second")
      .expect("second exists");
    assert_eq!(loaded_first.state["seed"], 11);
    assert_eq!(loaded_second.state["seed"], 22);
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn save_then_load_roundtrip() {
    let root = temp_root("roundtrip");
    let mut instance = instance();
    save_at(&root, &mut instance, false).expect("save");
    let loaded = load_at(&root, "demo.game", 1).expect("load").expect("some");
    assert_eq!(loaded.revision, 0);
    assert_eq!(loaded.authority_epoch, 2);
    assert_eq!(loaded.state["food"], 1);
    assert!(!instance.dirty);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn schema_mismatch_is_rejected() {
    let root = temp_root("schema");
    let mut instance = instance();
    save_at(&root, &mut instance, false).expect("save");
    let error = load_at(&root, "demo.game", 2).expect_err("must fail");
    assert_eq!(error.code, codes::STATE_INCOMPATIBLE);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn corrupt_state_falls_back_to_backup() {
    let root = temp_root("backup");
    let mut instance = instance();
    instance.revision = 3;
    save_at(&root, &mut instance, true).expect("save with backup");
    let dir = root.join("demo.game").join(&instance.instance_id);
    std::fs::write(dir.join(STATE_FILE), b"{not json").expect("corrupt");
    let loaded = load_at(&root, "demo.game", 1)
      .expect("load")
      .expect("backup fallback");
    assert_eq!(loaded.revision, 3);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn backups_rotate_to_three() {
    let root = temp_root("rotate");
    let mut instance = instance();
    for revision in 1..=6 {
      instance.revision = revision;
      instance.dirty = true;
      save_at(&root, &mut instance, true).expect("save");
    }
    let backup_dir = root
      .join("demo.game")
      .join(&instance.instance_id)
      .join(BACKUP_DIR);
    let count = std::fs::read_dir(&backup_dir).expect("backup dir").count();
    assert_eq!(count, BACKUP_KEEP);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn stale_metadata_can_be_marked_interrupted() {
    let root = temp_root("interrupted");
    let mut instance = instance();
    save_at(&root, &mut instance, false).expect("save");
    let dir = root.join("demo.game").join(&instance.instance_id);
    let mut metadata: InstanceMetadata =
      serde_json::from_str(&std::fs::read_to_string(dir.join(METADATA_FILE)).expect("read"))
        .expect("parse");
    assert_eq!(metadata.status, "running");
    metadata.status = "interrupted".to_string();
    let json = serde_json::to_vec_pretty(&metadata).expect("serialize");
    write_atomic(&dir.join(METADATA_FILE), &json).expect("write");
    let metadata: InstanceMetadata =
      serde_json::from_str(&std::fs::read_to_string(dir.join(METADATA_FILE)).expect("read"))
        .expect("parse");
    assert_eq!(metadata.status, "interrupted");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn delete_at_removes_all_instances_and_keeps_other_games() {
    let root = temp_root("delete-game");
    let mut first = instance();
    first.instance_id = "0192f3a0000000000000000000000002".into();
    save_at(&root, &mut first, true).expect("save first");
    let mut second = instance();
    second.instance_id = "0192f3a0000000000000000000000003".into();
    save_at(&root, &mut second, true).expect("save second");

    let mut other = instance();
    other.game_id = "other.game".into();
    other.instance_id = "0192f3a0000000000000000000000004".into();
    save_at(&root, &mut other, false).expect("save other");

    assert!(root.join("demo.game").is_dir());
    assert!(root.join("other.game").is_dir());
    delete_at(&root, "demo.game").expect("delete game data");
    assert!(!root.join("demo.game").exists());
    assert!(root.join("other.game").is_dir());

    let _ = std::fs::remove_dir_all(&root);
  }
}
