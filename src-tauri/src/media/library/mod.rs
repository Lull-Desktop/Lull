//! 音乐资料库门面：初始化、来源、曲目读取与扫描任务。
//!
//! P1 先提供只读查询与扫描；歌单、喜欢、标签、实体编辑按阶段加入。

pub mod assets;
mod backup;
pub mod catalog;
pub mod events;
pub mod favorites;
pub mod folders;
pub mod history;
pub mod metadata;
mod p3;
mod p4;
pub mod playlists;
pub mod scanner;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;

use super::api::dto::{
  AlbumSummary, ArtistSummary, Page, ScanJobView, SourceView, TrackDetailView, TrackFileView,
  TrackQuery, TrackSummary,
};
use super::api::errors::MediaError;
use super::repository::{db, now_ms, sources, tracks};
use crate::media::api::protocol::MediaResponse;

static POOL: OnceLock<sqlx::SqlitePool> = OnceLock::new();
static INIT_ERROR: OnceLock<String> = OnceLock::new();
static SCAN_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn scan_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
  SCAN_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn assets_dir(app: &tauri::AppHandle) -> PathBuf {
  let root = db::database_path(app)
    .ok()
    .and_then(|path| path.parent().map(Path::to_path_buf))
    .unwrap_or_else(|| {
      app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("app.lull.desktop"))
        .join("music")
    });
  let dir = root.join("assets");
  let _ = std::fs::create_dir_all(&dir);
  dir
}

/// 启动资料库：异步打开/迁移数据库；失败只记录状态，不阻断应用启动。
pub fn init(app: tauri::AppHandle) {
  tauri::async_runtime::spawn(async move {
    match db::open(&app).await {
      Ok(pool) => {
        if let Ok(Some(value)) =
          sqlx::query_scalar::<_, String>("SELECT value FROM app_meta WHERE key = 'revision'")
            .fetch_optional(&pool)
            .await
        {
          if let Ok(revision) = value.parse::<u64>() {
            events::set_revision(revision);
          }
        }
        // 上次进程退出时未完成的扫描不能永久卡在 scanning。
        let now = now_ms();
        let _ = sqlx::query(
          "UPDATE music_scan_runs SET status = 'interrupted', finished_at = ? \
           WHERE status = 'running'",
        )
        .bind(now)
        .execute(&pool)
        .await;
        let _ = sqlx::query(
          "UPDATE music_sources SET status = 'active', last_scan_error = '上次扫描未完成' \
           WHERE status = 'scanning'",
        )
        .execute(&pool)
        .await;
        if let Err(error) = folders::revalidate(&pool).await {
          crate::wallpaper::wlog(&format!("音乐目录可用性检查失败：{error}"));
        }
        if let Err(error) = catalog::seed(&pool).await {
          crate::wallpaper::wlog(&format!("内置曲目 seed 失败：{error}"));
        }
        if let Err(error) = super::output::init(&pool).await {
          crate::wallpaper::wlog(&format!("输出音量初始化失败：{error}"));
        }
        if let Err(error) = super::playback::init(&pool).await {
          crate::wallpaper::wlog(&format!("播放服务初始化失败：{error}"));
        }
        if let Err(error) = super::noise::init(&pool).await {
          crate::wallpaper::wlog(&format!("Noise 服务初始化失败：{error}"));
        }
        let _ = POOL.set(pool);
        let app_for_noise = app.clone();
        tauri::async_runtime::spawn(async move {
          if let Err(error) = super::noise::library::revalidate_startup(&app_for_noise).await {
            crate::wallpaper::wlog(&format!("Noise 素材检查失败：{error}"));
          }
        });
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
///
/// 兼容旧 `library.addSource`：内部走同一套 folders 导入规则。
pub async fn add_source(
  app: tauri::AppHandle,
  label: &str,
) -> Result<Option<SourceView>, MediaError> {
  let Some(folder) = folders::add(&app, label, None, true).await? else {
    return Ok(None);
  };
  let row = sources::get(pool()?, &folder.id)
    .await?
    .ok_or_else(|| MediaError::internal("添加音乐目录后读取失败"))?;
  let mut view = SourceView::from(row);
  if !matches!(label, "settings" | "library") {
    view.root_path = None;
  }
  Ok(Some(view))
}

pub async fn remove_source(app: tauri::AppHandle, source_id: &str) -> Result<bool, MediaError> {
  folders::remove(&app, source_id).await
}

/// 启动扫描并立即返回 job；扫描在 Tauri 异步运行时中执行。
pub async fn start_scan(app: tauri::AppHandle, source_id: &str) -> Result<ScanJobView, MediaError> {
  let pool = pool()?;
  let source = sources::get(pool, source_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  if source.kind != "local" || source.root_path.is_none() {
    return Err(MediaError::new("folders.not-found", "音乐目录不存在"));
  }
  if source.status == "scanning" {
    return Err(MediaError::new("folders.scan-busy", "该目录正在扫描"));
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
    folder_id: source.id.clone(),
    status: "running".to_string(),
  };
  let source_for_task = source.clone();
  let job_for_task = job_id.clone();
  let assets = assets_dir(&app);
  let cancel = Arc::new(AtomicBool::new(false));
  if let Ok(mut map) = scan_cancels().lock() {
    map.insert(source.id.clone(), cancel.clone());
  }
  tauri::async_runtime::spawn(async move {
    events::emit(
      &app,
      "library.scan.started",
      serde_json::json!({
        "jobId": job_for_task.clone(),
        "sourceId": source_for_task.id.clone(),
        "folderId": source_for_task.id.clone(),
      }),
    );
    let progress_app = app.clone();
    let progress_job = job_for_task.clone();
    let progress_source = source_for_task.id.clone();
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));
    let progress = move |progress: scanner::ScanProgress| {
      let should_emit = progress.processed == progress.total
        || last_emit.lock().is_ok_and(|mut at| {
          if at.elapsed() < Duration::from_millis(200) {
            false
          } else {
            *at = Instant::now();
            true
          }
        });
      if should_emit {
        events::emit_ephemeral(
          &progress_app,
          "library.scan.progress",
          serde_json::json!({
            "jobId": progress_job,
            "sourceId": progress_source,
            "folderId": progress_source,
            "processed": progress.processed,
            "total": progress.total,
            "added": progress.added,
            "updated": progress.updated,
            "skipped": progress.skipped,
          }),
        );
      }
    };
    let control = scanner::ScanControl {
      assets_dir: &assets,
      cancel: Some(cancel.as_ref()),
      on_progress: Some(&progress),
    };
    let result = scanner::scan_source(pool, &source_for_task, &job_for_task, &control).await;
    if let Ok(mut map) = scan_cancels().lock() {
      map.remove(&source_for_task.id);
    }
    let now = now_ms();
    let (status, added, updated, skipped, removed, errors) = match result {
      Ok(outcome) => {
        let errors = serde_json::to_string(&outcome.errors).unwrap_or_else(|_| "[]".to_string());
        let status = if outcome.cancelled {
          "cancelled"
        } else {
          "completed"
        };
        let _ = sqlx::query(
          "UPDATE music_scan_runs SET status = ?, finished_at = ?, \
           added = ?, updated = ?, removed = ?, errors_json = ? WHERE id = ?",
        )
        .bind(status)
        .bind(now)
        .bind(outcome.added)
        .bind(outcome.updated)
        .bind(outcome.removed)
        .bind(&errors)
        .bind(&job_for_task)
        .execute(pool)
        .await;
        if outcome.cancelled {
          let _ = sources::set_status(pool, &source_for_task.id, "active", None).await;
        } else {
          let _ = sources::mark_scanned(pool, &source_for_task.id).await;
        }
        (
          status,
          outcome.added,
          outcome.updated,
          outcome.skipped,
          outcome.removed,
          errors,
        )
      }
      Err(error) => {
        let message = error.to_string();
        crate::wallpaper::wlog(&format!("音乐扫描失败：{message}"));
        let errors = serde_json::json!([message]).to_string();
        let _ = sqlx::query(
          "UPDATE music_scan_runs SET status = 'failed', finished_at = ?, errors_json = ? \
           WHERE id = ?",
        )
        .bind(now)
        .bind(&errors)
        .bind(&job_for_task)
        .execute(pool)
        .await;
        let folder_status = if error.code == "folders.unavailable" {
          "missing"
        } else {
          "error"
        };
        let _ = sources::set_status(pool, &source_for_task.id, folder_status, Some(&message)).await;
        ("failed", 0, 0, 0, 0, errors)
      }
    };
    events::emit(
      &app,
      "library.scan.finished",
      serde_json::json!({
        "jobId": job_for_task,
        "sourceId": source_for_task.id,
        "folderId": source_for_task.id,
        "status": status,
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "removed": removed,
        "errors": serde_json::from_str::<serde_json::Value>(&errors).unwrap_or_default(),
      }),
    );
    events::changed(&app);
  });

  Ok(job)
}

/// 取消正在运行的扫描；找不到任务时返回 false，调用方可继续轮询状态。
pub fn cancel_scan(source_id: &str) -> bool {
  let token = scan_cancels()
    .lock()
    .ok()
    .and_then(|map| map.get(source_id).cloned());
  if let Some(token) = token {
    token.store(true, Ordering::SeqCst);
    true
  } else {
    false
  }
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

/// 播放历史由 playback 在真正开始播放时写入；失败只记录日志，不阻断播放。
pub async fn record_history(app: &tauri::AppHandle, track_id: &str, duration_ms: Option<i64>) {
  if let Err(error) = history::record(app, track_id, duration_ms).await {
    crate::wallpaper::wlog(&format!("记录播放历史失败：{error}"));
  }
}

pub async fn get_track(track_id: &str) -> Result<TrackDetailView, MediaError> {
  let pool = pool()?;
  let row = tracks::get(pool, track_id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  let is_file = row.kind == "file";
  let available = row.available != 0;
  let file_name = row.file_name.clone().or_else(|| {
    row
      .relative_path
      .as_deref()
      .and_then(|path| path.rsplit('/').next())
      .filter(|name| !name.is_empty())
      .map(str::to_string)
  });
  let files = if is_file {
    vec![TrackFileView {
      format: row.format.clone().unwrap_or_else(|| "unknown".to_string()),
      size_bytes: row.file_size,
      bitrate: row.bitrate,
      sample_rate: row.sample_rate,
      available,
      file_name,
      file_modified_at: row.file_modified_at,
    }]
  } else {
    Vec::new()
  };
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

  let lyrics =
    tracks::lyrics(pool, track_id)
      .await?
      .map(|lyrics| super::api::dto::TrackLyricsView {
        format: lyrics.format,
        source: lyrics.source,
        content: lyrics.content,
        offset_ms: lyrics.offset_ms,
        language: lyrics.language,
      });

  Ok(TrackDetailView {
    summary: TrackSummary::from(row),
    metadata,
    files,
    lyrics,
  })
}

pub async fn get_cover_url(
  app: &tauri::AppHandle,
  window: &tauri::WebviewWindow,
  track_id: &str,
) -> Result<Option<String>, MediaError> {
  let storage_key: Option<String> = sqlx::query_scalar(
    "SELECT ma.storage_key FROM music_track_assets mta \
     JOIN music_assets ma ON ma.id = mta.asset_id \
     WHERE mta.track_id = ? AND mta.role = 'cover' AND mta.is_primary = 1 LIMIT 1",
  )
  .bind(track_id)
  .fetch_optional(pool()?)
  .await
  .map_err(|error| MediaError::internal(format!("读取封面失败：{error}")))?
  .flatten();
  let Some(storage_key) = storage_key else {
    return Ok(None);
  };
  let path = assets_dir(app).join(storage_key);
  if !path.is_file() {
    return Ok(None);
  }
  app
    .asset_protocol_scope()
    .allow_file(&path)
    .map_err(|error| MediaError::internal(format!("封面资源授权失败：{error}")))?;
  window
    .convert_file_src(&path, None)
    .map(Some)
    .map_err(|error| MediaError::internal(format!("封面资源 URL 生成失败：{error}")))
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

pub async fn list_genres() -> Result<Vec<String>, MediaError> {
  tracks::list_genres(pool()?).await
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
  let row = match sources::find_by_root(pool, path_text).await? {
    Some(row) => row,
    None => sources::insert_local(pool, "测试音乐", path_text, true).await?,
  };
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
  let assets = path.join("assets");
  let _ = std::fs::create_dir_all(&assets);
  let control = scanner::ScanControl {
    assets_dir: &assets,
    cancel: None,
    on_progress: None,
  };
  scanner::scan_source(pool, &row, &run_id, &control).await
}

/// 设置窗等 host 窗口调用 media API 时的统一响应包装。
pub async fn call_media(
  window: tauri::WebviewWindow,
  request_id: &str,
  namespace: &str,
  method: &str,
  args: &serde_json::Value,
) -> MediaResponse {
  if matches!(namespace, "playlists" | "favorites" | "history") {
    return p3::call(window, request_id, namespace, method, args).await;
  }
  let app = window.app_handle().clone();
  let label = window.label().to_string();
  let result = match (namespace, method) {
    ("library", "listSources") => list_sources().await.map(|rows| serde_json::json!(rows)),
    ("library", "addSource") => add_source(app, &label)
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
    ("library", "cancelScan") => {
      let id = args
        .get("sourceId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 sourceId"));
      match id {
        Ok(id) => Ok(serde_json::json!({ "cancelled": cancel_scan(id) })),
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
    ("library", "getCoverUrl") => {
      let id = args
        .get("trackId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| MediaError::invalid("缺少 trackId"));
      match id {
        Ok(id) => get_cover_url(&app, &window, id)
          .await
          .map(|url| serde_json::json!({ "url": url })),
        Err(error) => Err(error),
      }
    }
    ("library", "listArtists") => list_artists()
      .await
      .map(|artists| serde_json::json!(artists)),
    ("library", "listAlbums") => list_albums().await.map(|albums| serde_json::json!(albums)),
    ("library", "listGenres") => list_genres().await.map(|genres| serde_json::json!(genres)),
    ("library", "listTags")
    | ("library", "createTag")
    | ("library", "renameTag")
    | ("library", "deleteTag")
    | ("library", "setTrackTags")
    | ("library", "updateTrackMetadata")
    | ("library", "mergeArtists")
    | ("library", "splitArtist")
    | ("library", "mergeAlbums")
    | ("library", "splitAlbum")
    | ("library", "listSmartPlaylists")
    | ("library", "createSmartPlaylist")
    | ("library", "updateSmartPlaylist")
    | ("library", "deleteSmartPlaylist")
    | ("library", "runSmartPlaylist") => p4::call(&app, method, args).await,
    ("library", "exportBackup") | ("library", "importBackup") => {
      backup::call(&app, method, args).await
    }
    ("folders", _) => folders::call(&app, &label, method, args).await,
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的媒体方法：{namespace}.{method}"),
    )),
  };

  let revision = events::revision();
  match result {
    Ok(value) => MediaResponse::ok(request_id, value, revision),
    Err(error) => MediaResponse::error(request_id, &error, revision),
  }
}
