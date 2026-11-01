//! P4 智能歌单：保存规则快照，读取时按规则重新查询曲目。

use serde_json::Value;
use sqlx::{FromRow, SqlitePool};

use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

#[derive(Debug, Clone, FromRow)]
pub struct SmartPlaylistRow {
  pub id: String,
  pub name: String,
  pub description: Option<String>,
  pub rules_json: String,
  pub created_at: i64,
  pub updated_at: i64,
}

fn validate(name: &str, description: Option<&str>, rules: &Value) -> Result<(), MediaError> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 80 {
    return Err(MediaError::invalid("智能歌单名称长度必须为 1–80"));
  }
  if description.is_some_and(|value| value.len() > 2048) {
    return Err(MediaError::invalid("智能歌单描述不能超过 2 KB"));
  }
  if !rules.is_object() {
    return Err(MediaError::invalid("智能歌单规则必须是对象"));
  }
  Ok(())
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<SmartPlaylistRow>, MediaError> {
  sqlx::query_as::<_, SmartPlaylistRow>(
    "SELECT id, name, description, rules_json, created_at, updated_at \
     FROM music_smart_playlists ORDER BY updated_at DESC, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取智能歌单失败：{error}")))
}

pub async fn get(
  pool: &SqlitePool,
  playlist_id: &str,
) -> Result<Option<SmartPlaylistRow>, MediaError> {
  sqlx::query_as::<_, SmartPlaylistRow>(
    "SELECT id, name, description, rules_json, created_at, updated_at \
     FROM music_smart_playlists WHERE id = ?",
  )
  .bind(playlist_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取智能歌单失败：{error}")))
}

pub async fn create(
  pool: &SqlitePool,
  name: &str,
  description: Option<&str>,
  rules: &Value,
) -> Result<SmartPlaylistRow, MediaError> {
  validate(name, description, rules)?;
  let id = crate::media::repository::new_id("smart");
  let now = now_ms();
  let rules_json = serde_json::to_string(rules)
    .map_err(|error| MediaError::internal(format!("序列化智能歌单规则失败：{error}")))?;
  sqlx::query(
    "INSERT INTO music_smart_playlists \
     (id, name, description, rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(name.trim())
  .bind(description)
  .bind(rules_json)
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建智能歌单失败：{error}")))?;
  get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::internal("创建智能歌单后读取失败"))
}

pub async fn update(
  pool: &SqlitePool,
  playlist_id: &str,
  name: &str,
  description: Option<&str>,
  rules: &Value,
) -> Result<SmartPlaylistRow, MediaError> {
  validate(name, description, rules)?;
  let rules_json = serde_json::to_string(rules)
    .map_err(|error| MediaError::internal(format!("序列化智能歌单规则失败：{error}")))?;
  let changed = sqlx::query(
    "UPDATE music_smart_playlists SET name = ?, description = ?, rules_json = ?, updated_at = ? \
     WHERE id = ?",
  )
  .bind(name.trim())
  .bind(description)
  .bind(rules_json)
  .bind(now_ms())
  .bind(playlist_id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新智能歌单失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("smart.not-found", "智能歌单不存在"));
  }
  get(pool, playlist_id)
    .await?
    .ok_or_else(|| MediaError::internal("更新智能歌单后读取失败"))
}

pub async fn delete(pool: &SqlitePool, playlist_id: &str) -> Result<(), MediaError> {
  let changed = sqlx::query("DELETE FROM music_smart_playlists WHERE id = ?")
    .bind(playlist_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除智能歌单失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("smart.not-found", "智能歌单不存在"));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn smart_playlist_crud_keeps_rules() {
    let dir = std::env::temp_dir().join(format!("lull-smart-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).expect("create dir");
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&dir.join("music.db"))
        .await
        .expect("open db");
      let rules = serde_json::json!({ "genre": "Ambient", "favoriteOnly": true });
      let created = create(&pool, "收藏氛围", Some("测试"), &rules)
        .await
        .expect("create");
      assert_eq!(created.name, "收藏氛围");
      let listed = list(&pool).await.expect("list");
      assert_eq!(listed.len(), 1);
      let updated = update(
        &pool,
        &created.id,
        "夜间氛围",
        None,
        &serde_json::json!({ "yearFrom": 2000 }),
      )
      .await
      .expect("update");
      assert_eq!(updated.name, "夜间氛围");
      assert!(updated.description.is_none());
      delete(&pool, &created.id).await.expect("delete");
      assert!(list(&pool).await.expect("list").is_empty());
    });
  }
}
