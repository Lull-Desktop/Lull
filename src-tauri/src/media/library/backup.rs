//! P6 备份：只导出组织数据（歌单/喜欢/历史/标签/智能歌单），不含音频、路径或资产内容。

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};
use tauri::AppHandle;

use crate::media::api::errors::MediaError;
use crate::media::library::{events, pool};
use crate::media::repository::artists::normalize_name;
use crate::media::repository::{new_id, now_ms};

const KIND: &str = "lull-music-backup";
const VERSION: u32 = 1;
const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
  pub playlists: usize,
  pub favorites: usize,
  pub history: usize,
  pub tags: usize,
  pub smart_playlists: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
  schema_version: u32,
  #[serde(rename = "type")]
  kind: String,
  exported_at: i64,
  playlists: Vec<BackupPlaylist>,
  favorites: Vec<String>,
  history: Vec<BackupHistory>,
  tags: Vec<BackupTag>,
  smart_playlists: Vec<BackupSmart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPlaylist {
  name: String,
  #[serde(default)]
  description: Option<String>,
  #[serde(default)]
  track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupHistory {
  id: String,
  track_id: String,
  played_at: i64,
  #[serde(default)]
  duration_ms: Option<i64>,
  #[serde(default)]
  completed: bool,
  #[serde(default = "play_source")]
  source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTag {
  name: String,
  #[serde(default)]
  track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupSmart {
  name: String,
  #[serde(default)]
  description: Option<String>,
  rules: serde_json::Value,
}

fn play_source() -> String {
  "play".to_string()
}

pub async fn call(
  app: &AppHandle,
  method: &str,
  _args: &serde_json::Value,
) -> Result<serde_json::Value, MediaError> {
  match method {
    "exportBackup" => {
      let path = dialog(false).await?;
      let Some(path) = path else {
        return Ok(serde_json::Value::Null);
      };
      Ok(serde_json::json!(export_to(&path).await?))
    }
    "importBackup" => {
      let path = dialog(true).await?;
      let Some(path) = path else {
        return Ok(serde_json::Value::Null);
      };
      let counts = import_from(&path).await?;
      events::changed(app);
      Ok(serde_json::json!(counts))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的备份方法：{method}"),
    )),
  }
}

async fn dialog(pick: bool) -> Result<Option<std::path::PathBuf>, MediaError> {
  tauri::async_runtime::spawn_blocking(move || {
    let dialog = rfd::FileDialog::new()
      .set_title(if pick {
        "导入音乐库备份"
      } else {
        "导出音乐库备份"
      })
      .add_filter("Lull 音乐备份", &["json"]);
    if pick {
      dialog.pick_file()
    } else {
      dialog.set_file_name("lull-music-backup.json").save_file()
    }
  })
  .await
  .map_err(|error| MediaError::internal(format!("打开备份对话框失败：{error}")))
}

async fn export_to(path: &Path) -> Result<BackupCounts, MediaError> {
  let backup = build(pool()?).await?;
  let bytes = serde_json::to_vec_pretty(&backup)
    .map_err(|error| MediaError::internal(format!("序列化备份失败：{error}")))?;
  if bytes.len() as u64 > MAX_BYTES {
    return Err(MediaError::invalid("备份超过 32 MB"));
  }
  std::fs::write(path, bytes)
    .map_err(|error| MediaError::internal(format!("写入备份失败：{error}")))?;
  Ok(BackupCounts {
    playlists: backup.playlists.len(),
    favorites: backup.favorites.len(),
    history: backup.history.len(),
    tags: backup.tags.len(),
    smart_playlists: backup.smart_playlists.len(),
  })
}

async fn build(pool: &SqlitePool) -> Result<Backup, MediaError> {
  let playlists: Vec<(String, String, Option<String>)> = sqlx::query_as(
    "SELECT id, name, description FROM music_playlists ORDER BY name COLLATE NOCASE, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取歌单失败：{error}")))?;
  let mut backup_playlists = Vec::new();
  for (id, name, description) in playlists {
    let track_ids = sqlx::query_scalar(
      "SELECT track_id FROM music_playlist_tracks WHERE playlist_id = ? ORDER BY position, added_at",
    )
    .bind(&id)
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取歌单曲目失败：{error}")))?;
    backup_playlists.push(BackupPlaylist {
      name,
      description,
      track_ids,
    });
  }
  let favorites =
    sqlx::query_scalar("SELECT track_id FROM music_favorites ORDER BY created_at, track_id")
      .fetch_all(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取喜欢失败：{error}")))?;
  let history: Vec<(String, String, i64, Option<i64>, i64, String)> = sqlx::query_as(
    "SELECT id, track_id, played_at, duration_ms, completed, source \
     FROM music_play_history ORDER BY played_at DESC LIMIT 5000",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取历史失败：{error}")))?;
  let history = history
    .into_iter()
    .map(
      |(id, track_id, played_at, duration_ms, completed, source)| BackupHistory {
        id,
        track_id,
        played_at,
        duration_ms,
        completed: completed != 0,
        source,
      },
    )
    .collect();

  let tags: Vec<(String, String)> =
    sqlx::query_as("SELECT t.id, t.name FROM music_tags t ORDER BY t.name COLLATE NOCASE, t.id")
      .fetch_all(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取标签失败：{error}")))?;
  let mut backup_tags = Vec::new();
  for (id, name) in tags {
    let track_ids = sqlx::query_scalar(
      "SELECT track_id FROM music_track_tags WHERE tag_id = ? ORDER BY created_at, track_id",
    )
    .bind(&id)
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取标签曲目失败：{error}")))?;
    backup_tags.push(BackupTag { name, track_ids });
  }

  let smart: Vec<(String, Option<String>, String)> = sqlx::query_as(
    "SELECT name, description, rules_json FROM music_smart_playlists \
     ORDER BY name COLLATE NOCASE, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取智能歌单失败：{error}")))?;
  let smart_playlists = smart
    .into_iter()
    .map(|(name, description, rules)| BackupSmart {
      name,
      description,
      rules: serde_json::from_str(&rules).unwrap_or_else(|_| serde_json::json!({})),
    })
    .collect();

  Ok(Backup {
    schema_version: VERSION,
    kind: KIND.to_string(),
    exported_at: now_ms(),
    playlists: backup_playlists,
    favorites,
    history,
    tags: backup_tags,
    smart_playlists,
  })
}

async fn import_from(path: &Path) -> Result<BackupCounts, MediaError> {
  let size = std::fs::metadata(path)
    .map_err(|error| MediaError::internal(format!("读取备份失败：{error}")))?
    .len();
  if size > MAX_BYTES {
    return Err(MediaError::invalid("备份超过 32 MB"));
  }
  let bytes =
    std::fs::read(path).map_err(|error| MediaError::internal(format!("读取备份失败：{error}")))?;
  let backup: Backup = serde_json::from_slice(&bytes)
    .map_err(|error| MediaError::invalid(format!("备份 JSON 无效：{error}")))?;
  if backup.kind != KIND || backup.schema_version != VERSION {
    return Err(MediaError::invalid("不支持的备份类型或版本"));
  }
  import_backup(pool()?, backup).await
}

async fn exists(tx: &mut Transaction<'_, Sqlite>, track_id: &str) -> Result<bool, MediaError> {
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks WHERE id = ?")
    .bind(track_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| MediaError::internal(format!("检查曲目失败：{error}")))?;
  Ok(count > 0)
}

async fn import_backup(pool: &SqlitePool, backup: Backup) -> Result<BackupCounts, MediaError> {
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启备份导入事务失败：{error}")))?;
  let now = now_ms();
  let mut counts = BackupCounts {
    playlists: 0,
    favorites: 0,
    history: 0,
    tags: 0,
    smart_playlists: 0,
  };

  for playlist in backup.playlists {
    let name = playlist.name.trim();
    if name.is_empty() {
      continue;
    }
    let existing: Option<String> =
      sqlx::query_scalar("SELECT id FROM music_playlists WHERE name = ? COLLATE NOCASE LIMIT 1")
        .bind(name)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("查询歌单失败：{error}")))?;
    let playlist_id = match existing {
      Some(id) => id,
      None => {
        let id = new_id("playlist");
        sqlx::query(
          "INSERT INTO music_playlists (id, name, description, created_at, updated_at) \
           VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(playlist.description.as_deref())
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("创建备份歌单失败：{error}")))?;
        id
      }
    };
    let mut position: i64 = sqlx::query_scalar(
      "SELECT COALESCE(MAX(position), 0) FROM music_playlist_tracks WHERE playlist_id = ?",
    )
    .bind(&playlist_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("读取歌单位置失败：{error}")))?;
    for track_id in playlist.track_ids {
      if !exists(&mut tx, &track_id).await? {
        continue;
      }
      position += 1;
      sqlx::query(
        "INSERT OR IGNORE INTO music_playlist_tracks \
         (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)",
      )
      .bind(&playlist_id)
      .bind(&track_id)
      .bind(position)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("导入歌单曲目失败：{error}")))?;
    }
    counts.playlists += 1;
  }

  for track_id in backup.favorites {
    if !exists(&mut tx, &track_id).await? {
      continue;
    }
    let inserted =
      sqlx::query("INSERT OR IGNORE INTO music_favorites (track_id, created_at) VALUES (?, ?)")
        .bind(&track_id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("导入喜欢失败：{error}")))?;
    counts.favorites += usize::try_from(inserted.rows_affected()).unwrap_or(0);
  }

  for entry in backup.history {
    if !exists(&mut tx, &entry.track_id).await? {
      continue;
    }
    let inserted = sqlx::query(
      "INSERT OR IGNORE INTO music_play_history \
       (id, track_id, played_at, duration_ms, completed, source) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&entry.id)
    .bind(&entry.track_id)
    .bind(entry.played_at)
    .bind(entry.duration_ms)
    .bind(i64::from(entry.completed))
    .bind(&entry.source)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("导入历史失败：{error}")))?;
    counts.history += usize::try_from(inserted.rows_affected()).unwrap_or(0);
  }

  for tag in backup.tags {
    let name = tag.name.trim();
    if name.is_empty() {
      continue;
    }
    let normalized = normalize_name(name);
    let tag_id: Option<String> =
      sqlx::query_scalar("SELECT id FROM music_tags WHERE normalized_name = ?")
        .bind(&normalized)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("查询标签失败：{error}")))?;
    let tag_id = match tag_id {
      Some(id) => id,
      None => {
        let id = new_id("tag");
        sqlx::query(
          "INSERT INTO music_tags (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(&normalized)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("创建备份标签失败：{error}")))?;
        id
      }
    };
    for track_id in tag.track_ids {
      if !exists(&mut tx, &track_id).await? {
        continue;
      }
      sqlx::query(
        "INSERT OR IGNORE INTO music_track_tags (track_id, tag_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(&track_id)
      .bind(&tag_id)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("导入标签关联失败：{error}")))?;
    }
    counts.tags += 1;
  }

  for smart in backup.smart_playlists {
    let name = smart.name.trim();
    if name.is_empty() {
      continue;
    }
    let exists: Option<String> = sqlx::query_scalar(
      "SELECT id FROM music_smart_playlists WHERE name = ? COLLATE NOCASE LIMIT 1",
    )
    .bind(name)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("查询智能歌单失败：{error}")))?;
    if exists.is_none() {
      let rules = serde_json::to_string(&smart.rules)
        .map_err(|error| MediaError::internal(format!("序列化智能歌单失败：{error}")))?;
      sqlx::query(
        "INSERT INTO music_smart_playlists \
         (id, name, description, rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(new_id("smart"))
      .bind(name)
      .bind(smart.description.as_deref())
      .bind(rules)
      .bind(now)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("创建备份智能歌单失败：{error}")))?;
      counts.smart_playlists += 1;
    }
  }

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交备份导入失败：{error}")))?;
  Ok(counts)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  async fn seed_track(pool: &SqlitePool, id: &str) {
    sqlx::query(
      "INSERT INTO music_tracks (id, kind, title, status, added_at, updated_at) \
       VALUES (?, 'file', ?, 'active', 1, 1)",
    )
    .bind(id)
    .bind(id)
    .execute(pool)
    .await
    .expect("insert track");
  }

  #[test]
  fn backup_roundtrip_keeps_organization() {
    let dir = std::env::temp_dir().join(format!("lull-backup-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).expect("create dir");
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&dir.join("music.db")).await.expect("open db");
      seed_track(&pool, "trk_backup_a").await;
      seed_track(&pool, "trk_backup_b").await;
      sqlx::query(
        "INSERT INTO music_playlists (id, name, description, created_at, updated_at) \
         VALUES ('pl_backup', '夜航', '测试', 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("playlist");
      sqlx::query(
        "INSERT INTO music_playlist_tracks (playlist_id, track_id, position, added_at) \
         VALUES ('pl_backup', 'trk_backup_a', 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("playlist track");
      sqlx::query("INSERT INTO music_favorites (track_id, created_at) VALUES ('trk_backup_b', 1)")
        .execute(&pool)
        .await
        .expect("favorite");
      sqlx::query(
        "INSERT INTO music_tags (id, name, normalized_name, created_at) \
         VALUES ('tag_backup', '夜间', '夜间', 1)",
      )
      .execute(&pool)
      .await
      .expect("tag");
      sqlx::query(
        "INSERT INTO music_track_tags (track_id, tag_id, created_at) \
         VALUES ('trk_backup_a', 'tag_backup', 1)",
      )
      .execute(&pool)
      .await
      .expect("track tag");
      let backup = build(&pool).await.expect("build");
      assert_eq!(backup.playlists.len(), 1);
      assert_eq!(backup.favorites.len(), 1);
      assert_eq!(backup.tags.len(), 1);
      let counts = import_backup(&pool, backup).await.expect("import");
      assert_eq!(counts.playlists, 1);
      assert_eq!(counts.favorites, 0);
      assert_eq!(counts.tags, 1);
    });
  }
}
