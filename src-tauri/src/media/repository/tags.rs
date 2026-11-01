//! P4 标签：用户标签 CRUD 与 Track 关联。
//!
//! 标签是跨来源的稳定实体；重扫不会删除标签关联，删除 Track 由 FK 级联。

use sqlx::{FromRow, SqlitePool};

use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

#[derive(Debug, Clone, FromRow)]
pub struct TagRow {
  pub id: String,
  pub name: String,
  pub track_count: i64,
}

fn normalize(name: &str) -> String {
  name.trim().to_lowercase()
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<TagRow>, MediaError> {
  sqlx::query_as::<_, TagRow>(
    "SELECT t.id, t.name, COUNT(mtt.track_id) AS track_count \
     FROM music_tags t LEFT JOIN music_track_tags mtt ON mtt.tag_id = t.id \
     GROUP BY t.id, t.name ORDER BY t.name COLLATE NOCASE",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取标签失败：{error}")))
}

pub async fn get(pool: &SqlitePool, tag_id: &str) -> Result<Option<TagRow>, MediaError> {
  sqlx::query_as::<_, TagRow>(
    "SELECT t.id, t.name, COUNT(mtt.track_id) AS track_count \
     FROM music_tags t LEFT JOIN music_track_tags mtt ON mtt.tag_id = t.id \
     WHERE t.id = ? GROUP BY t.id, t.name",
  )
  .bind(tag_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取标签失败：{error}")))
}

pub async fn create(pool: &SqlitePool, name: &str) -> Result<TagRow, MediaError> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 40 {
    return Err(MediaError::invalid("标签名称长度必须为 1–40"));
  }
  let normalized = normalize(name);
  if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM music_tags WHERE normalized_name = ?")
    .bind(&normalized)
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("检查标签失败：{error}")))?
    > 0
  {
    return Err(MediaError::new("tag.exists", "同名标签已存在"));
  }
  let id = crate::media::repository::new_id("tag");
  sqlx::query("INSERT INTO music_tags (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(&id)
    .bind(name)
    .bind(&normalized)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("创建标签失败：{error}")))?;
  get(pool, &id)
    .await?
    .ok_or_else(|| MediaError::internal("创建标签后读取失败"))
}

pub async fn rename(pool: &SqlitePool, tag_id: &str, name: &str) -> Result<TagRow, MediaError> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 40 {
    return Err(MediaError::invalid("标签名称长度必须为 1–40"));
  }
  let normalized = normalize(name);
  let exists: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM music_tags WHERE normalized_name = ? AND id != ?")
      .bind(&normalized)
      .bind(tag_id)
      .fetch_one(pool)
      .await
      .map_err(|error| MediaError::internal(format!("检查标签失败：{error}")))?;
  if exists > 0 {
    return Err(MediaError::new("tag.exists", "同名标签已存在"));
  }
  let changed = sqlx::query("UPDATE music_tags SET name = ?, normalized_name = ? WHERE id = ?")
    .bind(name)
    .bind(&normalized)
    .bind(tag_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("更新标签失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("tag.not-found", "标签不存在"));
  }
  get(pool, tag_id)
    .await?
    .ok_or_else(|| MediaError::internal("更新标签后读取失败"))
}

pub async fn delete(pool: &SqlitePool, tag_id: &str) -> Result<(), MediaError> {
  let changed = sqlx::query("DELETE FROM music_tags WHERE id = ?")
    .bind(tag_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除标签失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("tag.not-found", "标签不存在"));
  }
  Ok(())
}

pub async fn set_track_tags(
  pool: &SqlitePool,
  track_id: &str,
  tag_ids: &[String],
) -> Result<(), MediaError> {
  let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks WHERE id = ?")
    .bind(track_id)
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取曲目失败：{error}")))?;
  if exists == 0 {
    return Err(MediaError::new("track.not-found", "曲目不存在"));
  }
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启标签事务失败：{error}")))?;
  sqlx::query("DELETE FROM music_track_tags WHERE track_id = ?")
    .bind(track_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理曲目标签失败：{error}")))?;
  let now = now_ms();
  for tag_id in tag_ids {
    sqlx::query("INSERT INTO music_track_tags (track_id, tag_id, created_at) VALUES (?, ?, ?)")
      .bind(track_id)
      .bind(tag_id)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入曲目标签失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交标签事务失败：{error}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tag_crud_and_track_assignment() {
    let dir = std::env::temp_dir().join(format!("lull-tags-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).expect("create dir");
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&dir.join("music.db"))
        .await
        .expect("open db");
      sqlx::query(
        "INSERT INTO music_tracks (id, kind, title, status, added_at, updated_at) \
         VALUES ('trk_tag_test', 'file', 'Tagged', 'active', 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("insert track");

      let tag = create(&pool, "夜间").await.expect("create tag");
      assert_eq!(tag.track_count, 0);
      assert!(create(&pool, " 夜间 ").await.is_err());
      set_track_tags(&pool, "trk_tag_test", std::slice::from_ref(&tag.id))
        .await
        .expect("assign tag");
      let listed = list(&pool).await.expect("list tags");
      assert_eq!(listed.len(), 1);
      assert_eq!(listed[0].track_count, 1);

      let renamed = rename(&pool, &tag.id, "深夜").await.expect("rename");
      assert_eq!(renamed.name, "深夜");
      set_track_tags(&pool, "trk_tag_test", &[])
        .await
        .expect("clear tags");
      assert_eq!(list(&pool).await.expect("list")[0].track_count, 0);
      delete(&pool, &tag.id).await.expect("delete");
      assert!(list(&pool).await.expect("list").is_empty());
    });
  }
}
