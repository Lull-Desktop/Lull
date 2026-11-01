//! 曲库单层目录浏览。
//!
//! 目录结构来自 `music_tracks.relative_path`，不读取绝对路径，也不向前端
//! 返回 `root_path`。每次只返回当前目录的直接子目录与直接音频文件。

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::media::api::dto::{
  folder_status, DirectoryCrumb, DirectoryEntry, DirectoryFolderView, DirectoryListing,
  DirectoryLocation, DirectoryQuery, Page, TrackSummary,
};
use crate::media::api::errors::MediaError;
use crate::media::repository::sources;
use crate::media::repository::tracks::{self, TrackRow};

const ROOT_CRUMB: &str = "音乐库";

/// 归一化相对目录路径；拒绝绝对路径、盘符和 `..`。
pub fn normalize_path(raw: Option<&str>) -> Result<String, MediaError> {
  let raw = raw.unwrap_or_default().replace('\\', "/");
  if raw.contains('\0') {
    return Err(MediaError::invalid("目录路径包含非法字符"));
  }
  let raw = raw.trim_matches('/');
  let bytes = raw.as_bytes();
  if bytes.len() >= 2 && bytes[1] == b':' {
    return Err(MediaError::invalid("目录路径不能包含盘符"));
  }
  let mut segments = Vec::new();
  for segment in raw.split('/') {
    match segment {
      "" | "." => continue,
      ".." => return Err(MediaError::invalid("目录路径不能包含 ..")),
      value => segments.push(value),
    }
  }
  Ok(segments.join("/"))
}

fn escape_like(value: &str) -> String {
  value
    .replace('\\', "\\\\")
    .replace('%', "\\%")
    .replace('_', "\\_")
}

fn breadcrumbs(folder_id: &str, folder_name: &str, path: &str) -> Vec<DirectoryCrumb> {
  let mut result = vec![DirectoryCrumb {
    name: ROOT_CRUMB.to_string(),
    folder_id: None,
    path: String::new(),
  }];
  result.push(DirectoryCrumb {
    name: folder_name.to_string(),
    folder_id: Some(folder_id.to_string()),
    path: String::new(),
  });
  let mut accumulated = String::new();
  for segment in path.split('/').filter(|value| !value.is_empty()) {
    if !accumulated.is_empty() {
      accumulated.push('/');
    }
    accumulated.push_str(segment);
    result.push(DirectoryCrumb {
      name: segment.to_string(),
      folder_id: Some(folder_id.to_string()),
      path: accumulated.clone(),
    });
  }
  result
}

fn parent_location(folder_id: &str, path: &str) -> Option<DirectoryLocation> {
  if path.is_empty() {
    return Some(DirectoryLocation {
      folder_id: None,
      path: String::new(),
    });
  }
  let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
  Some(DirectoryLocation {
    folder_id: Some(folder_id.to_string()),
    path: parent.to_string(),
  })
}

fn direct_filter() -> &'static str {
  "t.folder_id = ?1 AND t.kind = 'file' AND t.relative_path IS NOT NULL \
   AND t.status = 'active' \
   AND EXISTS (SELECT 1 FROM music_sources s WHERE s.id = t.folder_id \
     AND s.status IN ('active', 'scanning')) \
   AND t.relative_path LIKE ?2 ESCAPE '\\' \
   AND instr(substr(t.relative_path, length(?3) + 1), '/') = 0"
}

pub async fn list_directory(query: &DirectoryQuery) -> Result<DirectoryListing, MediaError> {
  list_directory_at(super::pool()?, query).await
}

async fn list_directory_at(
  pool: &SqlitePool,
  query: &DirectoryQuery,
) -> Result<DirectoryListing, MediaError> {
  let page = query.page();
  let page_size = query.page_size();
  let path = normalize_path(query.path.as_deref())?;

  let Some(folder_id) = query.folder_id.as_deref().filter(|value| !value.is_empty()) else {
    if !path.is_empty() {
      return Err(MediaError::invalid("缺少 folderId"));
    }
    let folders = sources::list_folders(pool).await?;
    return Ok(DirectoryListing {
      folder: None,
      breadcrumbs: vec![DirectoryCrumb {
        name: ROOT_CRUMB.to_string(),
        folder_id: None,
        path: String::new(),
      }],
      parent: None,
      directories: folders
        .into_iter()
        .map(|folder| DirectoryEntry {
          name: folder.name,
          folder_id: folder.id,
          path: String::new(),
          track_count: folder.track_count,
        })
        .collect(),
      tracks: Page::new(Vec::new(), 0, page, page_size),
    });
  };

  let folder = sources::get_folder(pool, folder_id)
    .await?
    .ok_or_else(|| MediaError::new("folders.not-found", "音乐目录不存在"))?;
  let prefix = if path.is_empty() {
    String::new()
  } else {
    format!("{path}/")
  };
  let like = format!("{}%", escape_like(&prefix));

  // 路径列表用于推导直接子目录和子目录曲目数；只查相对路径，不读绝对路径。
  let paths: Vec<String> = sqlx::query_scalar(
    "SELECT t.relative_path FROM music_tracks t \
     WHERE t.folder_id = ?1 AND t.kind = 'file' AND t.relative_path IS NOT NULL \
       AND t.status = 'active' \
       AND EXISTS (SELECT 1 FROM music_sources s WHERE s.id = t.folder_id \
         AND s.status IN ('active', 'scanning')) \
       AND t.relative_path LIKE ?2 ESCAPE '\\'",
  )
  .bind(folder_id)
  .bind(&like)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取目录失败：{error}")))?;

  let mut directories: BTreeMap<String, (String, i64)> = BTreeMap::new();
  for relative in &paths {
    let Some(rest) = relative.strip_prefix(&prefix) else {
      continue;
    };
    let Some((name, _)) = rest.split_once('/') else {
      continue;
    };
    if name.is_empty() {
      continue;
    }
    let entry = directories
      .entry(name.to_lowercase())
      .or_insert_with(|| (name.to_string(), 0));
    entry.1 += 1;
  }

  let total: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) FROM music_tracks t WHERE {}",
    direct_filter()
  ))
  .bind(folder_id)
  .bind(&like)
  .bind(&prefix)
  .fetch_one(pool)
  .await
  .map_err(|error| MediaError::internal(format!("统计目录曲目失败：{error}")))?;

  let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);
  let sql = format!(
    "{} WHERE {} ORDER BY COALESCE(t.file_name, t.title) COLLATE NOCASE, \
     t.title COLLATE NOCASE LIMIT ?4 OFFSET ?5",
    tracks::TRACK_SELECT,
    direct_filter()
  );
  let rows: Vec<TrackRow> = sqlx::query_as(&sql)
    .bind(folder_id)
    .bind(&like)
    .bind(&prefix)
    .bind(i64::from(page_size))
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(|error| MediaError::internal(format!("读取目录曲目失败：{error}")))?;

  let directory_entries = directories
    .into_values()
    .map(|(name, track_count)| DirectoryEntry {
      path: if path.is_empty() {
        name.clone()
      } else {
        format!("{path}/{name}")
      },
      name,
      folder_id: folder_id.to_string(),
      track_count,
    })
    .collect();

  Ok(DirectoryListing {
    folder: Some(DirectoryFolderView {
      id: folder.id.clone(),
      name: folder.name.clone(),
      status: folder_status(&folder.status),
    }),
    breadcrumbs: breadcrumbs(folder_id, &folder.name, &path),
    parent: parent_location(folder_id, &path),
    directories: directory_entries,
    tracks: Page::new(
      rows.into_iter().map(TrackSummary::from).collect(),
      total,
      page,
      page_size,
    ),
  })
}

pub async fn call(method: &str, args: &Value) -> Result<Value, MediaError> {
  match method {
    "listDirectory" => {
      let query = serde_json::from_value::<DirectoryQuery>(args.clone())
        .map_err(|error| MediaError::invalid(format!("目录查询参数无效：{error}")))?;
      Ok(serde_json::json!(list_directory(&query).await?))
    }
    _ => Err(MediaError::invalid(format!("不支持的目录方法：{method}"))),
  }
}

#[cfg(test)]
mod tests {
  use super::{list_directory_at, normalize_path};
  use crate::media::api::dto::DirectoryQuery;
  use crate::media::repository::{db, sources};

  #[test]
  fn normalizes_relative_paths_and_rejects_escape() {
    assert_eq!(normalize_path(None).expect("empty"), "");
    assert_eq!(
      normalize_path(Some("/Rock//Live/")).expect("normalize"),
      "Rock/Live"
    );
    assert_eq!(
      normalize_path(Some(r"Rock\Live")).expect("separators"),
      "Rock/Live"
    );
    assert!(normalize_path(Some("../Rock")).is_err());
    assert!(normalize_path(Some("C:/Rock")).is_err());
    assert!(normalize_path(Some("Rock/../Live")).is_err());
  }

  #[test]
  fn lists_only_immediate_children_and_parent() {
    let dir = std::env::temp_dir().join(format!("lull-directory-test-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).expect("create dir");
    tauri::async_runtime::block_on(async {
      let pool = db::open_at(&dir.join("music.db")).await.expect("open db");
      let folder = sources::insert_local(&pool, "Test", dir.to_str().expect("root utf8"), true)
        .await
        .expect("folder");
      for (id, relative, file_name) in [
        ("trk_a", "A.flac", "A.flac"),
        ("trk_b", "Rock/B.flac", "B.flac"),
        ("trk_c", "Rock/Live/C.flac", "C.flac"),
      ] {
        sqlx::query(
          "INSERT INTO music_tracks \
           (id, kind, title, status, added_at, updated_at, folder_id, relative_path, file_name, file_size) \
           VALUES (?, 'file', ?, 'active', 1, 1, ?, ?, ?, 1)",
        )
        .bind(id)
        .bind(id)
        .bind(&folder.id)
        .bind(relative)
        .bind(file_name)
        .execute(&pool)
        .await
        .expect("track");
      }

      let root = list_directory_at(
        &pool,
        &DirectoryQuery {
          folder_id: Some(folder.id.clone()),
          ..DirectoryQuery::default()
        },
      )
      .await
      .expect("root listing");
      assert_eq!(root.directories.len(), 1);
      assert_eq!(root.directories[0].name, "Rock");
      assert_eq!(root.directories[0].track_count, 2);
      assert_eq!(root.tracks.items.len(), 1);
      assert_eq!(root.tracks.items[0].id, "trk_a");
      assert_eq!(
        root
          .parent
          .as_ref()
          .and_then(|parent| parent.folder_id.as_deref()),
        None
      );

      let rock = list_directory_at(
        &pool,
        &DirectoryQuery {
          folder_id: Some(folder.id.clone()),
          path: Some("Rock".to_string()),
          ..DirectoryQuery::default()
        },
      )
      .await
      .expect("rock listing");
      assert_eq!(rock.directories.len(), 1);
      assert_eq!(rock.directories[0].name, "Live");
      assert_eq!(rock.tracks.items.len(), 1);
      assert_eq!(rock.tracks.items[0].id, "trk_b");
      assert_eq!(
        rock.parent.as_ref().map(|parent| parent.path.as_str()),
        Some("")
      );

      let live = list_directory_at(
        &pool,
        &DirectoryQuery {
          folder_id: Some(folder.id),
          path: Some("Rock/Live".to_string()),
          ..DirectoryQuery::default()
        },
      )
      .await
      .expect("live listing");
      assert!(live.directories.is_empty());
      assert_eq!(live.tracks.items[0].id, "trk_c");
      assert_eq!(
        live.parent.as_ref().map(|parent| parent.path.as_str()),
        Some("Rock")
      );
    });
    let _ = std::fs::remove_dir_all(&dir);
  }
}
