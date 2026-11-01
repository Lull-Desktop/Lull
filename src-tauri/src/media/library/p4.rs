//! P4：元数据编辑、标签、实体合并/拆分与智能歌单。
//!
//! 用户编辑写入 `music_track_metadata.overrides_json` 与 `music_field_sources`
//! (`source='manual'`)；扫描器看到 manual/split/online 字段后不再覆盖。

use serde_json::{json, Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};
use tauri::AppHandle;

use crate::media::api::dto::{
  AlbumSummary, ArtistSummary, SmartPlaylistView, TagView, TrackQuery, TrackSummary,
};
use crate::media::api::errors::MediaError;
use crate::media::library::{events, list_tracks, pool};
use crate::media::repository::artists::{ensure_album, ensure_artist, normalize_name};
use crate::media::repository::smart;
use crate::media::repository::tags;
use crate::media::repository::{now_ms, tracks};

pub async fn call(app: &AppHandle, method: &str, args: &Value) -> Result<Value, MediaError> {
  match method {
    "listTags" => list_tags().await.map(|rows| json!(rows)),
    "createTag" => {
      let name = required_str(args, "name")?;
      let tag = tags::create(pool()?, name).await?;
      events::emit(app, "tags.changed", json!({ "tagId": tag.id }));
      Ok(json!(tag_view(tag)))
    }
    "renameTag" => {
      let tag_id = required_str(args, "tagId")?;
      let name = required_str(args, "name")?;
      let tag = tags::rename(pool()?, tag_id, name).await?;
      events::emit(app, "tags.changed", json!({ "tagId": tag.id }));
      Ok(json!(tag_view(tag)))
    }
    "deleteTag" => {
      let tag_id = required_str(args, "tagId")?;
      tags::delete(pool()?, tag_id).await?;
      events::changed(app);
      events::emit(app, "tags.changed", json!({ "tagId": tag_id }));
      Ok(json!({ "deleted": true }))
    }
    "setTrackTags" => {
      let track_id = required_str(args, "trackId")?;
      let tag_ids = string_array(args, "tagIds")?;
      tags::set_track_tags(pool()?, track_id, &tag_ids).await?;
      events::changed(app);
      events::emit(app, "tags.changed", json!({ "trackId": track_id }));
      Ok(json!({ "updated": true }))
    }

    "updateTrackMetadata" => update_metadata(app, args).await,
    "mergeArtists" => merge_artists(app, args).await,
    "splitArtist" => split_artist(app, args).await,
    "mergeAlbums" => merge_albums(app, args).await,
    "splitAlbum" => split_album(app, args).await,

    "listSmartPlaylists" => {
      let rows = smart::list(pool()?).await?;
      Ok(json!(rows
        .into_iter()
        .map(|row| SmartPlaylistView {
          id: row.id,
          name: row.name,
          description: row.description,
          rules: serde_json::from_str(&row.rules_json).unwrap_or_else(|_| json!({})),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })
        .collect::<Vec<_>>()))
    }
    "createSmartPlaylist" => {
      let name = required_str(args, "name")?;
      let description = optional_str(args, "description");
      let rules = required_value(args, "rules")?;
      let row = smart::create(pool()?, name, description.as_deref(), rules).await?;
      events::changed(app);
      events::emit(app, "smart.changed", json!({ "playlistId": row.id }));
      Ok(json!(smart_view(row)))
    }
    "updateSmartPlaylist" => {
      let playlist_id = required_str(args, "playlistId")?;
      let name = required_str(args, "name")?;
      let description = optional_str(args, "description");
      let rules = required_value(args, "rules")?;
      let row = smart::update(pool()?, playlist_id, name, description.as_deref(), rules).await?;
      events::changed(app);
      events::emit(app, "smart.changed", json!({ "playlistId": row.id }));
      Ok(json!(smart_view(row)))
    }
    "deleteSmartPlaylist" => {
      let playlist_id = required_str(args, "playlistId")?;
      smart::delete(pool()?, playlist_id).await?;
      events::changed(app);
      events::emit(app, "smart.changed", json!({ "playlistId": playlist_id }));
      Ok(json!({ "deleted": true }))
    }
    "runSmartPlaylist" => run_smart_playlist(args).await,
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的 P4 资料库方法：{method}"),
    )),
  }
}

async fn list_tags() -> Result<Vec<TagView>, MediaError> {
  Ok(
    tags::list(pool()?)
      .await?
      .into_iter()
      .map(tag_view)
      .collect(),
  )
}

fn tag_view(row: tags::TagRow) -> TagView {
  TagView {
    id: row.id,
    name: row.name,
    track_count: row.track_count,
  }
}

fn smart_view(row: smart::SmartPlaylistRow) -> SmartPlaylistView {
  SmartPlaylistView {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: serde_json::from_str(&row.rules_json).unwrap_or_else(|_| json!({})),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async fn run_smart_playlist(args: &Value) -> Result<Value, MediaError> {
  let playlist_id = required_str(args, "playlistId")?;
  let row = smart::get(pool()?, playlist_id)
    .await?
    .ok_or_else(|| MediaError::new("smart.not-found", "智能歌单不存在"))?;
  let mut rules: TrackQuery = serde_json::from_str(&row.rules_json)
    .map_err(|error| MediaError::invalid(format!("智能歌单规则无效：{error}")))?;
  if let Some(page) = args.get("page").and_then(Value::as_u64) {
    rules.page = Some(u32::try_from(page).unwrap_or(u32::MAX));
  }
  if let Some(page_size) = args.get("pageSize").and_then(Value::as_u64) {
    rules.page_size = Some(u32::try_from(page_size).unwrap_or(u32::MAX));
  }
  let page = list_tracks(&rules).await?;
  Ok(json!(page))
}

async fn update_metadata(app: &AppHandle, args: &Value) -> Result<Value, MediaError> {
  let track_id = required_str(args, "trackId")?;
  let has_title = args.get("title").is_some();
  let has_genre = args.get("genre").is_some();
  let has_year = args.get("year").is_some();
  let has_artists = args.get("artists").is_some();
  let has_album = args.get("album").is_some();
  if !(has_title || has_genre || has_year || has_artists || has_album) {
    return Err(MediaError::invalid("没有需要更新的元数据字段"));
  }

  let current = tracks::get(pool()?, track_id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  let title = if has_title {
    let value = required_str(args, "title")?.trim();
    if value.is_empty() {
      return Err(MediaError::invalid("标题不能为空"));
    }
    value.to_string()
  } else {
    current.title.clone()
  };
  let genre = if has_genre {
    nullable_str(args, "genre")?
  } else {
    current.genre.clone()
  };
  let year = if has_year {
    nullable_i64(args, "year")?
  } else {
    current.year
  };
  let artists = if has_artists {
    let values = string_array(args, "artists")?;
    let mut names = Vec::new();
    for value in values {
      let name = value.trim();
      if !name.is_empty() && !names.iter().any(|item: &String| item == name) {
        names.push(name.to_string());
      }
    }
    names
  } else {
    current_artist_names(pool()?, track_id).await?
  };
  let album = if has_album {
    nullable_str(args, "album")?
  } else {
    current.album_title.clone()
  };

  let now = now_ms();
  let mut tx = pool()?
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启元数据事务失败：{error}")))?;

  sqlx::query(
    "UPDATE music_tracks SET title = ?, sort_title = ?, genre = ?, year = ?, \
     updated_at = ?, version = version + 1 WHERE id = ?",
  )
  .bind(&title)
  .bind(normalize_name(&title))
  .bind(&genre)
  .bind(year)
  .bind(now)
  .bind(track_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新曲目元数据失败：{error}")))?;

  let mut overrides = current_overrides(&mut tx, track_id).await?;
  let mut changed_fields = Vec::new();
  if has_title {
    overrides.insert("title".to_string(), json!(title.clone()));
    changed_fields.push("title");
  }
  if has_genre {
    overrides.insert("genre".to_string(), json!(genre.clone()));
    changed_fields.push("genre");
  }
  if has_year {
    overrides.insert("year".to_string(), json!(year));
    changed_fields.push("year");
  }
  if has_artists {
    overrides.insert("artists".to_string(), json!(artists.clone()));
    changed_fields.push("artists");
  }
  if has_album {
    overrides.insert("album".to_string(), json!(album.clone()));
    changed_fields.push("album");
  }
  sqlx::query(
    "INSERT INTO music_track_metadata \
     (track_id, imported_json, normalized_json, overrides_json, online_json, updated_at) \
     VALUES (?, '{}', '{}', ?, '{}', ?) \
     ON CONFLICT(track_id) DO UPDATE SET overrides_json = excluded.overrides_json, \
       updated_at = excluded.updated_at",
  )
  .bind(track_id)
  .bind(serde_json::to_string(&overrides).unwrap_or_else(|_| "{}".to_string()))
  .bind(now)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("保存元数据覆盖失败：{error}")))?;

  for field in changed_fields {
    sqlx::query(
      "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
       VALUES (?, ?, 'manual', 1.0, ?) \
       ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', \
         confidence = 1.0, updated_at = excluded.updated_at",
    )
    .bind(track_id)
    .bind(field)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入字段来源失败：{error}")))?;
  }

  if has_artists {
    sqlx::query("DELETE FROM music_track_artists WHERE track_id = ?")
      .bind(track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理艺术家关系失败：{error}")))?;
    for (position, name) in artists.iter().enumerate() {
      let artist_id = ensure_artist(&mut tx, name, "unknown").await?;
      sqlx::query(
        "INSERT OR REPLACE INTO music_track_artists \
         (track_id, artist_id, role, position, source, updated_at) \
         VALUES (?, ?, 'primary', ?, 'manual', ?)",
      )
      .bind(track_id)
      .bind(artist_id)
      .bind(i64::try_from(position).unwrap_or(i64::MAX))
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("写入艺术家关系失败：{error}")))?;
    }
  }

  if has_album {
    sqlx::query("DELETE FROM music_track_albums WHERE track_id = ?")
      .bind(track_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理专辑关系失败：{error}")))?;
    if let Some(album_title) = album.as_deref() {
      let album_artist_id = match artists.first() {
        Some(name) => Some(ensure_artist(&mut tx, name, "unknown").await?),
        None => None,
      };
      if let Some(album_id) =
        ensure_album(&mut tx, album_title, album_artist_id.as_deref(), year).await?
      {
        sqlx::query(
          "INSERT OR REPLACE INTO music_track_albums \
           (track_id, album_id, disc_number, track_number, is_primary, source) \
           VALUES (?, ?, NULL, NULL, 1, 'manual')",
        )
        .bind(track_id)
        .bind(album_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| MediaError::internal(format!("写入专辑关系失败：{error}")))?;
      }
    }
  }

  let search_text = normalize_name(&format!(
    "{} {} {}",
    title,
    artists.join(" "),
    album.clone().unwrap_or_default()
  ));
  sqlx::query(
    "INSERT INTO music_search_text (track_id, search_text) VALUES (?, ?) \
     ON CONFLICT(track_id) DO UPDATE SET search_text = excluded.search_text",
  )
  .bind(track_id)
  .bind(search_text)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("更新搜索文本失败：{error}")))?;

  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交元数据事务失败：{error}")))?;

  events::changed(app);
  events::emit(app, "tags.changed", json!({ "trackId": track_id }));
  let row = tracks::get(pool()?, track_id)
    .await?
    .ok_or_else(|| MediaError::new("track.not-found", "曲目不存在"))?;
  Ok(json!(TrackSummary::from(row)))
}

async fn current_artist_names(
  pool: &SqlitePool,
  track_id: &str,
) -> Result<Vec<String>, MediaError> {
  let names: Vec<String> = sqlx::query_scalar(
    "SELECT a.name FROM music_track_artists ta JOIN music_artists a ON a.id = ta.artist_id \
     WHERE ta.track_id = ? AND ta.role IN ('primary', 'featured') ORDER BY ta.position, a.name",
  )
  .bind(track_id)
  .fetch_all(pool)
  .await
  .map_err(|error| MediaError::internal(format!("读取艺术家失败：{error}")))?;
  Ok(names)
}

async fn current_overrides(
  tx: &mut Transaction<'_, Sqlite>,
  track_id: &str,
) -> Result<Map<String, Value>, MediaError> {
  let existing: Option<String> =
    sqlx::query_scalar("SELECT overrides_json FROM music_track_metadata WHERE track_id = ?")
      .bind(track_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(|error| MediaError::internal(format!("读取元数据覆盖失败：{error}")))?;
  Ok(
    existing
      .and_then(|text| serde_json::from_str::<Value>(&text).ok())
      .and_then(|value| value.as_object().cloned())
      .unwrap_or_default(),
  )
}

async fn merge_artists(app: &AppHandle, args: &Value) -> Result<Value, MediaError> {
  let source_id = required_str(args, "sourceId")?;
  let target_id = required_str(args, "targetId")?;
  if source_id == target_id {
    return Err(MediaError::invalid("不能把艺术家合并到自己"));
  }
  let mut tx = pool()?
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启合并事务失败：{error}")))?;
  ensure_artist_exists(&mut tx, source_id).await?;
  let target = ensure_artist_exists(&mut tx, target_id).await?;
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
     SELECT track_id, 'artists', 'manual', 1.0, ? FROM music_track_artists WHERE artist_id = ? \
     ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', confidence = 1.0, \
       updated_at = excluded.updated_at",
  )
  .bind(now)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("保护合并艺术家失败：{error}")))?;
  sqlx::query(
    "INSERT OR IGNORE INTO music_track_artists \
     (track_id, artist_id, role, position, source, updated_at) \
     SELECT track_id, ?, role, position, 'manual', ? FROM music_track_artists WHERE artist_id = ?",
  )
  .bind(target_id)
  .bind(now)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("迁移艺术家关系失败：{error}")))?;
  sqlx::query("DELETE FROM music_track_artists WHERE artist_id = ?")
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧艺术家关系失败：{error}")))?;
  sqlx::query(
    "INSERT OR IGNORE INTO music_artist_aliases (artist_id, alias, normalized_alias, source) \
     SELECT ?, alias, normalized_alias, source FROM music_artist_aliases WHERE artist_id = ?",
  )
  .bind(target_id)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("迁移艺术家别名失败：{error}")))?;
  sqlx::query("DELETE FROM music_artist_aliases WHERE artist_id = ?")
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧艺术家别名失败：{error}")))?;
  sqlx::query("UPDATE music_albums SET album_artist_id = ? WHERE album_artist_id = ?")
    .bind(target_id)
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("迁移专辑艺术家失败：{error}")))?;
  sqlx::query(
    "UPDATE music_artists SET merged_into_id = ?, needs_review = 0, updated_at = ? WHERE id = ?",
  )
  .bind(target_id)
  .bind(now)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("标记艺术家合并失败：{error}")))?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交合并事务失败：{error}")))?;
  events::changed(app);
  Ok(json!({ "merged": true, "artist": target }))
}

async fn split_artist(app: &AppHandle, args: &Value) -> Result<Value, MediaError> {
  let source_id = required_str(args, "artistId")?;
  let track_ids = string_array(args, "trackIds")?;
  if track_ids.is_empty() {
    return Err(MediaError::invalid("至少选择一条曲目"));
  }
  let name = required_str(args, "name")?.trim().to_string();
  if name.is_empty() {
    return Err(MediaError::invalid("新艺术家名称不能为空"));
  }
  let source_name: String = sqlx::query_scalar("SELECT name FROM music_artists WHERE id = ?")
    .bind(source_id)
    .fetch_optional(pool()?)
    .await
    .map_err(|error| MediaError::internal(format!("读取艺术家失败：{error}")))?
    .ok_or_else(|| MediaError::new("artist.not-found", "艺术家不存在"))?;
  if normalize_name(&name) == normalize_name(&source_name) {
    return Err(MediaError::invalid("新名称不能与原艺术家相同"));
  }
  let mut tx = pool()?
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启拆分事务失败：{error}")))?;
  let new_id = ensure_artist(&mut tx, &name, "unknown").await?;
  let now = now_ms();
  for track_id in &track_ids {
    sqlx::query(
      "INSERT OR IGNORE INTO music_track_artists \
       (track_id, artist_id, role, position, source, updated_at) \
       SELECT track_id, ?, role, position, 'split', ? FROM music_track_artists \
       WHERE track_id = ? AND artist_id = ?",
    )
    .bind(&new_id)
    .bind(now)
    .bind(track_id)
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入拆分艺术家失败：{error}")))?;
    sqlx::query("DELETE FROM music_track_artists WHERE track_id = ? AND artist_id = ?")
      .bind(track_id)
      .bind(source_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理拆分艺术家失败：{error}")))?;
    sqlx::query(
      "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
       VALUES (?, 'artists', 'manual', 1.0, ?) \
       ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', confidence = 1.0, \
         updated_at = excluded.updated_at",
    )
    .bind(track_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("保护拆分艺术家失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交拆分事务失败：{error}")))?;
  events::changed(app);
  Ok(json!({ "artist": { "id": new_id, "name": name } }))
}

async fn merge_albums(app: &AppHandle, args: &Value) -> Result<Value, MediaError> {
  let source_id = required_str(args, "sourceId")?;
  let target_id = required_str(args, "targetId")?;
  if source_id == target_id {
    return Err(MediaError::invalid("不能把专辑合并到自己"));
  }
  let mut tx = pool()?
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启合并事务失败：{error}")))?;
  ensure_album_exists(&mut tx, source_id).await?;
  let target = ensure_album_exists(&mut tx, target_id).await?;
  let now = now_ms();
  sqlx::query(
    "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
     SELECT track_id, 'album', 'manual', 1.0, ? FROM music_track_albums WHERE album_id = ? \
     ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', confidence = 1.0, \
       updated_at = excluded.updated_at",
  )
  .bind(now)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("保护合并专辑失败：{error}")))?;
  sqlx::query(
    "INSERT OR IGNORE INTO music_track_albums \
     (track_id, album_id, disc_number, track_number, is_primary, source) \
     SELECT track_id, ?, disc_number, track_number, \
       CASE WHEN EXISTS (SELECT 1 FROM music_track_albums x \
         WHERE x.track_id = music_track_albums.track_id AND x.album_id = ? AND x.is_primary = 1) \
         THEN 0 ELSE is_primary END, \
       'manual' \
     FROM music_track_albums WHERE album_id = ?",
  )
  .bind(target_id)
  .bind(target_id)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("迁移专辑关系失败：{error}")))?;
  sqlx::query("DELETE FROM music_track_albums WHERE album_id = ?")
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧专辑关系失败：{error}")))?;
  sqlx::query(
    "INSERT OR IGNORE INTO music_album_aliases (album_id, alias, normalized_alias, source) \
     SELECT ?, alias, normalized_alias, source FROM music_album_aliases WHERE album_id = ?",
  )
  .bind(target_id)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("迁移专辑别名失败：{error}")))?;
  sqlx::query("DELETE FROM music_album_aliases WHERE album_id = ?")
    .bind(source_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("清理旧专辑别名失败：{error}")))?;
  sqlx::query(
    "UPDATE music_albums SET merged_into_id = ?, needs_review = 0, updated_at = ? WHERE id = ?",
  )
  .bind(target_id)
  .bind(now)
  .bind(source_id)
  .execute(&mut *tx)
  .await
  .map_err(|error| MediaError::internal(format!("标记专辑合并失败：{error}")))?;
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交合并事务失败：{error}")))?;
  events::changed(app);
  Ok(json!({ "merged": true, "album": target }))
}

async fn split_album(app: &AppHandle, args: &Value) -> Result<Value, MediaError> {
  let source_id = required_str(args, "albumId")?;
  let track_ids = string_array(args, "trackIds")?;
  if track_ids.is_empty() {
    return Err(MediaError::invalid("至少选择一条曲目"));
  }
  let title = required_str(args, "title")?.trim().to_string();
  if title.is_empty() {
    return Err(MediaError::invalid("新专辑名称不能为空"));
  }
  let source: Option<(String, Option<i64>)> =
    sqlx::query_as("SELECT title, year FROM music_albums WHERE id = ?")
      .bind(source_id)
      .fetch_optional(pool()?)
      .await
      .map_err(|error| MediaError::internal(format!("读取专辑失败：{error}")))?;
  let (source_title, year) =
    source.ok_or_else(|| MediaError::new("album.not-found", "专辑不存在"))?;
  if normalize_name(&title) == normalize_name(&source_title) {
    return Err(MediaError::invalid("新名称不能与原专辑相同"));
  }
  let mut tx = pool()?
    .begin()
    .await
    .map_err(|error| MediaError::internal(format!("开启拆分事务失败：{error}")))?;
  let album_id = ensure_album(&mut tx, &title, None, year)
    .await?
    .ok_or_else(|| MediaError::invalid("专辑名称无效"))?;
  let now = now_ms();
  for track_id in &track_ids {
    let source_row: Option<(Option<i64>, Option<i64>)> = sqlx::query_as(
      "SELECT disc_number, track_number FROM music_track_albums \
       WHERE track_id = ? AND album_id = ?",
    )
    .bind(track_id)
    .bind(source_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("读取拆分专辑失败：{error}")))?;
    let Some((disc_number, track_number)) = source_row else {
      continue;
    };
    sqlx::query("DELETE FROM music_track_albums WHERE track_id = ? AND album_id = ?")
      .bind(track_id)
      .bind(source_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| MediaError::internal(format!("清理拆分专辑失败：{error}")))?;
    sqlx::query(
      "INSERT OR REPLACE INTO music_track_albums \
       (track_id, album_id, disc_number, track_number, is_primary, source) \
       VALUES (?, ?, ?, ?, 1, 'split')",
    )
    .bind(track_id)
    .bind(&album_id)
    .bind(disc_number)
    .bind(track_number)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("写入拆分专辑失败：{error}")))?;
    sqlx::query(
      "INSERT INTO music_field_sources (track_id, field, source, confidence, updated_at) \
       VALUES (?, 'album', 'manual', 1.0, ?) \
       ON CONFLICT(track_id, field) DO UPDATE SET source = 'manual', confidence = 1.0, \
         updated_at = excluded.updated_at",
    )
    .bind(track_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|error| MediaError::internal(format!("保护拆分专辑失败：{error}")))?;
  }
  tx.commit()
    .await
    .map_err(|error| MediaError::internal(format!("提交拆分事务失败：{error}")))?;
  events::changed(app);
  Ok(json!({ "album": { "id": album_id, "title": title } }))
}

async fn ensure_artist_exists(
  tx: &mut Transaction<'_, Sqlite>,
  artist_id: &str,
) -> Result<ArtistSummary, MediaError> {
  let row: Option<(String, String, String, i64, i64)> = sqlx::query_as(
    "SELECT id, name, kind, needs_review, \
       (SELECT COUNT(*) FROM music_track_artists ta WHERE ta.artist_id = a.id) \
     FROM music_artists a WHERE id = ? AND merged_into_id IS NULL",
  )
  .bind(artist_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("读取艺术家失败：{error}")))?;
  let (id, name, kind, needs_review, track_count) =
    row.ok_or_else(|| MediaError::new("artist.not-found", "艺术家不存在"))?;
  Ok(ArtistSummary {
    id,
    name,
    kind,
    track_count,
    needs_review: needs_review != 0,
  })
}

async fn ensure_album_exists(
  tx: &mut Transaction<'_, Sqlite>,
  album_id: &str,
) -> Result<AlbumSummary, MediaError> {
  type AlbumRow = (String, String, Option<i64>, String, Option<String>, i64);
  let row: Option<AlbumRow> = sqlx::query_as(
    "SELECT al.id, al.title, al.year, al.kind, ar.name, \
       (SELECT COUNT(*) FROM music_track_albums taa WHERE taa.album_id = al.id) \
     FROM music_albums al LEFT JOIN music_artists ar ON ar.id = al.album_artist_id \
     WHERE al.id = ? AND al.merged_into_id IS NULL",
  )
  .bind(album_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(|error| MediaError::internal(format!("读取专辑失败：{error}")))?;
  let (id, title, year, kind, album_artist, track_count) =
    row.ok_or_else(|| MediaError::new("album.not-found", "专辑不存在"))?;
  Ok(AlbumSummary {
    id,
    title,
    year,
    kind,
    album_artist,
    track_count,
    has_cover: false,
  })
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, MediaError> {
  args
    .get(key)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
  args
    .get(key)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn nullable_str(args: &Value, key: &str) -> Result<Option<String>, MediaError> {
  match args.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => {
      let value = value.trim();
      Ok(if value.is_empty() {
        None
      } else {
        Some(value.to_string())
      })
    }
    Some(_) => Err(MediaError::invalid(format!("{key} 必须是字符串或 null"))),
  }
}

fn nullable_i64(args: &Value, key: &str) -> Result<Option<i64>, MediaError> {
  match args.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(value) => value
      .as_i64()
      .map(Some)
      .ok_or_else(|| MediaError::invalid(format!("{key} 必须是整数或 null"))),
  }
}

fn required_value<'a>(args: &'a Value, key: &str) -> Result<&'a Value, MediaError> {
  args
    .get(key)
    .filter(|value| !value.is_null())
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn string_array(args: &Value, key: &str) -> Result<Vec<String>, MediaError> {
  args
    .get(key)
    .and_then(Value::as_array)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key} 数组")))?
    .iter()
    .map(|value| {
      value
        .as_str()
        .map(ToString::to_string)
        .ok_or_else(|| MediaError::invalid(format!("{key} 必须全部是字符串")))
    })
    .collect()
}
