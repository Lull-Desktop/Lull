//! 提交 journal（诊断用，不参与恢复或重放）。
//!
//! 每次成功提交追加一行 NDJSON，只记录 revision/epoch/模拟时间/事件类型，
//! 不记录 state 与事件 payload；文件超过上限时保留最近若干行。
//! 恢复仍只读 `state.json`，journal 损坏不会影响游戏启动。

use std::io::Write;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use super::error::{codes, GameError, GameResult};
use super::protocol::{GameEvent, GameSnapshot};
use super::repository;

const JOURNAL_FILE: &str = "journal.ndjson";
const MAX_BYTES: u64 = 512 * 1024;
const KEEP_LINES: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry<'a> {
  revision: u64,
  authority_epoch: u32,
  simulation_time_ms: u64,
  committed_at: u64,
  event_types: Vec<&'a str>,
}

/// 追加一条提交记录；失败由调用方忽略（journal 不影响提交结果）。
pub fn append(
  app: &AppHandle,
  snapshot: &GameSnapshot,
  events: &[GameEvent],
  now: u64,
) -> GameResult<()> {
  let root = repository::data_root(app).map_err(|error| GameError::new(codes::IO_ERROR, error))?;
  append_at(
    &root,
    &snapshot.game_id,
    &snapshot.instance_id,
    snapshot.revision,
    snapshot.authority_epoch,
    snapshot.simulation_time_ms,
    events,
    now,
    MAX_BYTES,
  )
}

#[allow(clippy::too_many_arguments)]
fn append_at(
  root: &Path,
  game_id: &str,
  instance_id: &str,
  revision: u64,
  authority_epoch: u32,
  simulation_time_ms: u64,
  events: &[GameEvent],
  now: u64,
  max_bytes: u64,
) -> GameResult<()> {
  let dir = repository::game_dir(root, game_id).join(instance_id);
  std::fs::create_dir_all(&dir)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("创建 journal 目录失败：{error}")))?;
  let path = dir.join(JOURNAL_FILE);
  let entry = JournalEntry {
    revision,
    authority_epoch,
    simulation_time_ms,
    committed_at: now,
    event_types: events.iter().map(|event| event.kind.as_str()).collect(),
  };
  let mut line = serde_json::to_vec(&entry)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("序列化 journal 失败：{error}")))?;
  line.push(b'\n');
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("打开 journal 失败：{error}")))?;
  file
    .write_all(&line)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("写 journal 失败：{error}")))?;
  drop(file);

  if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > max_bytes {
    trim(&path)?;
  }
  Ok(())
}

fn trim(path: &Path) -> GameResult<()> {
  let text = std::fs::read_to_string(path)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("读取 journal 失败：{error}")))?;
  let mut lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
  let start = lines.len().saturating_sub(KEEP_LINES);
  lines.drain(..start);
  let mut kept = lines.join("\n");
  kept.push('\n');
  write_atomic(path, kept.as_bytes())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> GameResult<()> {
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, bytes).map_err(|error| {
    GameError::new(codes::IO_ERROR, format!("写 journal 临时文件失败：{error}"))
  })?;
  if path.exists() {
    let _ = std::fs::remove_file(path);
  }
  std::fs::rename(&temp, path)
    .map_err(|error| GameError::new(codes::IO_ERROR, format!("替换 journal 失败：{error}")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::game::protocol::PROTOCOL_VERSION;
  use serde_json::json;
  use std::path::PathBuf;

  fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "lull-game-journal-{name}-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp root");
    dir
  }

  fn event(kind: &str) -> GameEvent {
    GameEvent {
      protocol: PROTOCOL_VERSION,
      game_id: "demo.game".into(),
      instance_id: "i1".into(),
      event_id: "e1".into(),
      revision: 1,
      authority_epoch: 1,
      kind: kind.into(),
      payload: json!({}),
      simulation_time_ms: 0,
    }
  }

  #[test]
  fn appends_one_line_per_commit_without_payload() {
    let root = temp_root("append");
    append_at(
      &root,
      "demo.game",
      "i1",
      1,
      1,
      0,
      &[event("world.changed")],
      1_000,
      u64::MAX,
    )
    .expect("append");
    let text = std::fs::read_to_string(root.join("demo.game").join("i1").join(JOURNAL_FILE))
      .expect("journal");
    assert_eq!(text.lines().count(), 1);
    assert!(text.contains("\"revision\":1"));
    assert!(text.contains("world.changed"));
    assert!(!text.contains("payload"));
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn trims_to_recent_lines_when_over_limit() {
    let root = temp_root("trim");
    for revision in 1..=300 {
      append_at(
        &root,
        "demo.game",
        "i1",
        revision,
        1,
        0,
        &[],
        1_000 + revision,
        200,
      )
      .expect("append");
    }
    let text = std::fs::read_to_string(root.join("demo.game").join("i1").join(JOURNAL_FILE))
      .expect("journal");
    let lines = text.lines().count();
    assert_eq!(lines, KEEP_LINES);
    let _ = std::fs::remove_dir_all(root);
  }
}
