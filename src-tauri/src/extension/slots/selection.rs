//! 用户功能选择：`widgets/.slots.json`。
//!
//! 只持久化 Selected；Active 由运行时窗口推导，不落盘。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const FILE_NAME: &str = ".slots.json";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SelectionFile {
  #[serde(default = "version")]
  pub version: u32,
  /// slot id -> extension id。未知 slot 原样保留，便于降级/升级兼容。
  #[serde(default)]
  pub slots: BTreeMap<String, String>,
}

fn version() -> u32 {
  VERSION
}

impl Default for SelectionFile {
  fn default() -> Self {
    Self {
      version: VERSION,
      slots: BTreeMap::new(),
    }
  }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(crate::widget_package::store::root(app)?.join(FILE_NAME))
}

fn load_at(path: &Path) -> SelectionFile {
  let Ok(text) = std::fs::read_to_string(path) else {
    return SelectionFile::default();
  };
  let mut file = serde_json::from_str(&text).unwrap_or_else(|error| {
    eprintln!("[slots] 读取 {} 失败：{error}", path.display());
    SelectionFile::default()
  });
  // 手工编辑可能写出空字符串；按“未选择”处理。
  file.slots.retain(|_, value| !value.is_empty());
  file
}

pub fn load(app: &AppHandle) -> SelectionFile {
  match path(app) {
    Ok(path) => load_at(&path),
    Err(error) => {
      eprintln!("[slots] 定位 .slots.json 失败：{error}");
      SelectionFile::default()
    }
  }
}

fn save_at(path: &Path, file: &SelectionFile) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, json).map_err(|error| error.to_string())?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

pub fn save(app: &AppHandle, file: &SelectionFile) -> Result<(), String> {
  save_at(&path(app)?, file)
}

#[must_use]
pub fn selected(app: &AppHandle, slot: &str) -> Option<String> {
  load(app).slots.get(slot).cloned()
}

pub fn set_selected(app: &AppHandle, slot: &str, id: Option<&str>) -> Result<(), String> {
  let mut file = load(app);
  match id {
    Some(id) if !id.is_empty() => {
      file.slots.insert(slot.to_string(), id.to_string());
    }
    _ => {
      file.slots.remove(slot);
    }
  }
  save(app, &file)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_path(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "lull-slots-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    let _ = std::fs::create_dir_all(&dir);
    dir.join(FILE_NAME)
  }

  #[test]
  fn save_and_load_round_trip() {
    let path = temp_path("roundtrip");
    let mut file = SelectionFile::default();
    file
      .slots
      .insert("music-player".to_string(), "player".to_string());
    assert!(save_at(&path, &file).is_ok());
    let loaded = load_at(&path);
    assert_eq!(
      loaded.slots.get("music-player").map(String::as_str),
      Some("player")
    );
    let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
  }

  #[test]
  fn corrupt_file_falls_back_to_default() {
    let path = temp_path("corrupt");
    if std::fs::write(&path, "{not json").is_err() {
      return;
    }
    let loaded = load_at(&path);
    assert_eq!(loaded.version, VERSION);
    assert!(loaded.slots.is_empty());
    let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
  }

  #[test]
  fn unknown_slots_are_preserved() {
    let path = temp_path("unknown");
    if std::fs::write(
      &path,
      r#"{"version":1,"slots":{"future-slot":"future-ext","music-player":"player"}}"#,
    )
    .is_err()
    {
      return;
    }
    let loaded = load_at(&path);
    assert_eq!(
      loaded.slots.get("future-slot").map(String::as_str),
      Some("future-ext")
    );
    assert!(save_at(&path, &loaded).is_ok());
    let again = load_at(&path);
    assert_eq!(
      again.slots.get("future-slot").map(String::as_str),
      Some("future-ext")
    );
    let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
  }
}
