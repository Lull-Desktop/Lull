//! Noise 域 SQLx 仓储：偏好、Asset 查询/导入/编辑/删除、分类/标签/收藏与
//! Preset 轨道读取。
//!
//! 文件系统复制与 hash 在 `assets.rs`；这里只处理数据库与公开查询条件。

use sqlx::{FromRow, SqlitePool};

use super::dto::{NoiseAssetQuery, NoisePresetQuery};
use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

#[derive(Debug, Clone, FromRow)]
pub struct PreferencesRow {
  pub master_volume: f64,
  pub muted: i64,
  #[allow(dead_code)]
  pub last_preset_id: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct AssetRow {
  pub id: String,
  pub name: String,
  pub media_kind: String,
  pub generator_json: Option<String>,
  pub storage_key: Option<String>,
  pub status: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct PresetTrackRow {
  pub asset_id: Option<String>,
  pub expected_name: String,
  pub volume: f64,
  pub enabled: i64,
  pub loop_: i64,
  pub fade_in_ms: Option<i64>,
  pub fade_out_ms: Option<i64>,
  pub asset_name: Option<String>,
  pub media_kind: Option<String>,
  pub generator_json: Option<String>,
  pub storage_key: Option<String>,
  pub asset_status: Option<String>,
}

pub async fn preferences(pool: &SqlitePool) -> Result<PreferencesRow, MediaError> {
  let row = sqlx::query_as::<_, PreferencesRow>(
    "SELECT master_volume, muted, last_preset_id FROM noise_preferences WHERE id = 1",
  )
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 偏好失败：{error}")))?;
  Ok(row.unwrap_or(PreferencesRow {
    master_volume: 0.75,
    muted: 0,
    last_preset_id: None,
  }))
}

pub async fn save_preferences(
  pool: &SqlitePool,
  master_volume: f64,
  muted: bool,
  last_preset_id: Option<&str>,
) -> Result<(), MediaError> {
  sqlx::query(
    "INSERT INTO noise_preferences (id, master_volume, muted, last_preset_id, updated_at) \
     VALUES (1, ?, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET master_volume = excluded.master_volume, \
       muted = excluded.muted, last_preset_id = excluded.last_preset_id, \
       updated_at = excluded.updated_at",
  )
  .bind(master_volume.clamp(0.0, 1.0))
  .bind(if muted { 1_i64 } else { 0_i64 })
  .bind(last_preset_id)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存 Noise 偏好失败：{error}")))?;
  Ok(())
}

pub async fn assets(pool: &SqlitePool) -> Result<Vec<AssetRow>, MediaError> {
  sqlx::query_as::<_, AssetRow>(
    "SELECT id, name, media_kind, generator_json, storage_key, status FROM noise_assets \
     ORDER BY created_at, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 素材失败：{error}")))
}

pub async fn asset(pool: &SqlitePool, asset_id: &str) -> Result<Option<AssetRow>, MediaError> {
  sqlx::query_as::<_, AssetRow>(
    "SELECT id, name, media_kind, generator_json, storage_key, status FROM noise_assets WHERE id = ?",
  )
  .bind(asset_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 素材失败：{error}")))
}

pub async fn preset_tracks(
  pool: &SqlitePool,
  preset_id: &str,
) -> Result<Vec<PresetTrackRow>, MediaError> {
  sqlx::query_as::<_, PresetTrackRow>(
    "SELECT pt.asset_id, pt.expected_name, pt.volume, pt.enabled, pt.loop AS loop_, \
       pt.fade_in_ms, pt.fade_out_ms, \
       a.name AS asset_name, a.media_kind, a.generator_json, a.storage_key, \
       a.status AS asset_status \
     FROM noise_preset_tracks pt \
     LEFT JOIN noise_assets a ON a.id = pt.asset_id \
     WHERE pt.preset_id = ? ORDER BY pt.sort_order, pt.id",
  )
  .bind(preset_id)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 预设轨道失败：{error}")))
}

#[derive(Debug, Clone, FromRow)]
pub struct AssetListRow {
  pub id: String,
  pub name: String,
  pub description: Option<String>,
  pub media_kind: String,
  pub format: String,
  pub size_bytes: i64,
  pub duration_ms: Option<i64>,
  pub sample_rate: Option<i64>,
  pub channels: Option<i64>,
  pub status: String,
  pub source_kind: String,
  pub category_id: Option<String>,
  pub category_name: Option<String>,
  pub capabilities_json: String,
  pub favorite: i64,
  pub tags_json: String,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct CategoryRow {
  pub id: String,
  pub name: String,
  pub parent_id: Option<String>,
  pub icon: Option<String>,
  pub sort_order: i64,
  pub asset_count: i64,
  pub source_type: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct TagRow {
  pub id: String,
  pub name: String,
  pub asset_count: i64,
  pub source_type: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct FileAssetRow {
  pub id: String,
  pub storage_key: Option<String>,
  pub status: String,
}

pub struct NewAsset<'a> {
  pub id: &'a str,
  pub source_id: &'a str,
  pub name: &'a str,
  pub description: Option<&'a str>,
  pub media_kind: &'a str,
  pub format: &'a str,
  pub storage_key: &'a str,
  pub size_bytes: i64,
  pub mtime_ms: Option<i64>,
  pub duration_ms: Option<i64>,
  pub sample_rate: Option<i64>,
  pub channels: Option<i64>,
  pub content_hash: &'a str,
  pub category_id: Option<&'a str>,
  pub capabilities_json: &'a str,
}

const ASSET_SELECT: &str = "SELECT a.id, a.name, a.description, a.media_kind, a.format, \
  a.size_bytes, a.duration_ms, a.sample_rate, a.channels, a.status, s.kind AS source_kind, \
  a.category_id, c.name AS category_name, a.capabilities_json, \
  CASE WHEN f.asset_id IS NOT NULL THEN 1 ELSE 0 END AS favorite, \
  COALESCE((SELECT json_group_array(json_object('id', t.id, 'name', t.name)) \
    FROM noise_asset_tags at JOIN noise_tags t ON t.id = at.tag_id \
    WHERE at.asset_id = a.id), '[]') AS tags_json, a.created_at, a.updated_at \
  FROM noise_assets a \
  JOIN noise_sources s ON s.id = a.source_id \
  LEFT JOIN noise_categories c ON c.id = a.category_id \
  LEFT JOIN noise_favorites f ON f.asset_id = a.id";

const ASSET_FILTER: &str = " WHERE (?1 IS NULL OR a.name LIKE ?1 OR a.description LIKE ?1 \
  OR c.name LIKE ?1 OR EXISTS (SELECT 1 FROM noise_asset_tags at \
    JOIN noise_tags t ON t.id = at.tag_id WHERE at.asset_id = a.id AND t.name LIKE ?1)) \
  AND (?2 IS NULL OR a.category_id = ?2) \
  AND (?3 IS NULL OR EXISTS (SELECT 1 FROM noise_asset_tags at \
    WHERE at.asset_id = a.id AND at.tag_id = ?3)) \
  AND (?4 = 0 OR f.asset_id IS NOT NULL) \
  AND (?5 IS NULL OR a.status = ?5) \
  AND (?6 IS NULL OR a.media_kind = ?6)";

fn order_clause(query: &NoiseAssetQuery) -> &'static str {
  let descending = query
    .sort_order
    .as_deref()
    .map(|value| value.eq_ignore_ascii_case("desc"))
    .unwrap_or(true);
  match query.sort_by.as_deref() {
    Some("name") if descending => " ORDER BY a.name COLLATE NOCASE DESC, a.id",
    Some("name") => " ORDER BY a.name COLLATE NOCASE ASC, a.id",
    Some("duration") if descending => {
      " ORDER BY (a.duration_ms IS NULL) ASC, a.duration_ms DESC, a.id"
    }
    Some("duration") => " ORDER BY (a.duration_ms IS NULL) ASC, a.duration_ms ASC, a.id",
    Some("updated_at") if descending => " ORDER BY a.updated_at DESC, a.id",
    Some("updated_at") => " ORDER BY a.updated_at ASC, a.id",
    _ if descending => " ORDER BY a.created_at DESC, a.id",
    _ => " ORDER BY a.created_at ASC, a.id",
  }
}

impl NoiseAssetQuery {
  fn keyword_pattern(&self) -> Option<String> {
    self
      .keyword
      .as_deref()
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(|value| format!("%{value}%"))
  }
}

pub async fn list_assets(
  pool: &SqlitePool,
  query: &NoiseAssetQuery,
) -> Result<(Vec<AssetListRow>, i64), MediaError> {
  let keyword = query.keyword_pattern();
  let category = query.category_id.as_deref();
  let tag = query.tag_id.as_deref();
  let favorite = i64::from(query.favorite_only.unwrap_or(false));
  let status = query.status.as_deref();
  let media_kind = query.media_kind.as_deref();
  let total: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) FROM noise_assets a \
     JOIN noise_sources s ON s.id = a.source_id \
     LEFT JOIN noise_categories c ON c.id = a.category_id \
     LEFT JOIN noise_favorites f ON f.asset_id = a.id{ASSET_FILTER}"
  ))
  .bind(keyword.as_deref())
  .bind(category)
  .bind(tag)
  .bind(favorite)
  .bind(status)
  .bind(media_kind)
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("统计 Noise 素材失败：{error}")))?;

  let page = query.page();
  let page_size = query.page_size();
  let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);
  let sql = format!(
    "{ASSET_SELECT}{ASSET_FILTER}{} LIMIT ?7 OFFSET ?8",
    order_clause(query)
  );
  let rows = sqlx::query_as::<_, AssetListRow>(&sql)
    .bind(keyword.as_deref())
    .bind(category)
    .bind(tag)
    .bind(favorite)
    .bind(status)
    .bind(media_kind)
    .bind(i64::from(page_size))
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 素材失败：{error}")))?;
  Ok((rows, total))
}

pub async fn asset_detail(
  pool: &SqlitePool,
  asset_id: &str,
) -> Result<Option<AssetListRow>, MediaError> {
  sqlx::query_as::<_, AssetListRow>(&format!("{ASSET_SELECT} WHERE a.id = ?"))
    .bind(asset_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 素材失败：{error}")))
}

pub async fn find_by_hash(
  pool: &SqlitePool,
  content_hash: &str,
) -> Result<Option<String>, MediaError> {
  sqlx::query_scalar("SELECT id FROM noise_assets WHERE content_hash = ? LIMIT 1")
    .bind(content_hash)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 素材 hash 失败：{error}")))
}

pub async fn ensure_local_source(pool: &SqlitePool) -> Result<String, MediaError> {
  let now = now_ms();
  sqlx::query(
    "INSERT INTO noise_sources (id, kind, name, status, created_at, updated_at) \
     VALUES ('noise_src_local', 'local', '本地导入', 'available', ?, ?) \
     ON CONFLICT(id) DO UPDATE SET status = 'available', updated_at = excluded.updated_at",
  )
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建 Noise 本地来源失败：{error}")))?;
  Ok("noise_src_local".to_string())
}

pub async fn insert_asset(
  pool: &SqlitePool,
  asset: &NewAsset<'_>,
  tag_ids: &[String],
) -> Result<(), MediaError> {
  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启 Noise 导入事务失败：{error}")))?;
  sqlx::query(
    "INSERT INTO noise_assets \
     (id, source_id, name, description, media_kind, format, storage_key, size_bytes, \
      mtime_ms, duration_ms, sample_rate, channels, content_hash, generator_json, \
      category_id, capabilities_json, status, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'available', ?, ?)",
  )
  .bind(asset.id)
  .bind(asset.source_id)
  .bind(asset.name)
  .bind(asset.description)
  .bind(asset.media_kind)
  .bind(asset.format)
  .bind(asset.storage_key)
  .bind(asset.size_bytes)
  .bind(asset.mtime_ms)
  .bind(asset.duration_ms)
  .bind(asset.sample_rate)
  .bind(asset.channels)
  .bind(asset.content_hash)
  .bind(asset.category_id)
  .bind(asset.capabilities_json)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入 Noise 素材失败：{error}")))?;
  for tag_id in tag_ids {
    sqlx::query(
      "INSERT INTO noise_asset_tags (asset_id, tag_id) VALUES (?, ?) \
       ON CONFLICT(asset_id, tag_id) DO NOTHING",
    )
    .bind(asset.id)
    .bind(tag_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 素材标签失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交 Noise 导入事务失败：{error}")))?;
  Ok(())
}

pub async fn update_asset_metadata(
  pool: &SqlitePool,
  asset_id: &str,
  name: &str,
  description: Option<&str>,
  category_id: Option<&str>,
  tag_ids: Option<&[String]>,
) -> Result<(), MediaError> {
  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启 Noise 素材事务失败：{error}")))?;
  let changed = sqlx::query(
    "UPDATE noise_assets SET name = ?, description = ?, category_id = ?, updated_at = ? \
     WHERE id = ?",
  )
  .bind(name)
  .bind(description)
  .bind(category_id)
  .bind(now)
  .bind(asset_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新 Noise 素材失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("noise.asset.not-found", "Noise 素材不存在"));
  }
  if let Some(tag_ids) = tag_ids {
    sqlx::query("DELETE FROM noise_asset_tags WHERE asset_id = ?")
      .bind(asset_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理 Noise 素材标签失败：{error}")))?;
    for tag_id in tag_ids {
      sqlx::query(
        "INSERT INTO noise_asset_tags (asset_id, tag_id) VALUES (?, ?) \
         ON CONFLICT(asset_id, tag_id) DO NOTHING",
      )
      .bind(asset_id)
      .bind(tag_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入 Noise 素材标签失败：{error}")))?;
    }
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交 Noise 素材事务失败：{error}")))?;
  Ok(())
}

pub async fn delete_asset(pool: &SqlitePool, asset_id: &str) -> Result<Option<String>, MediaError> {
  let storage_key: Option<String> =
    sqlx::query_scalar("SELECT storage_key FROM noise_assets WHERE id = ?")
      .bind(asset_id)
      .fetch_optional(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取 Noise 素材文件失败：{error}")))?
      .flatten();
  let changed = sqlx::query("DELETE FROM noise_assets WHERE id = ?")
    .bind(asset_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除 Noise 素材失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("noise.asset.not-found", "Noise 素材不存在"));
  }
  Ok(storage_key)
}

pub async fn set_favorite(
  pool: &SqlitePool,
  asset_id: &str,
  favorite: bool,
) -> Result<(), MediaError> {
  if favorite {
    sqlx::query(
      "INSERT INTO noise_favorites (asset_id, created_at) VALUES (?, ?) \
       ON CONFLICT(asset_id) DO NOTHING",
    )
    .bind(asset_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("收藏 Noise 素材失败：{error}")))?;
  } else {
    sqlx::query("DELETE FROM noise_favorites WHERE asset_id = ?")
      .bind(asset_id)
      .execute(pool)
      .await
      .map_err(|error| MediaError::internal(format!("取消收藏 Noise 素材失败：{error}")))?;
  }
  Ok(())
}

pub async fn categories(pool: &SqlitePool) -> Result<Vec<CategoryRow>, MediaError> {
  sqlx::query_as::<_, CategoryRow>(
    "SELECT c.id, c.name, c.parent_id, c.icon, c.sort_order, c.source_type, \
       COUNT(a.id) AS asset_count \
     FROM noise_categories c LEFT JOIN noise_assets a ON a.category_id = c.id \
     GROUP BY c.id, c.name, c.parent_id, c.icon, c.sort_order, c.source_type \
     ORDER BY c.sort_order, c.name COLLATE NOCASE",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 分类失败：{error}")))
}

pub async fn tags(pool: &SqlitePool) -> Result<Vec<TagRow>, MediaError> {
  sqlx::query_as::<_, TagRow>(
    "SELECT t.id, t.name, t.source_type, COUNT(at.asset_id) AS asset_count \
     FROM noise_tags t LEFT JOIN noise_asset_tags at ON at.tag_id = t.id \
     GROUP BY t.id, t.name, t.source_type ORDER BY t.name COLLATE NOCASE",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 标签失败：{error}")))
}

pub async fn file_assets(pool: &SqlitePool) -> Result<Vec<FileAssetRow>, MediaError> {
  sqlx::query_as::<_, FileAssetRow>(
    "SELECT id, storage_key, status FROM noise_assets WHERE media_kind = 'file' \
     ORDER BY created_at, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 文件素材失败：{error}")))
}

pub async fn set_status(pool: &SqlitePool, asset_id: &str, status: &str) -> Result<(), MediaError> {
  sqlx::query("UPDATE noise_assets SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status)
    .bind(now_ms())
    .bind(asset_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("更新 Noise 素材状态失败：{error}")))?;
  Ok(())
}

pub async fn tag_exists(pool: &SqlitePool, tag_id: &str) -> Result<bool, MediaError> {
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM noise_tags WHERE id = ?")
    .bind(tag_id)
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 标签失败：{error}")))?;
  Ok(count > 0)
}

pub async fn category_exists(pool: &SqlitePool, category_id: &str) -> Result<bool, MediaError> {
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM noise_categories WHERE id = ?")
    .bind(category_id)
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 分类失败：{error}")))?;
  Ok(count > 0)
}

pub async fn category(
  pool: &SqlitePool,
  category_id: &str,
) -> Result<Option<CategoryRow>, MediaError> {
  sqlx::query_as::<_, CategoryRow>(
    "SELECT c.id, c.name, c.parent_id, c.icon, c.sort_order, c.source_type, \
       (SELECT COUNT(*) FROM noise_assets a WHERE a.category_id = c.id) AS asset_count \
     FROM noise_categories c WHERE c.id = ?",
  )
  .bind(category_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 分类失败：{error}")))
}

pub async fn tag(pool: &SqlitePool, tag_id: &str) -> Result<Option<TagRow>, MediaError> {
  sqlx::query_as::<_, TagRow>(
    "SELECT t.id, t.name, t.source_type, \
       (SELECT COUNT(*) FROM noise_asset_tags at WHERE at.tag_id = t.id) AS asset_count \
     FROM noise_tags t WHERE t.id = ?",
  )
  .bind(tag_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 标签失败：{error}")))
}

pub async fn category_children_count(
  pool: &SqlitePool,
  category_id: &str,
) -> Result<i64, MediaError> {
  sqlx::query_scalar("SELECT COUNT(*) FROM noise_categories WHERE parent_id = ?")
    .bind(category_id)
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 子分类失败：{error}")))
}

pub async fn category_parent_id(
  pool: &SqlitePool,
  category_id: &str,
) -> Result<Option<String>, MediaError> {
  let parent: Option<Option<String>> =
    sqlx::query_scalar("SELECT parent_id FROM noise_categories WHERE id = ?")
      .bind(category_id)
      .fetch_optional(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取 Noise 父分类失败：{error}")))?;
  Ok(parent.flatten())
}

pub async fn category_name_exists(
  pool: &SqlitePool,
  name: &str,
  parent_id: Option<&str>,
  exclude_id: Option<&str>,
) -> Result<bool, MediaError> {
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM noise_categories \
     WHERE lower(name) = lower(?) \
       AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?) AND id != ?",
  )
  .bind(name)
  .bind(parent_id)
  .bind(parent_id)
  .bind(exclude_id.unwrap_or(""))
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("检查 Noise 分类名称失败：{error}")))?;
  Ok(count > 0)
}

pub async fn tag_name_exists(
  pool: &SqlitePool,
  normalized_name: &str,
  exclude_id: Option<&str>,
) -> Result<bool, MediaError> {
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM noise_tags \
     WHERE normalized_name = ? AND id != ?",
  )
  .bind(normalized_name)
  .bind(exclude_id.unwrap_or(""))
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("检查 Noise 标签名称失败：{error}")))?;
  Ok(count > 0)
}

pub async fn insert_category(
  pool: &SqlitePool,
  category_id: &str,
  name: &str,
  parent_id: Option<&str>,
  icon: Option<&str>,
  sort_order: i64,
) -> Result<(), MediaError> {
  sqlx::query(
    "INSERT INTO noise_categories \
     (id, name, parent_id, icon, source_type, sort_order, created_at) \
     VALUES (?, ?, ?, ?, 'user', ?, ?)",
  )
  .bind(category_id)
  .bind(name)
  .bind(parent_id)
  .bind(icon)
  .bind(sort_order)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建 Noise 分类失败：{error}")))?;
  Ok(())
}

pub async fn update_category(
  pool: &SqlitePool,
  category_id: &str,
  name: &str,
  parent_id: Option<&str>,
  icon: Option<&str>,
  sort_order: i64,
) -> Result<(), MediaError> {
  let changed = sqlx::query(
    "UPDATE noise_categories SET name = ?, parent_id = ?, icon = ?, sort_order = ? \
     WHERE id = ?",
  )
  .bind(name)
  .bind(parent_id)
  .bind(icon)
  .bind(sort_order)
  .bind(category_id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新 Noise 分类失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new(
      "noise.category.not-found",
      "Noise 分类不存在",
    ));
  }
  Ok(())
}

pub async fn delete_category(pool: &SqlitePool, category_id: &str) -> Result<(), MediaError> {
  let changed = sqlx::query("DELETE FROM noise_categories WHERE id = ?")
    .bind(category_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除 Noise 分类失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new(
      "noise.category.not-found",
      "Noise 分类不存在",
    ));
  }
  Ok(())
}

pub async fn insert_tag(
  pool: &SqlitePool,
  tag_id: &str,
  name: &str,
  normalized_name: &str,
) -> Result<(), MediaError> {
  sqlx::query(
    "INSERT INTO noise_tags (id, name, normalized_name, source_type, created_at) \
     VALUES (?, ?, ?, 'user', ?)",
  )
  .bind(tag_id)
  .bind(name)
  .bind(normalized_name)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建 Noise 标签失败：{error}")))?;
  Ok(())
}

pub async fn update_tag(
  pool: &SqlitePool,
  tag_id: &str,
  name: &str,
  normalized_name: &str,
) -> Result<(), MediaError> {
  let changed = sqlx::query("UPDATE noise_tags SET name = ?, normalized_name = ? WHERE id = ?")
    .bind(name)
    .bind(normalized_name)
    .bind(tag_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("更新 Noise 标签失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("noise.tag.not-found", "Noise 标签不存在"));
  }
  Ok(())
}

pub async fn delete_tag(pool: &SqlitePool, tag_id: &str) -> Result<(), MediaError> {
  let changed = sqlx::query("DELETE FROM noise_tags WHERE id = ?")
    .bind(tag_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除 Noise 标签失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new("noise.tag.not-found", "Noise 标签不存在"));
  }
  Ok(())
}

#[must_use]
pub fn normalize_tag_name(name: &str) -> String {
  name.trim().to_lowercase()
}

#[derive(Debug, Clone, FromRow)]
pub struct PresetRow {
  pub id: String,
  pub origin_id: Option<String>,
  pub name: String,
  pub description: Option<String>,
  pub source_type: String,
  pub author: Option<String>,
  pub schema_version: i64,
  pub master_volume: f64,
  pub cover_ref: Option<String>,
  pub favorite: i64,
  pub track_count: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct PresetTrackRecord {
  pub id: String,
  pub asset_id: Option<String>,
  pub asset_hash: Option<String>,
  pub asset_source_type: Option<String>,
  pub asset_source_id: Option<String>,
  pub expected_name: String,
  pub volume: f64,
  pub enabled: i64,
  pub loop_: i64,
  pub fade_in_ms: Option<i64>,
  pub fade_out_ms: Option<i64>,
  pub sort_order: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct AssetIdentityRow {
  pub content_hash: Option<String>,
  pub source_type: String,
  pub source_id: String,
}

pub struct NewPresetTrack {
  pub id: String,
  pub asset_id: Option<String>,
  pub asset_hash: Option<String>,
  pub asset_source_type: Option<String>,
  pub asset_source_id: Option<String>,
  pub expected_name: String,
  pub volume: f64,
  pub enabled: bool,
  pub loop_: bool,
  pub fade_in_ms: Option<i64>,
  pub fade_out_ms: Option<i64>,
  pub sort_order: i64,
}

pub struct NewPreset {
  pub id: String,
  pub origin_id: Option<String>,
  pub name: String,
  pub description: Option<String>,
  pub source_type: String,
  pub author: Option<String>,
  pub schema_version: i64,
  pub master_volume: f64,
  pub cover_ref: Option<String>,
  pub tracks: Vec<NewPresetTrack>,
}

const PRESET_SELECT: &str = "SELECT p.id, p.origin_id, p.name, p.description, p.source_type, \
  p.author, p.schema_version, p.master_volume, p.cover_ref, \
  CASE WHEN f.preset_id IS NOT NULL THEN 1 ELSE 0 END AS favorite, \
  (SELECT COUNT(*) FROM noise_preset_tracks pt WHERE pt.preset_id = p.id) AS track_count, \
  p.created_at, p.updated_at \
  FROM noise_presets p LEFT JOIN noise_preset_favorites f ON f.preset_id = p.id";

const PRESET_FILTER: &str = " WHERE (?1 IS NULL OR p.name LIKE ?1 OR p.description LIKE ?1) \
  AND (?2 IS NULL OR p.source_type = ?2) \
  AND (?3 = 0 OR f.preset_id IS NOT NULL)";

pub async fn list_presets(
  pool: &SqlitePool,
  query: &NoisePresetQuery,
) -> Result<(Vec<PresetRow>, i64), MediaError> {
  let keyword = query
    .keyword
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| format!("%{value}%"));
  let source = query.source_type.as_deref();
  let favorite = i64::from(query.favorite_only.unwrap_or(false));
  let total: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) FROM noise_presets p \
     LEFT JOIN noise_preset_favorites f ON f.preset_id = p.id{PRESET_FILTER}"
  ))
  .bind(keyword.as_deref())
  .bind(source)
  .bind(favorite)
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("统计 Noise 预设失败：{error}")))?;
  let page = query.page();
  let page_size = query.page_size();
  let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);
  let rows = sqlx::query_as::<_, PresetRow>(&format!(
    "{PRESET_SELECT}{PRESET_FILTER} \
     ORDER BY CASE p.source_type WHEN 'builtin' THEN 0 ELSE 1 END, \
       p.updated_at DESC, p.id LIMIT ?4 OFFSET ?5"
  ))
  .bind(keyword.as_deref())
  .bind(source)
  .bind(favorite)
  .bind(i64::from(page_size))
  .bind(offset)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 预设失败：{error}")))?;
  Ok((rows, total))
}

pub async fn preset(pool: &SqlitePool, preset_id: &str) -> Result<Option<PresetRow>, MediaError> {
  sqlx::query_as::<_, PresetRow>(&format!("{PRESET_SELECT} WHERE p.id = ?"))
    .bind(preset_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取 Noise 预设失败：{error}")))
}

pub async fn preset_records(
  pool: &SqlitePool,
  preset_id: &str,
) -> Result<Vec<PresetTrackRecord>, MediaError> {
  sqlx::query_as::<_, PresetTrackRecord>(
    "SELECT id, asset_id, asset_hash, asset_source_type, asset_source_id, expected_name, \
       volume, enabled, loop AS loop_, fade_in_ms, fade_out_ms, sort_order \
     FROM noise_preset_tracks WHERE preset_id = ? ORDER BY sort_order, id",
  )
  .bind(preset_id)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 预设轨道失败：{error}")))
}

pub async fn asset_identity(
  pool: &SqlitePool,
  asset_id: &str,
) -> Result<Option<AssetIdentityRow>, MediaError> {
  sqlx::query_as::<_, AssetIdentityRow>(
    "SELECT a.content_hash, s.kind AS source_type, a.source_id \
     FROM noise_assets a JOIN noise_sources s ON s.id = a.source_id WHERE a.id = ?",
  )
  .bind(asset_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取 Noise 素材身份失败：{error}")))
}

pub async fn asset_by_hash(
  pool: &SqlitePool,
  content_hash: &str,
) -> Result<Option<AssetRow>, MediaError> {
  sqlx::query_as::<_, AssetRow>(
    "SELECT id, name, media_kind, generator_json, storage_key, status \
     FROM noise_assets WHERE content_hash = ? LIMIT 1",
  )
  .bind(content_hash)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("按 hash 读取 Noise 素材失败：{error}")))
}

pub async fn assets_by_name(
  pool: &SqlitePool,
  name: &str,
  limit: i64,
) -> Result<Vec<AssetRow>, MediaError> {
  sqlx::query_as::<_, AssetRow>(
    "SELECT id, name, media_kind, generator_json, storage_key, status \
     FROM noise_assets WHERE lower(name) = lower(?) AND status = 'available' \
     ORDER BY created_at LIMIT ?",
  )
  .bind(name)
  .bind(limit)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("按名称读取 Noise 素材失败：{error}")))
}

pub async fn insert_preset(pool: &SqlitePool, preset: &NewPreset) -> Result<(), MediaError> {
  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启 Noise 预设事务失败：{error}")))?;
  sqlx::query(
    "INSERT INTO noise_presets \
     (id, origin_id, name, description, source_type, author, schema_version, \
      master_volume, cover_ref, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(&preset.id)
  .bind(&preset.origin_id)
  .bind(&preset.name)
  .bind(&preset.description)
  .bind(&preset.source_type)
  .bind(&preset.author)
  .bind(preset.schema_version)
  .bind(preset.master_volume.clamp(0.0, 1.0))
  .bind(&preset.cover_ref)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入 Noise 预设失败：{error}")))?;
  for track in &preset.tracks {
    sqlx::query(
      "INSERT INTO noise_preset_tracks \
       (id, preset_id, asset_id, asset_hash, asset_source_type, asset_source_id, \
        expected_name, volume, enabled, loop, fade_in_ms, fade_out_ms, sort_order) \
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&track.id)
    .bind(&preset.id)
    .bind(&track.asset_id)
    .bind(&track.asset_hash)
    .bind(&track.asset_source_type)
    .bind(&track.asset_source_id)
    .bind(&track.expected_name)
    .bind(track.volume.clamp(0.0, 1.0))
    .bind(if track.enabled { 1_i64 } else { 0_i64 })
    .bind(if track.loop_ { 1_i64 } else { 0_i64 })
    .bind(track.fade_in_ms)
    .bind(track.fade_out_ms)
    .bind(track.sort_order)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 预设轨道失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交 Noise 预设事务失败：{error}")))?;
  Ok(())
}

pub async fn update_preset_metadata(
  pool: &SqlitePool,
  preset_id: &str,
  name: &str,
  description: Option<&str>,
  cover_ref: Option<&str>,
) -> Result<(), MediaError> {
  let changed = sqlx::query(
    "UPDATE noise_presets SET name = ?, description = ?, cover_ref = ?, updated_at = ? \
     WHERE id = ?",
  )
  .bind(name)
  .bind(description)
  .bind(cover_ref)
  .bind(now_ms())
  .bind(preset_id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("更新 Noise 预设失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new(
      "noise.preset.not-found",
      "Noise 预设不存在",
    ));
  }
  Ok(())
}

pub async fn delete_preset(pool: &SqlitePool, preset_id: &str) -> Result<(), MediaError> {
  let changed = sqlx::query("DELETE FROM noise_presets WHERE id = ?")
    .bind(preset_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除 Noise 预设失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new(
      "noise.preset.not-found",
      "Noise 预设不存在",
    ));
  }
  Ok(())
}

pub async fn set_preset_favorite(
  pool: &SqlitePool,
  preset_id: &str,
  favorite: bool,
) -> Result<(), MediaError> {
  if favorite {
    sqlx::query(
      "INSERT INTO noise_preset_favorites (preset_id, created_at) VALUES (?, ?) \
       ON CONFLICT(preset_id) DO NOTHING",
    )
    .bind(preset_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("收藏 Noise 预设失败：{error}")))?;
  } else {
    sqlx::query("DELETE FROM noise_preset_favorites WHERE preset_id = ?")
      .bind(preset_id)
      .execute(pool)
      .await
      .map_err(|error| MediaError::internal(format!("取消收藏 Noise 预设失败：{error}")))?;
  }
  Ok(())
}

pub async fn map_preset_track(
  pool: &SqlitePool,
  preset_id: &str,
  preset_track_id: &str,
  asset_id: &str,
) -> Result<(), MediaError> {
  let changed = sqlx::query(
    "UPDATE noise_preset_tracks SET \
       asset_id = ?1, \
       asset_hash = (SELECT content_hash FROM noise_assets WHERE id = ?1), \
       asset_source_type = (SELECT s.kind FROM noise_assets a \
         JOIN noise_sources s ON s.id = a.source_id WHERE a.id = ?1), \
       asset_source_id = (SELECT source_id FROM noise_assets WHERE id = ?1) \
     WHERE id = ?2 AND preset_id = ?3",
  )
  .bind(asset_id)
  .bind(preset_track_id)
  .bind(preset_id)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("映射 Noise 预设轨道失败：{error}")))?;
  if changed.rows_affected() == 0 {
    return Err(MediaError::new(
      "noise.preset.track-not-found",
      "Noise 预设轨道不存在",
    ));
  }
  Ok(())
}
