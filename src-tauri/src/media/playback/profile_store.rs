//! 智能随机 Profile 的持久化：内置 seed、用户 CRUD 与激活项。
//!
//! 只做 SQL 与行映射；配置校验、内置定义在 `shuffle::profile`。

use sqlx::{FromRow, SqlitePool};

use super::shuffle::{
  builtin_profile, builtin_profiles, default_profile, profile_name_key, validate_profile_name,
  SmartShuffleConfig, SmartShuffleProfile, BUILTIN_BALANCED_ID, MAX_PROFILES,
};
use crate::media::api::errors::MediaError;
use crate::media::repository::{new_id, now_ms};

/// 兼容旧客户端的固定自定义配置 id。
pub const ALIAS_PROFILE_ID: &str = "user:custom";
/// 兼容旧客户端创建时的名称。
const ALIAS_PROFILE_NAME: &str = "我的配置";

#[derive(Debug, Clone, FromRow)]
struct ProfileRow {
  id: String,
  name: String,
  builtin: i64,
  config_json: String,
}

fn profile_from_row(row: ProfileRow) -> SmartShuffleProfile {
  let config = serde_json::from_str::<SmartShuffleConfig>(&row.config_json)
    .ok()
    .and_then(|config| config.validate().ok())
    .unwrap_or_else(|| {
      crate::wallpaper::wlog(&format!(
        "智能随机配置 {} 损坏或版本不支持，回退默认值",
        row.id
      ));
      SmartShuffleConfig::default()
    });
  SmartShuffleProfile {
    id: row.id,
    name: row.name,
    builtin: row.builtin != 0,
    config,
  }
}

fn serialize_config(config: &SmartShuffleConfig) -> Result<String, MediaError> {
  serde_json::to_string(config)
    .map_err(|error| MediaError::internal(format!("序列化智能随机配置失败：{error}")))
}

/// 启动时幂等写入/刷新内置 profile。
pub async fn ensure_builtin_profiles(pool: &SqlitePool) -> Result<(), MediaError> {
  let now = now_ms();
  for profile in builtin_profiles() {
    let json = serialize_config(&profile.config)?;
    sqlx::query(
      "INSERT INTO player_shuffle_profiles \
       (id, name, name_key, builtin, config_json, created_at, updated_at) \
       VALUES (?, ?, ?, 1, ?, ?, ?) \
       ON CONFLICT(id) DO UPDATE SET \
         name = excluded.name, name_key = excluded.name_key, \
         builtin = 1, config_json = excluded.config_json, \
         updated_at = excluded.updated_at",
    )
    .bind(&profile.id)
    .bind(&profile.name)
    .bind(profile_name_key(&profile.name))
    .bind(json)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("写入内置智能随机配置失败：{error}")))?;
  }
  Ok(())
}

pub async fn active_profile_id(pool: &SqlitePool) -> Result<Option<String>, MediaError> {
  sqlx::query_scalar("SELECT profile_id FROM player_shuffle_active WHERE id = 1")
    .fetch_optional(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取激活智能随机配置失败：{error}")))
}

pub async fn get_profile(
  pool: &SqlitePool,
  profile_id: &str,
) -> Result<Option<SmartShuffleProfile>, MediaError> {
  let row = sqlx::query_as::<_, ProfileRow>(
    "SELECT id, name, builtin, config_json FROM player_shuffle_profiles WHERE id = ?",
  )
  .bind(profile_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取智能随机配置失败：{error}")))?;
  Ok(row.map(profile_from_row))
}

/// 返回全部 profile，内置在前，并标记激活项。
pub async fn list_profiles(
  pool: &SqlitePool,
) -> Result<Vec<(SmartShuffleProfile, bool)>, MediaError> {
  let active = active_profile_id(pool).await?;
  let rows = sqlx::query_as::<_, ProfileRow>(
    "SELECT id, name, builtin, config_json FROM player_shuffle_profiles \
     ORDER BY builtin DESC, name COLLATE NOCASE, id",
  )
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取智能随机配置列表失败：{error}")))?;
  Ok(
    rows
      .into_iter()
      .map(|row| {
        let id = row.id.clone();
        let profile = profile_from_row(row);
        let is_active = active.as_deref() == Some(id.as_str());
        (profile, is_active)
      })
      .collect(),
  )
}

pub async fn load_active_profile(pool: &SqlitePool) -> Result<SmartShuffleProfile, MediaError> {
  if let Some(active_id) = active_profile_id(pool).await? {
    if let Some(profile) = get_profile(pool, &active_id).await? {
      return Ok(profile);
    }
    crate::wallpaper::wlog(&format!(
      "激活的智能随机配置 {active_id} 已不存在，回退默认"
    ));
  }
  if let Some(profile) = builtin_profile(BUILTIN_BALANCED_ID) {
    let _ = activate_profile(pool, &profile.id).await;
    return Ok(profile);
  }
  Ok(default_profile())
}

pub async fn activate_profile(
  pool: &SqlitePool,
  profile_id: &str,
) -> Result<SmartShuffleProfile, MediaError> {
  let profile = get_profile(pool, profile_id)
    .await?
    .ok_or_else(|| MediaError::new("shuffle.profile.not-found", "智能随机配置不存在"))?;
  sqlx::query(
    "INSERT INTO player_shuffle_active (id, profile_id, updated_at) VALUES (1, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       profile_id = excluded.profile_id, updated_at = excluded.updated_at",
  )
  .bind(&profile.id)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("激活智能随机配置失败：{error}")))?;
  Ok(profile)
}

/// 创建或更新用户 profile；内置 profile 不可修改。
pub async fn save_profile(
  pool: &SqlitePool,
  profile_id: Option<&str>,
  name: &str,
  config: SmartShuffleConfig,
) -> Result<SmartShuffleProfile, MediaError> {
  let name = validate_profile_name(name).map_err(MediaError::invalid)?;
  let config = config.validate().map_err(MediaError::invalid)?;
  let id = match profile_id {
    Some(id) => {
      let existing = get_profile(pool, id)
        .await?
        .ok_or_else(|| MediaError::new("shuffle.profile.not-found", "智能随机配置不存在"))?;
      if existing.builtin {
        return Err(MediaError::new(
          "shuffle.profile.builtin",
          "内置智能随机配置不可修改",
        ));
      }
      existing.id
    }
    None => {
      let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM player_shuffle_profiles WHERE builtin = 0")
          .fetch_one(pool)
          .await
          .map_err(|error| MediaError::internal(format!("统计智能随机配置失败：{error}")))?;
      if count >= i64::try_from(MAX_PROFILES).unwrap_or(i64::MAX) {
        return Err(MediaError::new(
          "shuffle.profile.limit",
          "自定义智能随机配置数量已达上限",
        ));
      }
      new_id("shuffle_profile")
    }
  };

  let name_key = profile_name_key(&name);
  let conflict: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM player_shuffle_profiles WHERE name_key = ? AND id <> ?",
  )
  .bind(&name_key)
  .bind(&id)
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("检查智能随机配置名称失败：{error}")))?;
  if conflict > 0 {
    return Err(MediaError::new(
      "shuffle.profile.name-conflict",
      "智能随机配置名称已存在",
    ));
  }

  let json = serialize_config(&config)?;
  let now = now_ms();
  sqlx::query(
    "INSERT INTO player_shuffle_profiles \
     (id, name, name_key, builtin, config_json, created_at, updated_at) \
     VALUES (?, ?, ?, 0, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       name = excluded.name, name_key = excluded.name_key, \
       config_json = excluded.config_json, updated_at = excluded.updated_at",
  )
  .bind(&id)
  .bind(&name)
  .bind(name_key)
  .bind(json)
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存智能随机配置失败：{error}")))?;

  Ok(SmartShuffleProfile {
    id,
    name,
    builtin: false,
    config,
  })
}

/// 删除用户 profile；删除激活项时回退均衡随机。
pub async fn delete_profile(pool: &SqlitePool, profile_id: &str) -> Result<(), MediaError> {
  let profile = get_profile(pool, profile_id)
    .await?
    .ok_or_else(|| MediaError::new("shuffle.profile.not-found", "智能随机配置不存在"))?;
  if profile.builtin {
    return Err(MediaError::new(
      "shuffle.profile.builtin",
      "内置智能随机配置不可删除",
    ));
  }
  let active = active_profile_id(pool).await?;
  let mut tx = pool
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启配置事务失败：{error}")))?;
  if active.as_deref() == Some(profile_id) {
    sqlx::query(
      "INSERT INTO player_shuffle_active (id, profile_id, updated_at) VALUES (1, ?, ?) \
       ON CONFLICT(id) DO UPDATE SET \
         profile_id = excluded.profile_id, updated_at = excluded.updated_at",
    )
    .bind(BUILTIN_BALANCED_ID)
    .bind(now_ms())
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("回退智能随机配置失败：{error}")))?;
  }
  sqlx::query("DELETE FROM player_shuffle_profiles WHERE id = ?")
    .bind(profile_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("删除智能随机配置失败：{error}")))?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交配置事务失败：{error}")))?;
  Ok(())
}

/// 兼容旧 `setSmartShuffleConfig`：更新激活的用户配置，或创建/更新 `user:custom`。
pub async fn save_alias_config(
  pool: &SqlitePool,
  config: SmartShuffleConfig,
) -> Result<SmartShuffleProfile, MediaError> {
  let active = load_active_profile(pool).await?;
  let profile = if active.builtin {
    match get_profile(pool, ALIAS_PROFILE_ID).await? {
      Some(existing) => save_profile(pool, Some(&existing.id), &existing.name, config).await?,
      None => upsert_fixed_profile(pool, ALIAS_PROFILE_ID, ALIAS_PROFILE_NAME, config).await?,
    }
  } else {
    save_profile(pool, Some(&active.id), &active.name, config).await?
  };
  activate_profile(pool, &profile.id).await
}

/// 以固定 id 创建用户 profile；只给兼容别名使用。
async fn upsert_fixed_profile(
  pool: &SqlitePool,
  id: &str,
  name: &str,
  config: SmartShuffleConfig,
) -> Result<SmartShuffleProfile, MediaError> {
  let name = validate_profile_name(name).map_err(MediaError::invalid)?;
  let config = config.validate().map_err(MediaError::invalid)?;
  let name_key = profile_name_key(&name);
  let conflict: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM player_shuffle_profiles WHERE name_key = ? AND id <> ?",
  )
  .bind(&name_key)
  .bind(id)
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("检查智能随机配置名称失败：{error}")))?;
  if conflict > 0 {
    return Err(MediaError::new(
      "shuffle.profile.name-conflict",
      "智能随机配置名称已存在",
    ));
  }
  let json = serialize_config(&config)?;
  let now = now_ms();
  sqlx::query(
    "INSERT INTO player_shuffle_profiles \
     (id, name, name_key, builtin, config_json, created_at, updated_at) \
     VALUES (?, ?, ?, 0, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       name = excluded.name, name_key = excluded.name_key, \
       config_json = excluded.config_json, updated_at = excluded.updated_at",
  )
  .bind(id)
  .bind(&name)
  .bind(name_key)
  .bind(json)
  .bind(now)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("保存智能随机配置失败：{error}")))?;
  Ok(SmartShuffleProfile {
    id: id.to_string(),
    name,
    builtin: false,
    config,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  fn cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }

  #[test]
  fn builtin_seed_and_user_crud() {
    let path =
      std::env::temp_dir().join(format!("lull-shuffle-profiles-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      ensure_builtin_profiles(&pool).await.expect("seed");

      let list = list_profiles(&pool).await.expect("list");
      assert_eq!(list.len(), 3);
      assert!(list.iter().all(|(profile, _)| profile.builtin));
      assert_eq!(
        load_active_profile(&pool).await.expect("active").id,
        BUILTIN_BALANCED_ID
      );

      let mut config = SmartShuffleConfig::default();
      config.experience.randomness = 90;
      let profile = save_profile(&pool, None, "夜航", config)
        .await
        .expect("save");
      assert!(!profile.builtin);
      assert_eq!(profile.name, "夜航");
      assert_eq!(list_profiles(&pool).await.expect("list user").len(), 4);

      let activated = activate_profile(&pool, &profile.id)
        .await
        .expect("activate");
      assert_eq!(activated.id, profile.id);
      assert_eq!(
        load_active_profile(&pool).await.expect("loaded").id,
        profile.id
      );

      assert!(save_profile(
        &pool,
        Some(BUILTIN_BALANCED_ID),
        "改名",
        SmartShuffleConfig::default()
      )
      .await
      .is_err());
      assert!(
        save_profile(&pool, None, "夜航", SmartShuffleConfig::default())
          .await
          .is_err()
      );

      delete_profile(&pool, &profile.id).await.expect("delete");
      assert!(get_profile(&pool, &profile.id)
        .await
        .expect("get")
        .is_none());
      assert_eq!(
        load_active_profile(&pool).await.expect("fallback").id,
        BUILTIN_BALANCED_ID
      );
      db::close(&pool).await;
    });
    cleanup(&path);
  }

  #[test]
  fn alias_config_creates_user_custom_profile() {
    let path = std::env::temp_dir().join(format!("lull-shuffle-alias-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      ensure_builtin_profiles(&pool).await.expect("seed");
      let profile = save_alias_config(&pool, SmartShuffleConfig::default())
        .await
        .expect("alias");
      assert_eq!(profile.id, ALIAS_PROFILE_ID);
      assert!(!profile.builtin);
      assert_eq!(
        load_active_profile(&pool).await.expect("active").id,
        profile.id
      );
      db::close(&pool).await;
    });
    cleanup(&path);
  }

  #[test]
  fn corrupt_config_falls_back_to_default() {
    let path =
      std::env::temp_dir().join(format!("lull-shuffle-corrupt-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      ensure_builtin_profiles(&pool).await.expect("seed");
      sqlx::query(
        "INSERT INTO player_shuffle_profiles \
         (id, name, name_key, builtin, config_json, created_at, updated_at) \
         VALUES ('user:bad', '坏配置', '坏配置', 0, 'not-json', 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("insert bad");
      let profile = get_profile(&pool, "user:bad")
        .await
        .expect("get")
        .expect("exists");
      assert_eq!(profile.config, SmartShuffleConfig::default());
      db::close(&pool).await;
    });
    cleanup(&path);
  }
}
