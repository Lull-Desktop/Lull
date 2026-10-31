//! 音乐资料库门面：初始化、来源、曲目读取与扫描任务。
//!
//! P1 先提供只读查询与扫描；歌单、喜欢、标签、实体编辑按阶段加入。

pub mod catalog;
pub mod metadata;
pub mod scanner;

use std::path::Path;
use std::sync::OnceLock;

use tauri::Emitter;

use super::api::dto::{
  AlbumSummary, ArtistSummary, Page, ScanJobView, SourceView, TrackDetailView, TrackFileView,
  TrackQuery, TrackSummary,
};
use super::api::errors::MediaError;
use super::repository::{db, now_ms, sources, tracks};
use crate::media::api::protocol::MediaResponse;

static POOL: OnceLock<sqlx::SqlitePool> = OnceLock::new();
static INIT_ERROR: OnceLock<String> = OnceLock::new();

/// 启动资料库：异步打开/迁移数据库；失败只记录状态，不阻断应用启动。
pub fn init(app: tauri::AppHandle) {
  tauri::async_runtime::spawn(async move {
    match db::open(&app).await {
      Ok(pool) => {
        if let Err(error) = catalog::seed(&pool).await {
          crate::wallpaper::wlog(&format!("内置曲目 seed 失败：{error}"));
        }
        if let Err(error) = super::playback::init(&pool).await {
          crate::wallpaper::wlog(&format!("播放服务初始化失败：{error}"));
        }
        let _ = POOL.set(pool);
      }
      Err(error) => {
        let message = error.to_string();
        crate::wallpaper::wlog(&format!("media library 初始化失败：{message}"));
        let _ = INIT_ERROR.set(message);
      }
    }
  });
}

/// 退出：尽力关闭连接池；等待失败不阻塞托盘退出。
pub fn shutdown() {
  if let Some(pool) = POOL.get().cloned() {
    tauri::async_runtime::spawn(async move {
      db::close(&pool).await;
    });
  }
}

/// 命令层获取连接池；初始化中/失败都返回可读错误。
pub fn pool() -> Result<&'static sqlx::SqlitePool, MediaError> {
  if let Some(pool) = POOL.get() {
    return Ok(pool);
  }
  if let Some(error) = INIT_ERROR.get() {
    return Err(MediaError::unavailable(error.clone()));
  }
  Err(MediaError::unavailable("音乐资料库正在初始化，请稍后重试"))
}

pub async fn list_sources() -> Result<Vec<SourceView>, MediaError> {
  sources::list(pool()?)
    .await
    .map(|rows| rows.into_iter().map(SourceView::from).collect())
}

/// 添加本地音乐根目录；只允许 host 窗口调用。
pub async fn add_source(app: tauri::AppHandle) -> Result<Option<SourceView>, MediaError> {
  let picked = tauri::async_runtime::spawn_blocking(|| {
    rfd::FileDialog::new()
      .set_title("选择音乐文件夹")
      .pick_folder()
  })
  .await
  .map_err(|error| MediaError::internal(format!("打开目录选择器失败：{error}")))?;
  let Some(path) = picked else {
    return Ok(None);
  };
  let path = dunce::canonicalize(&path)
    .map_err(|error| MediaError::invalid(format!("目录不可用：{error}")))?;
  if !path.is_dir() {
    return Err(MediaError::invalid("选择的路径不是目录"));
  }
  let name = path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("音乐")
    .to_string();
  let path_text = path
    .to_str()
    .ok_or_else(|| MediaError::invalid("目录路径不是合法 UTF-8"))?;
  let row = sources::insert_local(pool()?, &name, path_text).await?;
  let _ = app.emit("library-changed", ());
  Ok(Some(SourceView::from(row)))
}

pub async fn remove_source(app: tauri::AppHandle, source_id: &str) -> Result<bool, MediaError> {
  let removed = sources::remove(pool()?, source_id).await?;
  let _ = app.emit("library-changed", ());
  Ok(removed)
}

/// 启动扫描并立即返回 job；扫描在 Tauri 异步运行时中执行。
pub async fn start_scan(app: tauri::AppHandle, source_id: &str) -> Result<ScanJobView, MediaError> {
  let pool = pool()?;
  let source = sources::get(pool, source_id)
    .await?
    .ok_or_else(|| MediaError::new("library.source-not-found", "音乐来源不存在"))?;
  if source.kind != "local" {
    return Err(MediaError::invalid("内置来源不需要扫描"));
  }
  if source.status == "scanning" {
    return Err(MediaError::new("library.scan-busy", "该来源正在扫描"));
  }
  let job_id = super::repository::new_id("scan");
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_scan_runs (id, source_id, status, started_at) \
     VALUES (?, ?, 'running', ?)",
  )
  .bind(&job_id)
  .bind(&source.id)
  .bind(now)
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建扫描任务失败：{error}")))?;
  sources::set_status(pool, &source.id, "scanning", None).await?;

  let job = ScanJobView {
    job_id: job_id.clone(),
    source_id: source.id.clone(),
    status: "running".to_string(),
  };
  let source_for_task = source.clone();
  let job_for_task = job_id.clone();
  tauri::async_runtime::spawn(async move {
    let result = scanner::scan_source(pool, &source_for_task, &job_for_task).await;
    let now = now_ms();
    match result {
      Ok(outcome) => {
        let errors = serde_json::to_string(&outcome.errors).unwrap_or_else(|_| "[]".to_string());
        let _ = sqlx::query(
          "UPDATE music_scan_runs SET status = 'completed', finished_at = ?, \
           added = ?, updated = ?, removed = ?, errors_json = ? WHERE id = ?",
        )
        .bind(now)
        .bind(outcome.added)
        .bind(outcome.updated)
        .bind(outcome.removed)
        .bind(errors)
        .bind(&job_for_task)
        .execute(pool)
        .await;
        let _ = sources::mark_scanned(pool, &source_for_task.id).await;
      }
      Err(error) => {
        let message = error.to_string();
        crate::wallpaper::wlog(&format!("音乐扫描失败：{message}"));
        let _ = sqlx::query(
          "UPDATE music_scan_runs SET status = 'failed', finished_at = ?, errors_json = ? \
           WHERE id = ?",
        )
        .bind(now)
        .bind(serde_json::json!([message]).to_string())
        .bind(&job_for_task)
        .execute(pool)
        .await;
        let _ = sources::set_status(pool, &source_for_task.id, "error", Some(&message)).await;
      }
    }
    let _ = app.emit("library-changed", ());
  });

  Ok(job)
}

pub async fn list_tracks(query: &TrackQuery) -> Result<Page<TrackSummary>, MediaError> {
  let page = query.page();
  let page_size = query.page_size();
  let (rows, total) = tracks::list(pool()?, query).await?;
  Ok(Page::new(
    rows.into_iter().map(TrackSummary::from).collect(),
    total,
    page,
    page_size,
  ))
}

pub async fn get_track(track_id: &str) -> Result<TrackDetailView, MediaError> {
  let pool = pool()?;
  let row = tracks::get(pool, track_id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  let files = tracks::files(pool, track_id)
    .await?
    .into_iter()
    .map(|file| TrackFileView {
      format: file.format,
      size_bytes: file.size_bytes,
      bitrate: file.bitrate,
      sample_rate: file.sample_rate,
      available: file.available != 0,
    })
    .collect();
  let metadata = tracks::metadata(pool, track_id)
    .await?
    .map_or(serde_json::Value::Null, |row| {
      serde_json::json!({
        "imported": serde_json::from_str::<serde_json::Value>(&row.imported_json).unwrap_or_default(),
        "normalized": serde_json::from_str::<serde_json::Value>(&row.normalized_json).unwrap_or_default(),
        "overrides": serde_json::from_str::<serde_json::Value>(&row.overrides_json).unwrap_or_default(),
        "online": serde_json::from_str::<serde_json::Value>(&row.online_json).unwrap_or_default(),
      })
    });

  Ok(TrackDetailView {
    summary: TrackSummary::from(row),
    metadata,
    files,
  })
}

pub async fn list_artists() -> Result<Vec<ArtistSummary>, MediaError> {
  let rows = tracks::list_artists(pool()?).await?;
  Ok(
    rows
      .into_iter()
      .map(|row| ArtistSummary {
        id: row.id,
        name: row.name,
        kind: row.kind,
        track_count: row.track_count,
        needs_review: row.needs_review != 0,
      })
      .collect(),
  )
}

pub async fn list_albums() -> Result<Vec<AlbumSummary>, MediaError> {
  let rows = tracks::list_albums(pool()?).await?;
  Ok(
    rows
      .into_iter()
      .map(|row| AlbumSummary {
        id: row.id,
        title: row.title,
        year: row.year,
        kind: row.kind,
        album_artist: row.album_artist,
        track_count: row.track_count,
        has_cover: row.has_cover != 0,
      })
      .collect(),
  )
}

/// 扫描指定目录的底层入口，测试使用。
#[allow(dead_code)]
pub async fn scan_path(
  pool: &sqlx::SqlitePool,
  path: &Path,
) -> Result<scanner::ScanOutcome, MediaError> {
  let path_text = path
    .to_str()
    .ok_or_else(|| MediaError::invalid("路径不是合法 UTF-8"))?;
  let row = sources::insert_local(pool, "测试音乐", path_text).await?;
  let run_id = super::repository::new_id("scan");
  sqlx::query(
    "INSERT INTO music_scan_runs (id, source_id, status, started_at) VALUES (?, ?, 'running', ?)",
  )
  .bind(&run_id)
  .bind(&row.id)
  .bind(now_ms())
  .execute(pool)
  .await
  .map_err(|error| MediaError::internal(format!("创建扫描任务失败：{error}")))?;
  scanner::scan_source(pool, &row, &run_id).await
}

/// 设置窗等 host 窗口调用 media API 时的统一响应包装。
pub async fn call_media(
  app: tauri::AppHandle,
  request_id: &str,
  namespace: &str,
  method: &str,
  args: &serde_json::Value,
) -> MediaResponse {
  let result = match (namespace, method) {
    ("library", "listSources") => list_sources().await.map(|rows| serde_json::json!(rows)),
    ("library", "addSource") => add_source(app)
      .await
      .map(|source| serde_json::json!(source)),
    ("library", "removeSource") => {
      let id = args
        .get("sourceId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 sourceId"));
      match id {
        Ok(id) => remove_source(app, id)
          .await
          .map(|removed| serde_json::json!({ "removed": removed })),
        Err(error) => Err(error),
      }
    }
    ("library", "startScan") => {
      let id = args
        .get("sourceId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 sourceId"));
      match id {
        Ok(id) => start_scan(app, id).await.map(|job| serde_json::json!(job)),
        Err(error) => Err(error),
      }
    }
    ("library", "listTracks") => {
      let query = serde_json::from_value::<TrackQuery>(args.clone())
        .map_err(|error| MediaError::invalid(format!("曲目查询参数无效：{error}")));
      match query {
        Ok(query) => list_tracks(&query)
          .await
          .map(|page| serde_json::json!(page)),
        Err(error) => Err(error),
      }
    }
    ("library", "getTrack") => {
      let id = args
        .get("trackId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      match id {
        Ok(id) => get_track(id).await.map(|track| serde_json::json!(track)),
        Err(error) => Err(error),
      }
    }
    ("library", "listArtists") => list_artists()
      .await
      .map(|artists| serde_json::json!(artists)),
    ("library", "listAlbums") => list_albums().await.map(|albums| serde_json::json!(albums)),
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的媒体方法：{namespace}.{method}"),
    )),
  };

  match result {
    Ok(value) => MediaResponse::ok(request_id, value, 0),
    Err(error) => MediaResponse::error(request_id, &error, 0),
  }
}
