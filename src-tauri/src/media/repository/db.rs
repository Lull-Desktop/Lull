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

  if let Err(error) = sqlx::migrate!("./migrations").run(&pool).await {
    pool.close().await;
    return Err(MediaError::unavailable(format!(
      "音乐资料库迁移失败：{error}"
    )));
  }

  Ok(pool)
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
    let (tables, fts5): (i64, i64) = tauri::async_runtime::block_on(async {
      let pool = open_at(&path).await.expect("open music db");
      let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN \
         ('music_sources', 'music_files', 'music_tracks', 'music_artists', \
          'music_albums', 'music_track_metadata', 'music_search_text')",
      )
      .fetch_one(&pool)
      .await
      .expect("count tables");
      let fts5: i64 = sqlx::query_scalar("SELECT sqlite_compileoption_used('ENABLE_FTS5')")
        .fetch_one(&pool)
        .await
        .expect("check fts5");
      close(&pool).await;
      (tables, fts5)
    });
    cleanup(&path);
    assert_eq!(tables, 7);
    eprintln!("SQLite FTS5 enabled = {fts5}");
  }

  #[test]
  fn source_insert_is_idempotent_by_root() {
    let path = temp_db();
    tauri::async_runtime::block_on(async {
      let pool = open_at(&path).await.expect("open music db");
      let first = sources::insert_local(&pool, "音乐", r"C:\Music")
        .await
        .expect("insert source");
      let second = sources::insert_local(&pool, "重复名称", r"C:\Music")
        .await
        .expect("insert duplicate source");
      let all = sources::list(&pool).await.expect("list sources");
      close(&pool).await;
      assert_eq!(first.id, second.id);
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].root_path.as_deref(), Some(r"C:\Music"));
    });
    cleanup(&path);
  }
}
