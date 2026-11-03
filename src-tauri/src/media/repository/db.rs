//! 音乐资料库的 SQLite 连接与迁移。
//!
//! 数据库位置：`%APPDATA%\app.lull.desktop\music\music.db`
//! （`LULL_MUSIC_DIR` 可覆盖，供开发与测试使用）。
//!
//! 连接建立后先跑 PRAGMA，再执行 SQLx migrations；任何失败都返回 MediaError，
//! 由上层降级为“资料库不可用”，不影响托盘、壁纸和设置窗启动。

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use tauri::Manager;

use crate::media::api::errors::MediaError;

pub const MUSIC_DIR: &str = "music";
pub const MUSIC_DB: &str = "music.db";

/// 数据库文件路径；只给 Rust 使用，不进入任何 DTO。
pub fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, MediaError> {
  let base = if let Some(dir) = std::env::var_os("LULL_MUSIC_DIR") {
    PathBuf::from(dir)
  } else {
    app
      .path()
      .app_data_dir()
      .map_err(|error| MediaError::unavailable(format!("无法定位应用数据目录：{error}")))?
      .join(MUSIC_DIR)
  };
  std::fs::create_dir_all(&base)
    .map_err(|error| MediaError::unavailable(format!("无法创建音乐资料库目录：{error}")))?;
  Ok(base.join(MUSIC_DB))
}

/// 打开任意路径的数据库并执行迁移；测试与生产共用。
pub async fn open_at(path: &Path) -> Result<SqlitePool, MediaError> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| MediaError::unavailable(format!("无法创建数据库目录：{error}")))?;
  }

  let options = SqliteConnectOptions::new()
    .filename(path)
    .create_if_missing(true)
    .journal_mode(SqliteJournalMode::Wal)
    .synchronous(SqliteSynchronous::Normal)
    .foreign_keys(true)
    .busy_timeout(Duration::from_secs(5));

  let pool = SqlitePoolOptions::new()
    .max_connections(4)
    .connect_with(options)
    .await
    .map_err(|error| MediaError::unavailable(format!("打开音乐资料库失败：{error}")))?;

  if let Err(error) = backup_before_media_migration(&pool, path).await {
    crate::wallpaper::wlog(&format!("迁移前备份音乐资料库失败：{error}"));
  }

  if let Err(error) = sqlx::migrate!("./migrations").run(&pool).await {
    pool.close().await;
    return Err(MediaError::unavailable(format!(
      "音乐资料库迁移失败：{error}"
    )));
  }

  Ok(pool)
}

/// 0009/0010 会重写 Track 文件列并删除旧内置曲；首次升级前尽力留一份快照。
async fn backup_before_media_migration(pool: &SqlitePool, path: &Path) -> Result<(), MediaError> {
  let has_migrations: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
  )
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("检查迁移状态失败：{error}")))?;
  if has_migrations == 0 {
    return Ok(());
  }
  let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
    .fetch_one(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取迁移版本失败：{error}")))?;
  if version.unwrap_or(0) >= 10 {
    return Ok(());
  }
  let backup = path.with_extension("db.pre-0010.bak");
  if backup.exists() {
    return Ok(());
  }
  let escaped = backup.to_string_lossy().replace('\'', "''");
  sqlx::query(&format!("VACUUM INTO '{escaped}'"))
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("备份音乐资料库失败：{error}")))?;
  Ok(())
}

/// 生产入口：按应用数据目录打开。
pub async fn open(app: &tauri::AppHandle) -> Result<SqlitePool, MediaError> {
  let path = database_path(app)?;
  open_at(&path).await
}

/// 关闭连接池；失败不抛出，退出流程不应被数据库卡住。
pub async fn close(pool: &SqlitePool) {
  pool.close().await;
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::sources;

  fn temp_db() -> PathBuf {
    std::env::temp_dir().join(format!("lull-music-test-{}.db", uuid::Uuid::now_v7()))
  }

  fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }

  #[test]
  fn migrations_create_core_tables_and_fts5_status() {
    let path = temp_db();
    let (tables, removed, fts5): (i64, i64, i64) = tauri::async_runtime::block_on(async {
      let pool = open_at(&path).await.expect("open music db");
      let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN \
         ('music_sources', 'music_tracks', 'music_artists', \
          'music_albums', 'music_track_metadata', 'music_search_text', 'media_output', \
          'music_playlists', 'music_playlist_tracks', 'music_favorites', 'music_play_history', \
          'noise_sources', 'noise_categories', 'noise_tags', 'noise_assets', \
          'noise_asset_tags', 'noise_favorites', 'noise_presets', 'noise_preset_tracks', \
          'noise_preset_favorites', 'noise_preferences', 'music_tags', 'music_track_tags', \
          'music_smart_playlists', 'player_shuffle_profiles', 'player_shuffle_active')",
      )
      .fetch_one(&pool)
      .await
      .expect("count tables");
      let removed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
         AND name IN ('music_files', 'music_folders')",
      )
      .fetch_one(&pool)
      .await
      .expect("count removed tables");
      let fts5: i64 = sqlx::query_scalar("SELECT sqlite_compileoption_used('ENABLE_FTS5')")
        .fetch_one(&pool)
        .await
        .expect("check fts5");
      close(&pool).await;
      (tables, removed, fts5)
    });
    cleanup(&path);
    assert_eq!(tables, 26);
    assert_eq!(removed, 0);
    eprintln!("SQLite FTS5 enabled = {fts5}");
  }

  #[test]
  fn folder_insert_rejects_duplicate_root() {
    let path = temp_db();
    tauri::async_runtime::block_on(async {
      let pool = open_at(&path).await.expect("open music db");
      let first = sources::insert_local(&pool, "音乐", r"C:\Music", true)
        .await
        .expect("insert folder");
      let second = sources::insert_local(&pool, "重复名称", r"C:\Music", true).await;
      let all = sources::list(&pool).await.expect("list sources");
      close(&pool).await;
      assert!(second.is_err());
      assert_eq!(first.name, "音乐");
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].root_path.as_deref(), Some(r"C:\Music"));
      assert_eq!(all[0].recursive, 1);
    });
    cleanup(&path);
  }

  #[test]
  fn legacy_files_migrate_into_track_columns() {
    let path = temp_db();
    tauri::async_runtime::block_on(async {
      let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
      let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open legacy db");
      for sql in [
        include_str!("../../../migrations/0001_library.sql"),
        include_str!("../../../migrations/0002_search_fts.sql"),
        include_str!("../../../migrations/0003_playback.sql"),
        include_str!("../../../migrations/0004_library_filters.sql"),
        include_str!("../../../migrations/0005_media_output.sql"),
        include_str!("../../../migrations/0006_library_p3.sql"),
        include_str!("../../../migrations/0007_noise.sql"),
        include_str!("../../../migrations/0008_music_p4.sql"),
      ] {
        sqlx::raw_sql(sql)
          .execute(&pool)
          .await
          .expect("legacy schema");
      }
      sqlx::raw_sql(
        "INSERT INTO music_sources \
           (id, kind, name, root_path, status, created_at, updated_at) \
         VALUES ('src_1', 'local', '音乐', 'C:/Music', 'active', 1, 1); \
         INSERT INTO music_tracks \
           (id, kind, title, status, added_at, updated_at) \
         VALUES ('trk_1', 'file', '旧歌', 'active', 10, 10); \
         INSERT INTO music_files \
           (id, source_id, track_id, path, path_key, relative_path, format, size_bytes, \
            mtime_ms, bitrate, sample_rate, available, added_at, updated_at) \
         VALUES ('file_1', 'src_1', 'trk_1', 'C:/Music/Album/Song.mp3', \
                 'c:/music/album/song.mp3', 'Album/Song.mp3', 'mp3', 1234, 5678, \
                 192000, 44100, 1, 10, 10); \
         INSERT INTO music_playlists (id, name, created_at, updated_at) \
         VALUES ('pl_1', '旧歌单', 1, 1); \
         INSERT INTO music_playlist_tracks (playlist_id, track_id, position, added_at) \
         VALUES ('pl_1', 'trk_1', 0, 1); \
         INSERT INTO music_favorites (track_id, created_at) VALUES ('trk_1', 1); \
         INSERT INTO music_tags (id, name, normalized_name, created_at) \
         VALUES ('tag_1', '旧标签', '旧标签', 1); \
         INSERT INTO music_track_tags (track_id, tag_id, created_at) \
         VALUES ('trk_1', 'tag_1', 1);",
      )
      .execute(&pool)
      .await
      .expect("legacy rows");
      sqlx::raw_sql(include_str!("../../../migrations/0009_music_folders.sql"))
        .execute(&pool)
        .await
        .expect("run 0009");
      sqlx::raw_sql(
        "INSERT INTO music_sources \
           (id, kind, name, status, created_at, updated_at) \
         VALUES ('src_builtin', 'builtin', 'Lull 精选', 'active', 1, 1); \
         INSERT INTO music_tracks \
           (id, kind, title, status, added_at, updated_at) \
         VALUES ('online-test', 'builtin', '默认曲', 'active', 1, 1); \
         INSERT INTO music_artists (id, name, created_at, updated_at) \
         VALUES ('art_builtin', '默认艺术家', 1, 1); \
         INSERT INTO music_track_artists \
           (track_id, artist_id, role, position, source, updated_at) \
         VALUES ('online-test', 'art_builtin', 'primary', 0, 'import', 1); \
         INSERT INTO app_meta (key, value) VALUES ('catalog_seed_version', '1') \
           ON CONFLICT(key) DO UPDATE SET value = '1';",
      )
      .execute(&pool)
      .await
      .expect("builtin rows");
      sqlx::raw_sql(include_str!(
        "../../../migrations/0010_remove_builtin_music.sql"
      ))
      .execute(&pool)
      .await
      .expect("run 0010");

      let (folder_id, relative, format, size, recursive): (String, String, String, i64, i64) =
        sqlx::query_as(
          "SELECT t.folder_id, t.relative_path, t.format, t.file_size, s.recursive \
           FROM music_tracks t JOIN music_sources s ON s.id = t.folder_id WHERE t.id = 'trk_1'",
        )
        .fetch_one(&pool)
        .await
        .expect("migrated track");
      let (playlist_refs, favorite_refs, tag_refs): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM music_playlist_tracks WHERE track_id = 'trk_1'), \
                (SELECT COUNT(*) FROM music_favorites WHERE track_id = 'trk_1'), \
                (SELECT COUNT(*) FROM music_track_tags WHERE track_id = 'trk_1')",
      )
      .fetch_one(&pool)
      .await
      .expect("references");
      let (builtin_tracks, builtin_sources, builtin_artists, catalog_key): (i64, i64, i64, i64) =
        sqlx::query_as(
          "SELECT (SELECT COUNT(*) FROM music_tracks WHERE kind = 'builtin'), \
                  (SELECT COUNT(*) FROM music_sources WHERE kind = 'builtin'), \
                  (SELECT COUNT(*) FROM music_artists WHERE id = 'art_builtin'), \
                  (SELECT COUNT(*) FROM app_meta WHERE key = 'catalog_seed_version')",
        )
        .fetch_one(&pool)
        .await
        .expect("builtin cleanup");
      let removed_tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
         AND name IN ('music_files', 'music_folders')",
      )
      .fetch_one(&pool)
      .await
      .expect("removed tables");
      pool.close().await;

      assert_eq!(folder_id, "src_1");
      assert_eq!(relative, "Album/Song.mp3");
      assert_eq!(format, "mp3");
      assert_eq!(size, 1234);
      assert_eq!(recursive, 1);
      assert_eq!(playlist_refs, 1);
      assert_eq!(favorite_refs, 1);
      assert_eq!(tag_refs, 1);
      assert_eq!(builtin_tracks, 0);
      assert_eq!(builtin_sources, 0);
      assert_eq!(builtin_artists, 0);
      assert_eq!(catalog_key, 0);
      assert_eq!(removed_tables, 0);
    });
    cleanup(&path);
  }

  #[test]
  fn legacy_smart_shuffle_config_migrates_to_user_profile() {
    let path = temp_db();
    tauri::async_runtime::block_on(async {
      let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
      let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open legacy db");
      for sql in [
        include_str!("../../../migrations/0001_library.sql"),
        include_str!("../../../migrations/0011_smart_shuffle.sql"),
      ] {
        sqlx::raw_sql(sql)
          .execute(&pool)
          .await
          .expect("legacy schema");
      }
      sqlx::raw_sql(
        "INSERT INTO player_smart_shuffle (id, config_json, updated_at) \
         VALUES (1, '{\"version\":1,\"experience\":{\"randomness\":90,\"diversity\":50,\"repeatAvoidance\":80},\"separation\":{\"artist\":3,\"album\":2},\"audioFeatures\":{\"bpmMatching\":30,\"energyMatching\":30,\"moodDiversity\":30,\"genreDiversity\":50}}', 1)",
      )
      .execute(&pool)
      .await
      .expect("legacy config");
      sqlx::raw_sql(include_str!(
        "../../../migrations/0012_shuffle_profiles.sql"
      ))
      .execute(&pool)
      .await
      .expect("run 0012");

      let active: String =
        sqlx::query_scalar("SELECT profile_id FROM player_shuffle_active WHERE id = 1")
          .fetch_one(&pool)
          .await
          .expect("active");
      let config: String = sqlx::query_scalar(
        "SELECT config_json FROM player_shuffle_profiles WHERE id = 'user:migrated'",
      )
      .fetch_one(&pool)
      .await
      .expect("migrated profile");
      let old_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'player_smart_shuffle'",
      )
      .fetch_one(&pool)
      .await
      .expect("old table");
      pool.close().await;

      assert_eq!(active, "user:migrated");
      assert!(config.contains("\"randomness\":90"));
      assert_eq!(old_table, 0);
    });
    cleanup(&path);
  }
}
