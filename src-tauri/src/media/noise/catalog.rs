//! 内置 Noise catalog：5 个程序化声景、分类/标签与内置 Preset。
//!
//! seed 是幂等的；catalog 版本变化时更新内置 Asset/Preset，但不覆盖用户数据。
//! 内置声音不打包音频文件：`media_kind='procedural'`，由引擎 profile 合成。

use sqlx::SqlitePool;

use crate::media::api::errors::MediaError;
use crate::media::repository::now_ms;

const CATALOG_JSON: &str = include_str!("catalog.json");
const SOURCE_ID: &str = "noise_src_builtin";

#[derive(Debug, Clone, serde::Deserialize)]
struct CatalogFile {
  version: u32,
  source: CatalogSource,
  categories: Vec<CatalogCategory>,
  tags: Vec<CatalogTag>,
  assets: Vec<CatalogAsset>,
  presets: Vec<CatalogPreset>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct CatalogSource {
  id: String,
  name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCategory {
  id: String,
  name: String,
  icon: Option<String>,
  parent_id: Option<String>,
  sort_order: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct CatalogTag {
  id: String,
  name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogAsset {
  id: String,
  name: String,
  description: Option<String>,
  profile: String,
  category_id: Option<String>,
  tags: Vec<String>,
  sort_order: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPreset {
  id: String,
  name: String,
  description: Option<String>,
  master_volume: f64,
  tracks: Vec<CatalogPresetTrack>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPresetTrack {
  asset_id: String,
  volume: f64,
  enabled: bool,
}

fn catalog() -> Result<CatalogFile, MediaError> {
  serde_json::from_str(CATALOG_JSON)
    .map_err(|error| MediaError::internal(format!("Noise catalog 损坏：{error}")))
}

fn normalize(value: &str) -> String {
  value.trim().to_lowercase()
}

/// 幂等 seed；失败只由调用方记录日志，不阻断 Media Service 启动。
pub async fn seed(pool: &SqlitePool) -> Result<(), MediaError> {
  let catalog = catalog()?;
  let seeded: Option<String> =
    sqlx::query_scalar("SELECT value FROM app_meta WHERE key = 'noise_catalog_seed_version'")
      .fetch_optional(pool)
      .await
      .map_err(|error| MediaError::internal(format!("读取 Noise catalog 版本失败：{error}")))?;
  if seeded
    .as_deref()
    .and_then(|value| value.parse::<u32>().ok())
    == Some(catalog.version)
  {
    return Ok(());
  }

  let now = now_ms();
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启 Noise catalog 事务失败：{error}")))?;

  sqlx::query(
    "INSERT INTO noise_sources (id, kind, name, status, created_at, updated_at) \
     VALUES (?, 'builtin', ?, 'available', ?, ?) \
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = 'available', \
       updated_at = excluded.updated_at",
  )
  .bind(&catalog.source.id)
  .bind(&catalog.source.name)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("写入 Noise 内置来源失败：{error}")))?;

  for category in &catalog.categories {
    sqlx::query(
      "INSERT INTO noise_categories \
       (id, name, parent_id, icon, source_type, sort_order, created_at) \
       VALUES (?, ?, ?, ?, 'builtin', ?, ?) \
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
         parent_id = excluded.parent_id, icon = excluded.icon, \
         sort_order = excluded.sort_order",
    )
    .bind(&category.id)
    .bind(&category.name)
    .bind(&category.parent_id)
    .bind(&category.icon)
    .bind(category.sort_order)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 分类失败：{error}")))?;
  }

  for tag in &catalog.tags {
    sqlx::query(
      "INSERT INTO noise_tags (id, name, normalized_name, source_type, created_at) \
       VALUES (?, ?, ?, 'builtin', ?) \
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
         normalized_name = excluded.normalized_name",
    )
    .bind(&tag.id)
    .bind(&tag.name)
    .bind(normalize(&tag.name))
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 标签失败：{error}")))?;
  }

  for asset in &catalog.assets {
    let generator = serde_json::json!({
      "profile": asset.profile,
      "version": 1,
      "sortOrder": asset.sort_order,
    });
    let generator_text = serde_json::to_string(&generator)
      .map_err(|error| MediaError::internal(format!("序列化 Noise generator 失败：{error}")))?;
    sqlx::query(
      "INSERT INTO noise_assets \
       (id, source_id, name, description, media_kind, format, storage_key, size_bytes, \
        generator_json, category_id, capabilities_json, status, created_at, updated_at) \
       VALUES (?, ?, ?, ?, 'procedural', 'procedural', NULL, 0, ?, ?, \
        '{\"loop\":true,\"seek\":false,\"fade\":true}', 'available', ?, ?) \
       ON CONFLICT(id) DO UPDATE SET \
         name = excluded.name, description = excluded.description, \
         generator_json = excluded.generator_json, category_id = excluded.category_id, \
         capabilities_json = excluded.capabilities_json, status = 'available', \
         updated_at = excluded.updated_at",
    )
    .bind(&asset.id)
    .bind(SOURCE_ID)
    .bind(&asset.name)
    .bind(&asset.description)
    .bind(&generator_text)
    .bind(&asset.category_id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 内置素材失败：{error}")))?;

    sqlx::query("DELETE FROM noise_asset_tags WHERE asset_id = ?")
      .bind(&asset.id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理 Noise 素材标签失败：{error}")))?;
    for tag_id in &asset.tags {
      sqlx::query(
        "INSERT INTO noise_asset_tags (asset_id, tag_id) VALUES (?, ?) \
         ON CONFLICT(asset_id, tag_id) DO NOTHING",
      )
      .bind(&asset.id)
      .bind(tag_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入 Noise 素材标签失败：{error}")))?;
    }
  }

  for preset in &catalog.presets {
    sqlx::query(
      "INSERT INTO noise_presets \
       (id, origin_id, name, description, source_type, author, schema_version, \
        master_volume, cover_ref, created_at, updated_at) \
       VALUES (?, NULL, ?, ?, 'builtin', 'Lull', 1, ?, NULL, ?, ?) \
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
         description = excluded.description, master_volume = excluded.master_volume, \
         source_type = 'builtin', author = 'Lull', updated_at = excluded.updated_at",
    )
    .bind(&preset.id)
    .bind(&preset.name)
    .bind(&preset.description)
    .bind(preset.master_volume.clamp(0.0, 1.0))
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入 Noise 内置预设失败：{error}")))?;

    sqlx::query("DELETE FROM noise_preset_tracks WHERE preset_id = ?")
      .bind(&preset.id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理 Noise 预设音轨失败：{error}")))?;
    for (index, track) in preset.tracks.iter().enumerate() {
      let track_id = format!("noise_preset_track:{}:{index}", preset.id);
      sqlx::query(
        "INSERT INTO noise_preset_tracks \
         (id, preset_id, asset_id, asset_hash, asset_source_type, asset_source_id, \
          expected_name, volume, enabled, loop, fade_in_ms, fade_out_ms, sort_order) \
         VALUES (?, ?, ?, NULL, 'builtin', 'noise_src_builtin', ?, ?, ?, 1, 80, 120, ?)",
      )
      .bind(&track_id)
      .bind(&preset.id)
      .bind(&track.asset_id)
      .bind(&track.asset_id)
      .bind(track.volume.clamp(0.0, 1.0))
      .bind(if track.enabled { 1_i64 } else { 0_i64 })
      .bind(i64::try_from(index).unwrap_or(i64::MAX))
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入 Noise 预设音轨失败：{error}")))?;
    }
  }

  sqlx::query(
    "INSERT INTO app_meta (key, value) VALUES ('noise_catalog_seed_version', ?) \
     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
  .bind(catalog.version.to_string())
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新 Noise catalog 版本失败：{error}")))?;

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交 Noise catalog 事务失败：{error}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  #[test]
  fn catalog_is_valid_and_seed_is_idempotent() {
    let catalog = catalog().expect("catalog parses");
    assert_eq!(catalog.assets.len(), 5);
    assert!(catalog
      .presets
      .iter()
      .any(|preset| preset.id == "noise:preset:default"));
    let path = std::env::temp_dir().join(format!("lull-noise-catalog-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      seed(&pool).await.expect("first seed");
      seed(&pool).await.expect("second seed");
      let assets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM noise_assets")
        .fetch_one(&pool)
        .await
        .expect("count assets");
      let presets: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM noise_presets WHERE source_type = 'builtin'")
          .fetch_one(&pool)
          .await
          .expect("count presets");
      assert_eq!(assets, 5);
      assert!(presets >= 4);
      db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
