//! 歌单业务门面：CRUD、Track 顺序与 M3U 导入导出。
//!
//! M3U 只允许 host/library 窗口调用；文件路径只在本模块内部使用，不进入 DTO。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::events;
use super::pool;
use crate::media::api::dto::{
  M3uExportResult, M3uImportResult, PlaylistDetail, PlaylistEntry, PlaylistSummary, TrackSummary,
};
use crate::media::api::errors::MediaError;
use crate::media::repository::{playlists, tracks};

pub async fn list() -> Result<Vec<PlaylistSummary>, MediaError> {
  let rows = playlists::list(pool()?).await?;
  Ok(rows.into_iter().map(summary).collect())
}

pub async fn get(playlist_id: &str) -> Result<PlaylistDetail, MediaError> {
  let pool = pool()?;
  let row = playlists::get(pool, playlist_id)
    .await?
    .ok_or_else(|| MediaError::new("playlist.not-found", "歌单不存在"))?;
  let mut entries = Vec::new();
  for track in playlists::entries(pool, playlist_id).await? {
    entries.push(PlaylistEntry {
      track_id: track.id.clone(),
      track: Some(TrackSummary::from(track)),
    });
  }
  Ok(PlaylistDetail {
    summary: summary(row),
    entries,
  })
}

pub async fn create(
  app: &AppHandle,
  name: &str,
  description: Option<&str>,
) -> Result<PlaylistDetail, MediaError> {
  let name = validate_name(name)?;
  let row = playlists::create(pool()?, &name, description).await?;
  events::emit(
    app,
    "playlists.changed",
    serde_json::json!({ "playlistId": row.id }),
  );
  get(&row.id).await
}

pub async fn update(
  app: &AppHandle,
  playlist_id: &str,
  name: Option<&str>,
  description: Option<&str>,
) -> Result<PlaylistDetail, MediaError> {
  let name = name.map(validate_name).transpose()?;
  playlists::update(pool()?, playlist_id, name.as_deref(), description).await?;
  events::emit(
    app,
    "playlists.changed",
    serde_json::json!({ "playlistId": playlist_id }),
  );
  get(playlist_id).await
}

pub async fn remove(app: &AppHandle, playlist_id: &str) -> Result<bool, MediaError> {
  let removed = playlists::remove(pool()?, playlist_id).await?;
  if removed {
    events::emit(
      app,
      "playlists.changed",
      serde_json::json!({ "playlistId": playlist_id, "removed": true }),
    );
  }
  Ok(removed)
}

pub async fn add_track(
  app: &AppHandle,
  playlist_id: &str,
  track_id: &str,
) -> Result<(), MediaError> {
  playlists::add_track(pool()?, playlist_id, track_id).await?;
  events::emit(
    app,
    "playlists.changed",
    serde_json::json!({ "playlistId": playlist_id, "trackId": track_id }),
  );
  Ok(())
}

pub async fn remove_track(
  app: &AppHandle,
  playlist_id: &str,
  track_id: &str,
) -> Result<bool, MediaError> {
  let removed = playlists::remove_track(pool()?, playlist_id, track_id).await?;
  if removed {
    events::emit(
      app,
      "playlists.changed",
      serde_json::json!({ "playlistId": playlist_id, "trackId": track_id }),
    );
  }
  Ok(removed)
}

pub async fn reorder(
  app: &AppHandle,
  playlist_id: &str,
  track_id: &str,
  position: usize,
) -> Result<bool, MediaError> {
  let moved = playlists::reorder(pool()?, playlist_id, track_id, position).await?;
  if moved {
    events::emit(
      app,
      "playlists.changed",
      serde_json::json!({ "playlistId": playlist_id, "trackId": track_id }),
    );
  }
  Ok(moved)
}

/// 导入 M3U：先选文件，再按库内已扫描的 path_key 匹配 Track；不新建来源、不扫描。
pub async fn import_m3u(app: &AppHandle) -> Result<M3uImportResult, MediaError> {
  let picked = tauri::async_runtime::spawn_blocking(|| {
    rfd::FileDialog::new()
      .set_title("导入 M3U 歌单")
      .add_filter("M3U", &["m3u", "m3u8"])
      .pick_file()
  })
  .await
  .map_err(|error| MediaError::internal(format!("打开 M3U 文件选择器失败：{error}")))?;
  let Some(path) = picked else {
    return Err(MediaError::new("playlist.cancelled", "未选择 M3U 文件"));
  };
  let text = std::fs::read_to_string(&path)
    .map_err(|error| MediaError::invalid(format!("读取 M3U 失败：{error}")))?;
  let name = path
    .file_stem()
    .and_then(|value| value.to_str())
    .filter(|value| !value.trim().is_empty())
    .unwrap_or("导入的歌单");
  let name: String = name.chars().take(80).collect();
  let parent = path.parent().unwrap_or_else(|| Path::new("."));
  let mut playlist = create(app, &name, None).await?;
  let mut missing = Vec::new();
  let mut imported = 0_i64;
  for candidate in parse_m3u_paths(&text, parent) {
    match resolve_path(&candidate).await? {
      Some(track_id) => {
        if playlists::add_track(pool()?, &playlist.summary.id, &track_id).await? {
          imported += 1;
        }
      }
      None => missing.push(
        candidate
          .file_name()
          .and_then(|value| value.to_str())
          .unwrap_or("未知文件")
          .to_string(),
      ),
    }
  }
  playlist = get(&playlist.summary.id).await?;
  events::emit(
    app,
    "playlists.changed",
    serde_json::json!({ "playlistId": playlist.summary.id, "imported": imported }),
  );
  Ok(M3uImportResult {
    playlist,
    imported,
    missing,
  })
}

/// 导出 M3U：本地曲目写绝对路径，内置曲跳过；不返回路径给 UI。
pub async fn export_m3u(playlist_id: &str) -> Result<M3uExportResult, MediaError> {
  let playlist = get(playlist_id).await?;
  let default_name = format!("{}.m3u", sanitize_file_name(&playlist.summary.name));
  let picked = tauri::async_runtime::spawn_blocking(move || {
    rfd::FileDialog::new()
      .set_title("导出 M3U 歌单")
      .set_file_name(default_name)
      .add_filter("M3U", &["m3u"])
      .save_file()
  })
  .await
  .map_err(|error| MediaError::internal(format!("打开 M3U 保存对话框失败：{error}")))?;
  let Some(path) = picked else {
    return Err(MediaError::new("playlist.cancelled", "未选择保存位置"));
  };

  let pool = pool()?;
  let mut lines = vec!["#EXTM3U".to_string()];
  let mut exported = 0_i64;
  let mut skipped = 0_i64;
  for entry in &playlist.entries {
    let Some(track) = entry.track.as_ref() else {
      skipped += 1;
      continue;
    };
    let Some(file_path) = tracks::playable_path(pool, &track.id).await? else {
      skipped += 1;
      continue;
    };
    let seconds = track.duration_ms.unwrap_or(0).max(0) / 1000;
    let artists = if track.artists.is_empty() {
      "Lull".to_string()
    } else {
      track.artists.join(", ")
    };
    lines.push(format!("#EXTINF:{seconds},{artists} - {}", track.title));
    lines.push(file_path);
    exported += 1;
  }
  if exported == 0 {
    return Err(MediaError::new(
      "playlist.m3u-empty",
      "歌单里没有可导出的本地曲目",
    ));
  }
  std::fs::write(&path, format!("{}\n", lines.join("\n")))
    .map_err(|error| MediaError::internal(format!("写入 M3U 失败：{error}")))?;
  Ok(M3uExportResult { exported, skipped })
}

fn summary(row: playlists::PlaylistRow) -> PlaylistSummary {
  PlaylistSummary {
    id: row.id,
    name: row.name,
    description: row.description.filter(|value| !value.trim().is_empty()),
    track_count: row.track_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

fn validate_name(name: &str) -> Result<String, MediaError> {
  let name = name.trim();
  if name.is_empty() {
    return Err(MediaError::invalid("歌单名称不能为空"));
  }
  if name.chars().count() > 80 {
    return Err(MediaError::invalid("歌单名称不能超过 80 个字符"));
  }
  Ok(name.to_string())
}

fn sanitize_file_name(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|character| match character {
      '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      _ => character,
    })
    .collect();
  let cleaned = cleaned.trim();
  if cleaned.is_empty() {
    "lull-playlist".to_string()
  } else {
    cleaned.to_string()
  }
}

/// 解析 M3U/M3U8 中的本地路径；忽略注释、URL 和空行。
fn parse_m3u_paths(text: &str, parent: &Path) -> Vec<PathBuf> {
  let mut paths = Vec::new();
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    if line.contains("://") {
      continue;
    }
    let path = Path::new(line);
    paths.push(if path.is_absolute() {
      path.to_path_buf()
    } else {
      parent.join(path)
    });
  }
  paths
}

async fn resolve_path(path: &Path) -> Result<Option<String>, MediaError> {
  let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
  tracks::find_by_path(pool()?, &canonical).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn m3u_parser_keeps_local_paths_and_ignores_urls() {
    let parent = Path::new(r"C:\Music");
    let paths = parse_m3u_paths(
      "#EXTM3U\n#EXTINF:12,Artist - Title\nsong.mp3\n\nhttp://example.com/stream\nC:\\Other\\two.flac\n",
      parent,
    );
    assert_eq!(paths.len(), 2);
    assert_eq!(paths[0], parent.join("song.mp3"));
    assert_eq!(paths[1], PathBuf::from(r"C:\Other\two.flac"));
  }

  #[test]
  fn m3u_file_name_is_sanitized() {
    assert_eq!(sanitize_file_name("Rain / Night"), "Rain _ Night");
    assert_eq!(sanitize_file_name("   "), "lull-playlist");
  }
}
