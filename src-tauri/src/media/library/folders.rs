//! 物理目录（MusicFolder）门面。
//!
//! 内部继续复用 `music_sources(kind='local')`；这里负责对外的目录语义：
//! 导入规则、显示名、目录列表/计数、移除、目录内曲目查询与 API 分发。

use std::path::{Path, PathBuf};

use serde_json::Value;
use sqlx::SqlitePool;
use tauri::AppHandle;

use super::events;
use super::scanner;
use crate::media::api::dto::{
  FolderTrackView, MusicFolderView, Page, TrackImportView, TrackQuery, TrackSummary,
};
use crate::media::api::errors::MediaError;
use crate::media::repository::{sources, tracks};

fn normalize_path_key(path: &str) -> String {
  let normalized = path.replace('\\', "/").to_lowercase();
  normalized.trim_end_matches('/').to_string()
}

fn is_within(child: &str, parent: &str) -> bool {
  child == parent
    || child
      .strip_prefix(parent)
      .is_some_and(|rest| rest.starts_with('/'))
}

async fn ensure_not_overlapping(
  pool: &sqlx::SqlitePool,
  root_path: &str,
) -> Result<(), MediaError> {
  let key = normalize_path_key(root_path);
  for (_, existing_root) in sources::list_local_roots(pool).await? {
    let existing = normalize_path_key(&existing_root);
    if existing == key {
      return Err(MediaError::new("folders.duplicate", "这个目录已经导入过了"));
    }
    if is_within(&key, &existing) || is_within(&existing, &key) {
      return Err(MediaError::new(
        "folders.overlap",
        "该目录与已导入目录存在父子关系，请先移除已有目录",
      ));
    }
  }
  Ok(())
}

pub async fn list() -> Result<Vec<MusicFolderView>, MediaError> {
  let pool = super::pool()?;
  revalidate(pool).await?;
  let rows = sources::list_folders(pool).await?;
  Ok(rows.into_iter().map(MusicFolderView::from).collect())
}

pub async fn get(folder_id: &str) -> Result<MusicFolderView, MediaError> {
  let pool = super::pool()?;
  sources::get_folder(pool, folder_id)
    .await?
    .map(MusicFolderView::from)
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))
}

pub async fn add(
  app: &AppHandle,
  label: &str,
  path: Option<&str>,
  recursive: bool,
) -> Result<Option<MusicFolderView>, MediaError> {
  // Widget 只能通过系统选择器添加目录，不能自带任意路径。
  let allow_path = matches!(label, "settings" | "library");
  let path = if allow_path { path } else { None };
  let picked = match path {
    Some(path) => Some(PathBuf::from(path)),
    None => tauri::async_runtime::spawn_blocking(|| {
      rfd::FileDialog::new()
        .set_title("选择音乐文件夹")
        .pick_folder()
    })
    .await
    .map_err(|error| MediaError::internal(format!("打开目录选择器失败：{error}")))?,
  };
  let Some(path) = picked else {
    return Ok(None);
  };
  let path = dunce::canonicalize(&path)
    .map_err(|error| MediaError::new("folders.invalid-path", format!("目录不可用：{error}")))?;
  if !path.is_dir() {
    return Err(MediaError::new(
      "folders.invalid-path",
      "选择的路径不是目录",
    ));
  }
  let path_text = path
    .to_str()
    .ok_or_else(|| MediaError::new("folders.invalid-path", "目录路径不是合法 UTF-8"))?
    .to_string();
  let name = path
    .file_name()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("音乐")
    .to_string();
  let pool = super::pool()?;
  ensure_not_overlapping(pool, &path_text).await?;
  let row = sources::insert_local(pool, &name, &path_text, recursive).await?;
  events::changed(app);
  let folder = sources::get_folder(pool, &row.id)
    .await?
    .ok_or_else(|| MediaError::internal("添加音乐目录后读取失败"))?;
  Ok(Some(MusicFolderView::from(folder)))
}

pub async fn rename(
  app: &AppHandle,
  folder_id: &str,
  name: &str,
) -> Result<MusicFolderView, MediaError> {
  let name = name.trim();
  if name.is_empty() {
    return Err(MediaError::new("folders.invalid-name", "目录名称不能为空"));
  }
  if name.chars().count() > 120 {
    return Err(MediaError::new(
      "folders.invalid-name",
      "目录名称不能超过 120 个字符",
    ));
  }
  let pool = super::pool()?;
  sources::get_folder(pool, folder_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  sources::rename(pool, folder_id, name).await?;
  events::changed(app);
  get(folder_id).await
}

pub async fn remove(app: &AppHandle, folder_id: &str) -> Result<bool, MediaError> {
  let pool = super::pool()?;
  let source = sources::get(pool, folder_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  if source.kind != "local" {
    return Err(MediaError::new("folders.not-found", "音乐目录不存在"));
  }
  if source.status == "scanning" {
    return Err(MediaError::new(
      "folders.scan-busy",
      "目录正在扫描，请先取消扫描",
    ));
  }
  let removed = sources::remove(pool, folder_id).await?;
  if !removed {
    // 删前检查与扫描启动之间可能有竞态；以数据库最终状态为准。
    if let Some(current) = sources::get(pool, folder_id).await? {
      if current.status == "scanning" {
        return Err(MediaError::new(
          "folders.scan-busy",
          "目录正在扫描，请先取消扫描",
        ));
      }
    }
  }
  if removed {
    events::changed(app);
  }
  Ok(removed)
}

/// 删除「单曲导入」目录中的一条曲目。
///
/// 普通目录不经过这里：它们的曲目由磁盘扫描维护，单条删除会在下次扫描时
/// 被重新发现。只有 `root_path IS NULL` 的单曲目录没有扫描入口，删库记录
/// 才是持久的。磁盘文件永远不动。
async fn delete_single_track(
  pool: &SqlitePool,
  folder_id: &str,
  track_id: &str,
) -> Result<bool, MediaError> {
  let folder = sources::get_folder(pool, folder_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  if folder.root_path.is_some() {
    return Err(MediaError::new(
      "folders.not-singles",
      "只能从「单曲导入」目录删除单曲",
    ));
  }

  let track = sqlx::query_as::<_, (String, Option<String>)>(
    "SELECT kind, folder_id FROM music_tracks WHERE id = ?",
  )
  .bind(track_id)
  .fetch_optional(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取曲目失败：{error}")))?
  .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  if track.0 != "file" || track.1.as_deref() != Some(folder_id) {
    return Err(MediaError::new(
      "folders.track-mismatch",
      "曲目不属于该目录",
    ));
  }

  let result = sqlx::query("DELETE FROM music_tracks WHERE id = ? AND folder_id = ?")
    .bind(track_id)
    .bind(folder_id)
    .execute(pool)
    .await
    .map_err(|error| MediaError::internal(format!("删除单曲失败：{error}")))?;
  Ok(result.rows_affected() > 0)
}

/// 单曲目录的删除入口：删库记录、清理内存播放引用并广播资料库变更。
pub async fn remove_track(
  app: &AppHandle,
  folder_id: &str,
  track_id: &str,
) -> Result<bool, MediaError> {
  let pool = super::pool()?;
  let removed = delete_single_track(pool, folder_id, track_id).await?;
  if removed {
    crate::media::playback::forget_track(app, pool, track_id);
    events::changed(app);
  }
  Ok(removed)
}

pub async fn get_tracks(
  folder_id: &str,
  query: &TrackQuery,
) -> Result<Page<FolderTrackView>, MediaError> {
  let pool = super::pool()?;
  sources::get_folder(pool, folder_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  let mut query = query.clone();
  query.folder_id = Some(folder_id.to_string());
  query.include_unavailable = Some(true);
  let (rows, total) = tracks::list(pool, &query).await?;
  let items = rows
    .into_iter()
    .map(|row| {
      let relative_path = row.relative_path.clone().unwrap_or_default();
      FolderTrackView {
        summary: TrackSummary::from(row),
        relative_path,
      }
    })
    .collect();
  Ok(Page::new(items, total, query.page(), query.page_size()))
}

/// 启动或列表时校正目录可用性；扫描中的目录不在这里改状态。
///
/// 「单曲导入」目录没有物理根目录，文件是否缺失由播放前检查决定。
pub async fn revalidate(pool: &sqlx::SqlitePool) -> Result<(), MediaError> {
  for row in sources::list_folders(pool).await? {
    if row.status == "scanning" {
      continue;
    }
    let Some(root_path) = row.root_path.as_deref() else {
      continue;
    };
    let exists = Path::new(root_path).is_dir();
    if !exists && row.status != "missing" {
      sources::set_status(pool, &row.id, "missing", Some("目录不可用")).await?;
    } else if exists && row.status == "missing" {
      sources::set_status(pool, &row.id, "active", None).await?;
    }
  }
  Ok(())
}

fn singles_name(name: Option<&str>) -> Result<String, MediaError> {
  let name = name
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("单曲导入");
  if name.chars().count() > 120 {
    return Err(MediaError::new(
      "folders.invalid-name",
      "目录名称不能超过 120 个字符",
    ));
  }
  Ok(name.to_string())
}

async fn ensure_singles_source(
  pool: &SqlitePool,
  name: &str,
) -> Result<sources::SourceRow, MediaError> {
  if let Some(row) = sources::find_singles(pool).await? {
    return Ok(row);
  }
  sources::insert_singles(pool, name).await
}

/// 单曲导入只对 host 窗口与已获授权的 Widget 开放。
///
/// 上游 `media_call` 已按 `media.library.sources.write` 校验；这里再挡一次
/// 非插件窗口，避免未来新增的 host 入口绕过权限矩阵。
fn can_import_singles(label: &str) -> bool {
  matches!(label, "settings" | "library") || crate::widget_package::is_plugin_label(label)
}

fn file_label(path: &Path) -> String {
  path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("未知文件")
    .to_string()
}

/// 导入一组用户选择的音频文件；与系统文件选择器解耦，便于测试复用。
pub async fn import_singles(
  pool: &SqlitePool,
  paths: &[PathBuf],
  assets_dir: &Path,
  name: Option<&str>,
) -> Result<TrackImportView, MediaError> {
  let source = ensure_singles_source(pool, &singles_name(name)?).await?;
  let mut added = 0_i64;
  let mut updated = 0_i64;
  let mut skipped = 0_i64;
  let mut failed = 0_i64;
  let mut errors = Vec::new();
  for path in paths {
    // 已经由目录导入的同一文件不要重复进「单曲导入」；单曲目录内的文件
    // 继续交给 scanner 做增量更新。
    match tracks::find_by_path(pool, path).await {
      Ok(Some(track_id)) => {
        let folder_id: Option<String> =
          sqlx::query_scalar("SELECT folder_id FROM music_tracks WHERE id = ?")
            .bind(&track_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| MediaError::internal(format!("读取曲目目录失败：{error}")))?;
        if folder_id.as_deref() != Some(source.id.as_str()) {
          skipped += 1;
          continue;
        }
      }
      Ok(None) => {}
      Err(error) => {
        failed += 1;
        if errors.len() < 10 {
          errors.push(format!("{}：{}", file_label(path), error.message));
        }
        continue;
      }
    }
    match scanner::import_single(pool, &source, path, assets_dir).await {
      Ok(scanner::ImportOutcome::Added) => added += 1,
      Ok(scanner::ImportOutcome::Updated) => updated += 1,
      Ok(scanner::ImportOutcome::Skipped) => skipped += 1,
      Err(error) => {
        failed += 1;
        if errors.len() < 10 {
          errors.push(format!("{}：{}", file_label(path), error.message));
        }
      }
    }
  }
  let folder = sources::get_folder(pool, &source.id)
    .await?
    .ok_or_else(|| MediaError::internal("读取单曲导入目录失败"))?;
  Ok(TrackImportView {
    folder: MusicFolderView::from(folder),
    added,
    updated,
    skipped,
    failed,
    errors,
  })
}

/// 打开系统文件选择器，把选中的音频文件导入「单曲导入」目录。
pub async fn add_singles(
  app: &AppHandle,
  label: &str,
  name: Option<&str>,
) -> Result<Option<TrackImportView>, MediaError> {
  if !can_import_singles(label) {
    return Err(MediaError::new(
      "capability.denied",
      "当前窗口没有音乐目录权限",
    ));
  }
  let picked = tauri::async_runtime::spawn_blocking(|| {
    rfd::FileDialog::new()
      .set_title("选择音乐文件")
      .add_filter("音频文件", scanner::AUDIO_EXTENSIONS)
      .pick_files()
  })
  .await
  .map_err(|error| MediaError::internal(format!("打开文件选择器失败：{error}")))?;
  let Some(paths) = picked else {
    return Ok(None);
  };
  let pool = super::pool()?;
  let result = import_singles(pool, &paths, &super::assets_dir(app), name).await?;
  events::changed(app);
  Ok(Some(result))
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, MediaError> {
  args
    .get(key)
    .and_then(Value::as_str)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

pub async fn call(
  app: &AppHandle,
  label: &str,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  match method {
    "list" => Ok(serde_json::json!(list().await?)),
    "get" => {
      let id = required_str(args, "folderId")?;
      Ok(serde_json::json!(get(id).await?))
    }
    "add" => {
      let path = args.get("path").and_then(Value::as_str);
      let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
      let added = add(app, label, path, recursive).await?;
      // Widget 不拿 rootPath；host 窗口正常返回完整目录视图。
      match added {
        Some(folder) if !matches!(label, "settings" | "library") => {
          let mut value = serde_json::to_value(folder)
            .map_err(|error| MediaError::internal(format!("序列化目录失败：{error}")))?;
          if let Some(object) = value.as_object_mut() {
            object.remove("rootPath");
          }
          Ok(value)
        }
        Some(folder) => Ok(serde_json::json!(folder)),
        None => Ok(Value::Null),
      }
    }
    "addSingles" => {
      let name = args.get("name").and_then(Value::as_str);
      Ok(serde_json::json!(add_singles(app, label, name).await?))
    }
    "rename" => {
      let id = required_str(args, "folderId")?;
      let name = required_str(args, "name")?;
      Ok(serde_json::json!(rename(app, id, name).await?))
    }
    "remove" => {
      let id = required_str(args, "folderId")?;
      Ok(serde_json::json!({ "removed": remove(app, id).await? }))
    }
    "removeTrack" => {
      let folder_id = required_str(args, "folderId")?;
      let track_id = required_str(args, "trackId")?;
      Ok(serde_json::json!({
        "removed": remove_track(app, folder_id, track_id).await?
      }))
    }
    "scan" => {
      let id = required_str(args, "folderId")?;
      Ok(serde_json::json!(super::start_scan(app.clone(), id).await?))
    }
    "cancelScan" => {
      let id = required_str(args, "folderId")?;
      Ok(serde_json::json!({ "cancelled": super::cancel_scan(id) }))
    }
    "getTracks" => {
      let id = required_str(args, "folderId")?;
      let query = serde_json::from_value::<TrackQuery>(args.clone())
        .map_err(|error| MediaError::invalid(format!("曲目查询参数无效：{error}")))?;
      Ok(serde_json::json!(get_tracks(id, &query).await?))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的媒体方法：folders.{method}"),
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::media::repository::db;

  fn temp_db(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("lull-folders-{name}-{}.db", uuid::Uuid::now_v7()))
  }

  #[test]
  fn path_overlap_is_component_aware() {
    assert_eq!(normalize_path_key(r"C:\Music\"), "c:/music");
    assert!(is_within("c:/music/pop", "c:/music"));
    assert!(!is_within("c:/music2", "c:/music"));
    assert!(is_within("c:", "c:"));
  }

  #[test]
  fn singles_import_allows_hosts_and_widgets_only() {
    assert!(can_import_singles("settings"));
    assert!(can_import_singles("library"));
    assert!(can_import_singles("widget-player"));
    assert!(!can_import_singles("player"));
    assert!(!can_import_singles("noise"));
    assert!(!can_import_singles("widget-"));
  }

  #[test]
  fn duplicate_and_nested_folders_are_rejected() {
    let path = temp_db("overlap");
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&path).await.expect("open db");
      sources::insert_local(&pool, "Music", r"C:\Music", true)
        .await
        .expect("insert parent");

      let duplicate = ensure_not_overlapping(&pool, r"c:/music/").await;
      let nested = ensure_not_overlapping(&pool, r"C:\Music\Pop").await;
      let parent_of_existing = ensure_not_overlapping(&pool, r"C:\").await;
      let sibling = ensure_not_overlapping(&pool, r"C:\Other").await;
      db::close(&pool).await;

      assert_eq!(duplicate.expect_err("duplicate").code, "folders.duplicate");
      assert_eq!(nested.expect_err("nested").code, "folders.overlap");
      assert_eq!(
        parent_of_existing.expect_err("parent").code,
        "folders.overlap"
      );
      assert!(sibling.is_ok());
    });
    let _ = std::fs::remove_file(&path);
  }

  fn write_silence_wav(path: &Path) {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&36_u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&44_100_u32.to_le_bytes());
    bytes.extend_from_slice(&88_200_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    std::fs::write(path, bytes).expect("write wav");
  }

  #[test]
  fn single_import_creates_virtual_folder_and_skips_duplicates() {
    let root = std::env::temp_dir().join(format!("lull-singles-import-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create dir");
    let file = root.join("single.wav");
    write_silence_wav(&file);
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).expect("assets");
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&db_path).await.expect("open db");
      let first = import_singles(
        &pool,
        std::slice::from_ref(&file),
        &assets,
        Some("单曲导入"),
      )
      .await
      .expect("import single");
      assert_eq!(first.added, 1);
      assert_eq!(first.folder.name, "单曲导入");
      assert_eq!(first.folder.root_path, None);
      assert_eq!(first.folder.track_count, 1);

      let folders = sources::list_folders(&pool).await.expect("list folders");
      assert_eq!(folders.len(), 1);
      assert_eq!(folders[0].id, first.folder.id);
      assert_eq!(folders[0].root_path, None);

      let track_id: String = sqlx::query_scalar("SELECT id FROM music_tracks WHERE folder_id = ?")
        .bind(&first.folder.id)
        .fetch_one(&pool)
        .await
        .expect("track id");
      let playable = tracks::playable_path(&pool, &track_id)
        .await
        .expect("playable");
      let expected = file.to_string_lossy().replace('\\', "/");
      assert_eq!(playable.as_deref(), Some(expected.as_str()));

      let second = import_singles(
        &pool,
        std::slice::from_ref(&file),
        &assets,
        Some("单曲导入"),
      )
      .await
      .expect("import again");
      assert_eq!(second.added, 0);
      assert_eq!(second.skipped, 1);
      assert_eq!(
        sources::list_folders(&pool).await.expect("folders").len(),
        1
      );
      db::close(&pool).await;
    });
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn removing_folder_cascades_tracks_and_keeps_file() {
    let root = std::env::temp_dir().join(format!("lull-folders-remove-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create dir");
    let file = root.join("song.wav");
    std::fs::write(&file, b"wav").expect("write file");
    let db_path = root.join("music.db");
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&db_path).await.expect("open db");
      let folder = sources::insert_local(&pool, "测试", root.to_str().expect("root utf8"), true)
        .await
        .expect("folder");
      sqlx::query(
        "INSERT INTO music_tracks \
         (id, kind, title, status, added_at, updated_at, folder_id, relative_path, \
          file_size, file_modified_at, format) \
         VALUES ('trk_1', 'file', '歌', 'active', 1, 1, ?, 'song.wav', 3, 1, 'wav')",
      )
      .bind(&folder.id)
      .execute(&pool)
      .await
      .expect("track");
      sources::remove(&pool, &folder.id).await.expect("remove");
      let tracks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks")
        .fetch_one(&pool)
        .await
        .expect("count");
      db::close(&pool).await;
      assert_eq!(tracks, 0);
      assert!(file.is_file());
    });
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn single_track_removal_is_scoped_to_singles_folder() {
    let root = std::env::temp_dir().join(format!("lull-singles-remove-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).expect("create dir");
    let first_file = root.join("first.wav");
    let second_file = root.join("second.wav");
    write_silence_wav(&first_file);
    write_silence_wav(&second_file);
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).expect("assets");
    let album = root.join("album");
    std::fs::create_dir_all(&album).expect("album");
    let db_path = root.join("music.db");

    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&db_path).await.expect("open db");
      let imported = import_singles(
        &pool,
        &[first_file.clone(), second_file.clone()],
        &assets,
        Some("单曲导入"),
      )
      .await
      .expect("import singles");
      assert_eq!(imported.added, 2);

      let physical =
        sources::insert_local(&pool, "Album", album.to_str().expect("album utf8"), true)
          .await
          .expect("physical folder");
      sqlx::query(
        "INSERT INTO music_tracks \
         (id, kind, title, status, added_at, updated_at, folder_id, relative_path, \
          file_size, file_modified_at, format) \
         VALUES ('trk_dir', 'file', '目录曲目', 'active', 1, 1, ?, 'dir.wav', 3, 1, 'wav')",
      )
      .bind(&physical.id)
      .execute(&pool)
      .await
      .expect("directory track");

      let single_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM music_tracks WHERE folder_id = ? ORDER BY file_name, id",
      )
      .bind(&imported.folder.id)
      .fetch_all(&pool)
      .await
      .expect("single ids");
      assert_eq!(single_ids.len(), 2);

      assert!(
        delete_single_track(&pool, &imported.folder.id, &single_ids[0])
          .await
          .expect("delete single")
      );
      let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks WHERE folder_id = ?")
          .bind(&imported.folder.id)
          .fetch_one(&pool)
          .await
          .expect("remaining singles");
      assert_eq!(remaining, 1);
      let folder = sources::get_folder(&pool, &imported.folder.id)
        .await
        .expect("folder")
        .expect("folder exists");
      assert_eq!(folder.track_count, 1);
      // 删库记录不动磁盘文件。
      assert!(first_file.is_file());
      assert!(second_file.is_file());

      let error = delete_single_track(&pool, &physical.id, "trk_dir")
        .await
        .expect_err("physical folder must be rejected");
      assert_eq!(error.code, "folders.not-singles");
      let directory_tracks: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM music_tracks WHERE folder_id = ?")
          .bind(&physical.id)
          .fetch_one(&pool)
          .await
          .expect("directory tracks");
      assert_eq!(directory_tracks, 1);

      let error = delete_single_track(&pool, &imported.folder.id, "trk_dir")
        .await
        .expect_err("track from another folder must be rejected");
      assert_eq!(error.code, "folders.track-mismatch");

      let error = delete_single_track(&pool, &imported.folder.id, "trk_missing")
        .await
        .expect_err("missing track");
      assert_eq!(error.code, "track.not-found");

      db::close(&pool).await;
    });
    let _ = std::fs::remove_dir_all(&root);
  }
}
