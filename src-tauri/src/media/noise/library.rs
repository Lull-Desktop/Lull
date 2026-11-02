//! N3 Noise Library：本地素材导入、Asset 读取/编辑/删除、分类/标签/收藏、
//! 缺失检测与搜索分页。
//!
//! 只允许官方 host 窗口访问；导入/删除/编辑仅 `settings` 与 `noise-library`，
//! `noise`/`library` 可读并切换收藏。公开 DTO 不包含 storage_key 或任何文件路径。

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::dto::{
  NoiseAssetCapabilities, NoiseAssetCategory, NoiseAssetQuery, NoiseAssetView, NoiseCategoryView,
  NoiseImportFailure, NoiseImportResult, NoiseRevalidateResult, NoiseTagView,
};
use super::{assets, repository, session};
use crate::media::api::dto::Page;
use crate::media::api::errors::MediaError;
use crate::media::repository::new_id;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac"];
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_BYTES: usize = 2048;

fn read_allowed(label: &str) -> bool {
  matches!(label, "settings" | "noise" | "library" | "noise-library")
    || label.starts_with("widget-")
}

fn write_allowed(label: &str) -> bool {
  matches!(label, "settings" | "noise-library")
}

fn favorite_allowed(label: &str) -> bool {
  read_allowed(label)
}

fn require_read(label: &str) -> Result<(), MediaError> {
  if read_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口不能读取 Noise Library",
    ))
  }
}

fn require_write(label: &str) -> Result<(), MediaError> {
  if write_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "只有设置窗口或白噪音库窗口可以导入/编辑/删除 Noise 素材",
    ))
  }
}

fn require_favorite(label: &str) -> Result<(), MediaError> {
  if favorite_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口不能收藏 Noise 素材",
    ))
  }
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, MediaError> {
  args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

fn path_list(args: &Value) -> Vec<PathBuf> {
  args
    .get("paths")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect()
    })
    .unwrap_or_default()
}

fn tag_ids_arg(args: &Value) -> Result<Option<Vec<String>>, MediaError> {
  let Some(value) = args.get("tagIds") else {
    return Ok(None);
  };
  if value.is_null() {
    return Ok(Some(Vec::new()));
  }
  let Some(items) = value.as_array() else {
    return Err(MediaError::invalid("tagIds 必须是数组"));
  };
  let mut tags = Vec::new();
  for item in items {
    let Some(tag) = item.as_str() else {
      return Err(MediaError::invalid("tagIds 只能包含字符串"));
    };
    if !tags.iter().any(|value| value == tag) {
      tags.push(tag.to_string());
    }
  }
  Ok(Some(tags))
}

async fn validate_taxonomy(
  pool: &sqlx::SqlitePool,
  category_id: Option<&str>,
  tag_ids: &[String],
) -> Result<(), MediaError> {
  if let Some(category_id) = category_id {
    if !repository::category_exists(pool, category_id).await? {
      return Err(MediaError::invalid("Noise 分类不存在"));
    }
  }
  for tag_id in tag_ids {
    if !repository::tag_exists(pool, tag_id).await? {
      return Err(MediaError::invalid("Noise 标签不存在"));
    }
  }
  Ok(())
}

pub(super) fn asset_view(row: repository::AssetListRow) -> NoiseAssetView {
  let capabilities: NoiseAssetCapabilities =
    serde_json::from_str(&row.capabilities_json).unwrap_or_default();
  let tags: Vec<NoiseTagView> = serde_json::from_str(&row.tags_json).unwrap_or_default();
  let category = row
    .category_id
    .as_ref()
    .zip(row.category_name.as_ref())
    .map(|(id, name)| NoiseAssetCategory {
      id: id.clone(),
      name: name.clone(),
    });
  NoiseAssetView {
    id: row.id,
    name: row.name,
    description: row.description,
    media_kind: row.media_kind,
    format: row.format,
    duration_ms: row.duration_ms,
    sample_rate: row.sample_rate,
    channels: row.channels,
    size_bytes: row.size_bytes,
    category,
    tags,
    favorite: row.favorite != 0,
    status: row.status,
    source: row.source_kind,
    capabilities,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

fn category_view(row: repository::CategoryRow) -> NoiseCategoryView {
  NoiseCategoryView {
    id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    icon: row.icon,
    sort_order: row.sort_order,
    asset_count: row.asset_count,
    source_type: row.source_type,
  }
}

fn tag_view(row: repository::TagRow) -> NoiseTagView {
  NoiseTagView {
    id: row.id,
    name: row.name,
    asset_count: row.asset_count,
    source_type: row.source_type,
  }
}

fn optional_text(args: &Value, key: &str) -> Result<Option<Option<String>>, MediaError> {
  let Some(value) = args.get(key) else {
    return Ok(None);
  };
  match value {
    Value::Null => Ok(Some(None)),
    Value::String(value) => Ok(Some(Some(value.clone()))),
    _ => Err(MediaError::invalid(format!("{key} 必须是字符串或 null"))),
  }
}

fn taxonomy_name(value: &str, max: usize, label: &str) -> Result<String, MediaError> {
  let value = value.trim();
  if value.is_empty() || value.chars().count() > max {
    return Err(MediaError::invalid(format!("{label}长度必须为 1–{max}")));
  }
  Ok(value.to_string())
}

async fn validate_category_parent(
  pool: &sqlx::SqlitePool,
  category_id: Option<&str>,
  parent_id: Option<&str>,
) -> Result<(), MediaError> {
  let Some(parent_id) = parent_id else {
    return Ok(());
  };
  if category_id == Some(parent_id) {
    return Err(MediaError::invalid("分类不能以自身为父分类"));
  }
  if !repository::category_exists(pool, parent_id).await? {
    return Err(MediaError::invalid("父分类不存在"));
  }
  let mut cursor = Some(parent_id.to_string());
  let mut depth = 0;
  while let Some(current) = cursor {
    if category_id == Some(current.as_str()) {
      return Err(MediaError::invalid("分类层级不能形成循环"));
    }
    depth += 1;
    if depth > 64 {
      return Err(MediaError::invalid("分类层级过深"));
    }
    cursor = repository::category_parent_id(pool, &current).await?;
  }
  Ok(())
}

async fn detail(pool: &sqlx::SqlitePool, asset_id: &str) -> Result<NoiseAssetView, MediaError> {
  repository::asset_detail(pool, asset_id)
    .await?
    .map(asset_view)
    .ok_or_else(|| MediaError::new("noise.asset.not-found", "Noise 素材不存在"))
}

fn emit_changed(app: &AppHandle) {
  crate::media::events::emit(
    app,
    "noise.library.changed",
    super::next_library_revision(),
    json!({}),
  );
}

async fn revalidate_assets(
  app: &AppHandle,
  pool: &sqlx::SqlitePool,
) -> Result<NoiseRevalidateResult, MediaError> {
  let mut checked = 0_i64;
  let mut missing = 0_i64;
  let mut restored = 0_i64;
  for row in repository::file_assets(pool).await? {
    checked += 1;
    let exists = row
      .storage_key
      .as_deref()
      .is_some_and(|key| assets::stored_exists(app, key));
    let next = if exists { "available" } else { "missing" };
    if row.status != next {
      repository::set_status(pool, &row.id, next).await?;
    }
    if exists {
      if row.status == "missing" {
        restored += 1;
      }
    } else {
      missing += 1;
    }
  }
  emit_changed(app);
  session::sync_engine(app);
  Ok(NoiseRevalidateResult {
    checked,
    missing,
    restored,
  })
}

/// 启动时轻量检查文件是否存在；失败由调用方记录日志，不阻断启动。
pub async fn revalidate_startup(app: &AppHandle) -> Result<NoiseRevalidateResult, MediaError> {
  let pool = crate::media::library::pool()?;
  revalidate_assets(app, pool).await
}

pub async fn call(
  app: &AppHandle,
  label: &str,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  match method {
    "listAssets" => {
      require_read(label)?;
      let query: NoiseAssetQuery = serde_json::from_value(args.clone())
        .map_err(|error| MediaError::invalid(format!("Noise 查询参数无效：{error}")))?;
      let pool = crate::media::library::pool()?;
      let (rows, total) = repository::list_assets(pool, &query).await?;
      let page = Page::new(
        rows.into_iter().map(asset_view).collect(),
        total,
        query.page(),
        query.page_size(),
      );
      serde_json::to_value(page)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 素材失败：{error}")))
    }
    "getAsset" => {
      require_read(label)?;
      let asset_id = string_arg(args, "assetId")?;
      let pool = crate::media::library::pool()?;
      serde_json::to_value(detail(pool, asset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 素材失败：{error}")))
    }
    "getCategories" => {
      require_read(label)?;
      let pool = crate::media::library::pool()?;
      let items: Vec<NoiseCategoryView> = repository::categories(pool)
        .await?
        .into_iter()
        .map(category_view)
        .collect();
      serde_json::to_value(items)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 分类失败：{error}")))
    }
    "getTags" => {
      require_read(label)?;
      let pool = crate::media::library::pool()?;
      let items: Vec<NoiseTagView> = repository::tags(pool)
        .await?
        .into_iter()
        .map(tag_view)
        .collect();
      serde_json::to_value(items)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 标签失败：{error}")))
    }
    "createCategory" => {
      require_write(label)?;
      let name = taxonomy_name(string_arg(args, "name")?, 80, "分类名称")?;
      let parent_id = optional_text(args, "parentId")?.unwrap_or(None);
      let icon = optional_text(args, "icon")?.unwrap_or(None);
      let sort_order = args.get("sortOrder").and_then(Value::as_i64).unwrap_or(100);
      let pool = crate::media::library::pool()?;
      validate_category_parent(pool, None, parent_id.as_deref()).await?;
      if repository::category_name_exists(pool, &name, parent_id.as_deref(), None).await? {
        return Err(MediaError::invalid("同一父分类下已存在同名分类"));
      }
      let category_id = new_id("noise_category");
      repository::insert_category(
        pool,
        &category_id,
        &name,
        parent_id.as_deref(),
        icon.as_deref(),
        sort_order,
      )
      .await?;
      emit_changed(app);
      let category = repository::category(pool, &category_id)
        .await?
        .ok_or_else(|| MediaError::internal("创建 Noise 分类后读取失败"))?;
      serde_json::to_value(category_view(category))
        .map_err(|error| MediaError::internal(format!("序列化 Noise 分类失败：{error}")))
    }
    "updateCategory" => {
      require_write(label)?;
      let category_id = string_arg(args, "categoryId")?;
      let pool = crate::media::library::pool()?;
      let existing = repository::category(pool, category_id)
        .await?
        .ok_or_else(|| MediaError::new("noise.category.not-found", "Noise 分类不存在"))?;
      if existing.source_type != "user" {
        return Err(MediaError::new(
          "noise.category.builtin",
          "内置 Noise 分类不能修改",
        ));
      }
      let name = match args.get("name") {
        Some(Value::String(value)) => taxonomy_name(value, 80, "分类名称")?,
        Some(_) => return Err(MediaError::invalid("name 必须是字符串")),
        None => existing.name.clone(),
      };
      let parent_id =
        optional_text(args, "parentId")?.unwrap_or_else(|| existing.parent_id.clone());
      let icon = optional_text(args, "icon")?.unwrap_or_else(|| existing.icon.clone());
      let sort_order = args
        .get("sortOrder")
        .and_then(Value::as_i64)
        .unwrap_or(existing.sort_order);
      validate_category_parent(pool, Some(category_id), parent_id.as_deref()).await?;
      if repository::category_name_exists(pool, &name, parent_id.as_deref(), Some(category_id))
        .await?
      {
        return Err(MediaError::invalid("同一父分类下已存在同名分类"));
      }
      repository::update_category(
        pool,
        category_id,
        &name,
        parent_id.as_deref(),
        icon.as_deref(),
        sort_order,
      )
      .await?;
      emit_changed(app);
      let category = repository::category(pool, category_id)
        .await?
        .ok_or_else(|| MediaError::internal("更新 Noise 分类后读取失败"))?;
      serde_json::to_value(category_view(category))
        .map_err(|error| MediaError::internal(format!("序列化 Noise 分类失败：{error}")))
    }
    "deleteCategory" => {
      require_write(label)?;
      let category_id = string_arg(args, "categoryId")?;
      let pool = crate::media::library::pool()?;
      let existing = repository::category(pool, category_id)
        .await?
        .ok_or_else(|| MediaError::new("noise.category.not-found", "Noise 分类不存在"))?;
      if existing.source_type != "user" {
        return Err(MediaError::new(
          "noise.category.builtin",
          "内置 Noise 分类不能删除",
        ));
      }
      if repository::category_children_count(pool, category_id).await? > 0 {
        return Err(MediaError::new(
          "noise.category.has-children",
          "请先删除或移动子分类",
        ));
      }
      repository::delete_category(pool, category_id).await?;
      emit_changed(app);
      Ok(json!({ "removed": true }))
    }
    "createTag" => {
      require_write(label)?;
      let name = taxonomy_name(string_arg(args, "name")?, 40, "标签名称")?;
      let normalized = repository::normalize_tag_name(&name);
      let pool = crate::media::library::pool()?;
      if repository::tag_name_exists(pool, &normalized, None).await? {
        return Err(MediaError::invalid("已存在同名标签"));
      }
      let tag_id = new_id("noise_tag");
      repository::insert_tag(pool, &tag_id, &name, &normalized).await?;
      emit_changed(app);
      let tag = repository::tag(pool, &tag_id)
        .await?
        .ok_or_else(|| MediaError::internal("创建 Noise 标签后读取失败"))?;
      serde_json::to_value(tag_view(tag))
        .map_err(|error| MediaError::internal(format!("序列化 Noise 标签失败：{error}")))
    }
    "updateTag" => {
      require_write(label)?;
      let tag_id = string_arg(args, "tagId")?;
      let name = taxonomy_name(string_arg(args, "name")?, 40, "标签名称")?;
      let normalized = repository::normalize_tag_name(&name);
      let pool = crate::media::library::pool()?;
      let existing = repository::tag(pool, tag_id)
        .await?
        .ok_or_else(|| MediaError::new("noise.tag.not-found", "Noise 标签不存在"))?;
      if existing.source_type != "user" {
        return Err(MediaError::new(
          "noise.tag.builtin",
          "内置 Noise 标签不能修改",
        ));
      }
      if repository::tag_name_exists(pool, &normalized, Some(tag_id)).await? {
        return Err(MediaError::invalid("已存在同名标签"));
      }
      repository::update_tag(pool, tag_id, &name, &normalized).await?;
      emit_changed(app);
      let tag = repository::tag(pool, tag_id)
        .await?
        .ok_or_else(|| MediaError::internal("更新 Noise 标签后读取失败"))?;
      serde_json::to_value(tag_view(tag))
        .map_err(|error| MediaError::internal(format!("序列化 Noise 标签失败：{error}")))
    }
    "deleteTag" => {
      require_write(label)?;
      let tag_id = string_arg(args, "tagId")?;
      let pool = crate::media::library::pool()?;
      let existing = repository::tag(pool, tag_id)
        .await?
        .ok_or_else(|| MediaError::new("noise.tag.not-found", "Noise 标签不存在"))?;
      if existing.source_type != "user" {
        return Err(MediaError::new(
          "noise.tag.builtin",
          "内置 Noise 标签不能删除",
        ));
      }
      repository::delete_tag(pool, tag_id).await?;
      emit_changed(app);
      Ok(json!({ "removed": true }))
    }
    "setAssetFavorite" => {
      require_favorite(label)?;
      let asset_id = string_arg(args, "assetId")?;
      let favorite = args
        .get("favorite")
        .and_then(Value::as_bool)
        .ok_or_else(|| MediaError::invalid("缺少 favorite"))?;
      let pool = crate::media::library::pool()?;
      let _ = detail(pool, asset_id).await?;
      repository::set_favorite(pool, asset_id, favorite).await?;
      emit_changed(app);
      serde_json::to_value(detail(pool, asset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 素材失败：{error}")))
    }
    "importAssets" => {
      require_write(label)?;
      let category_id = args.get("categoryId").and_then(Value::as_str);
      let tag_ids = tag_ids_arg(args)?.unwrap_or_default();
      let paths = path_list(args);
      let paths = if paths.is_empty() {
        rfd::FileDialog::new()
          .add_filter("音频", AUDIO_EXTENSIONS)
          .pick_files()
          .unwrap_or_default()
      } else {
        paths
      };
      let result = import_files(app, paths, category_id, &tag_ids).await?;
      serde_json::to_value(result)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 导入结果失败：{error}")))
    }
    "importFolder" => {
      require_write(label)?;
      let category_id = args.get("categoryId").and_then(Value::as_str);
      let tag_ids = tag_ids_arg(args)?.unwrap_or_default();
      let paths = args
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .map(|root| assets::collect_folder(&root))
        .unwrap_or_else(|| {
          rfd::FileDialog::new()
            .pick_folder()
            .map(|root| assets::collect_folder(&root))
            .unwrap_or_default()
        });
      let result = import_files(app, paths, category_id, &tag_ids).await?;
      serde_json::to_value(result)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 导入结果失败：{error}")))
    }
    "updateAsset" => {
      require_write(label)?;
      let asset_id = string_arg(args, "assetId")?;
      let pool = crate::media::library::pool()?;
      let existing = detail(pool, asset_id).await?;
      if existing.source == "builtin" {
        return Err(MediaError::new(
          "noise.asset.builtin",
          "内置 Noise 素材不能修改",
        ));
      }
      let name = match args.get("name") {
        Some(Value::String(value)) => {
          let value = value.trim();
          if value.is_empty() || value.chars().count() > MAX_NAME_CHARS {
            return Err(MediaError::invalid("素材名称长度必须为 1–80"));
          }
          value.to_string()
        }
        Some(_) => return Err(MediaError::invalid("name 必须是字符串")),
        None => existing.name.clone(),
      };
      let description = if let Some(value) = args.get("description") {
        if value.is_null() {
          None
        } else if let Some(value) = value.as_str() {
          if value.len() > MAX_DESCRIPTION_BYTES {
            return Err(MediaError::invalid("素材描述不能超过 2 KB"));
          }
          Some(value.to_string())
        } else {
          return Err(MediaError::invalid("description 必须是字符串或 null"));
        }
      } else {
        existing.description.clone()
      };
      let category_id = if args.get("categoryId").is_some() {
        match args.get("categoryId") {
          Some(Value::String(value)) => Some(value.clone()),
          Some(Value::Null) => None,
          _ => return Err(MediaError::invalid("categoryId 必须是字符串或 null")),
        }
      } else {
        existing
          .category
          .as_ref()
          .map(|category| category.id.clone())
      };
      let tag_ids = tag_ids_arg(args)?;
      validate_taxonomy(
        pool,
        category_id.as_deref(),
        tag_ids.as_deref().unwrap_or(&[]),
      )
      .await?;
      repository::update_asset_metadata(
        pool,
        asset_id,
        &name,
        description.as_deref(),
        category_id.as_deref(),
        tag_ids.as_deref(),
      )
      .await?;
      emit_changed(app);
      serde_json::to_value(detail(pool, asset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 素材失败：{error}")))
    }
    "removeAsset" => {
      require_write(label)?;
      let asset_id = string_arg(args, "assetId")?;
      let pool = crate::media::library::pool()?;
      let existing = detail(pool, asset_id).await?;
      if existing.source == "builtin" {
        return Err(MediaError::new(
          "noise.asset.builtin",
          "内置 Noise 素材不能删除",
        ));
      }
      let storage_key = repository::delete_asset(pool, asset_id).await?;
      session::remove_tracks_for_asset(app, asset_id);
      if let Some(storage_key) = storage_key {
        assets::remove_stored(app, &storage_key);
      }
      emit_changed(app);
      Ok(json!({ "removed": true }))
    }
    "revalidateAssets" => {
      require_write(label)?;
      let pool = crate::media::library::pool()?;
      let result = revalidate_assets(app, pool).await?;
      serde_json::to_value(result)
        .map_err(|error| MediaError::internal(format!("序列化 Noise 检查结果失败：{error}")))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的 Noise Library 方法：{method}"),
    )),
  }
}

async fn import_files(
  app: &AppHandle,
  paths: Vec<PathBuf>,
  category_id: Option<&str>,
  tag_ids: &[String],
) -> Result<NoiseImportResult, MediaError> {
  let pool = crate::media::library::pool()?;
  validate_taxonomy(pool, category_id, tag_ids).await?;
  let source_id = repository::ensure_local_source(pool).await?;
  let dir = assets::assets_dir(app);
  let mut result = NoiseImportResult::default();

  for path in paths {
    if !path.is_file() {
      result.failed.push(NoiseImportFailure {
        file_name: path
          .file_name()
          .and_then(|value| value.to_str())
          .unwrap_or("未知文件")
          .to_string(),
        code: "noise.asset.unreadable".to_string(),
        reason: "文件不存在或不是普通文件".to_string(),
      });
      continue;
    }
    let file_name = path
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or("未知文件")
      .to_string();
    let dir_for_task = dir.clone();
    let path_for_task = path.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
      assets::prepare_import(&dir_for_task, &path_for_task)
    })
    .await
    .map_err(|error| MediaError::internal(format!("Noise 导入任务失败：{error}")))?;
    let prepared = match prepared {
      Ok(prepared) => prepared,
      Err(error) => {
        result.failed.push(NoiseImportFailure {
          file_name,
          code: error.code,
          reason: error.reason,
        });
        continue;
      }
    };

    if let Some(existing) = repository::find_by_hash(pool, &prepared.content_hash).await? {
      if assets::stored_exists(app, &prepared.storage_key) {
        repository::set_status(pool, &existing, "available").await?;
      }
      result.duplicates.push(detail(pool, &existing).await?);
      continue;
    }

    let asset_id = new_id("noise_asset");
    let item = repository::NewAsset {
      id: &asset_id,
      source_id: &source_id,
      name: &prepared.name,
      description: None,
      media_kind: "file",
      format: &prepared.format,
      storage_key: &prepared.storage_key,
      size_bytes: prepared.size_bytes,
      mtime_ms: prepared.mtime_ms,
      duration_ms: prepared.duration_ms,
      sample_rate: prepared.sample_rate,
      channels: prepared.channels,
      content_hash: &prepared.content_hash,
      category_id,
      capabilities_json: r#"{"loop":true,"seek":true,"fade":true}"#,
    };
    repository::insert_asset(pool, &item, tag_ids).await?;
    result.imported.push(detail(pool, &asset_id).await?);
  }

  if !result.imported.is_empty() || !result.duplicates.is_empty() {
    emit_changed(app);
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn asset_view_strips_storage_and_hides_paths() {
    let row = repository::AssetListRow {
      id: "asset".to_string(),
      name: "Rain".to_string(),
      description: None,
      media_kind: "file".to_string(),
      format: "ogg".to_string(),
      size_bytes: 10,
      duration_ms: Some(1000),
      sample_rate: Some(48_000),
      channels: Some(2),
      status: "available".to_string(),
      source_kind: "local".to_string(),
      category_id: None,
      category_name: None,
      capabilities_json: r#"{"loop":true,"seek":true,"fade":true}"#.to_string(),
      favorite: 1,
      tags_json: r#"[{"id":"tag","name":"雨"}]"#.to_string(),
      created_at: 1,
      updated_at: 2,
    };
    let view = asset_view(row);
    assert_eq!(view.name, "Rain");
    assert!(view.favorite);
    assert_eq!(view.tags[0].name, "雨");
    assert!(view.capabilities.loop_);
    let value = serde_json::to_value(&view).expect("serialize");
    assert!(value.get("storageKey").is_none());
    assert!(value.get("path").is_none());
  }

  #[test]
  fn access_matrix_keeps_import_to_settings_and_noise_library() {
    assert!(write_allowed("settings"));
    assert!(write_allowed("noise-library"));
    assert!(!write_allowed("noise"));
    assert!(!write_allowed("library"));
    assert!(read_allowed("noise"));
    assert!(read_allowed("noise-library"));
    assert!(favorite_allowed("library"));
    assert!(favorite_allowed("noise-library"));
    assert!(!read_allowed("player"));
  }

  #[test]
  fn deleting_asset_nulls_preset_reference_instead_of_breaking_preset() {
    let path =
      std::env::temp_dir().join(format!("lull-noise-preset-fk-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      super::super::catalog::seed(&pool).await.expect("seed");
      let source = repository::ensure_local_source(&pool)
        .await
        .expect("local source");
      let item = repository::NewAsset {
        id: "noise_asset_fk",
        source_id: &source,
        name: "FK Asset",
        description: None,
        media_kind: "file",
        format: "wav",
        storage_key: "fk.wav",
        size_bytes: 10,
        mtime_ms: None,
        duration_ms: Some(1000),
        sample_rate: Some(8000),
        channels: Some(1),
        content_hash: "hash-fk",
        category_id: None,
        capabilities_json: r#"{"loop":true,"seek":true,"fade":true}"#,
      };
      repository::insert_asset(&pool, &item, &[])
        .await
        .expect("asset");
      sqlx::query(
        "INSERT INTO noise_presets \
         (id, name, source_type, schema_version, master_volume, created_at, updated_at) \
         VALUES ('preset-fk', 'FK preset', 'user', 1, 0.8, 1, 1)",
      )
      .execute(&pool)
      .await
      .expect("preset");
      sqlx::query(
        "INSERT INTO noise_preset_tracks \
         (id, preset_id, asset_id, expected_name, volume, enabled, loop, sort_order) \
         VALUES ('track-fk', 'preset-fk', 'noise_asset_fk', 'FK Asset', 0.5, 1, 1, 0)",
      )
      .execute(&pool)
      .await
      .expect("preset track");
      repository::delete_asset(&pool, "noise_asset_fk")
        .await
        .expect("delete asset");
      let asset_id = sqlx::query_scalar::<_, Option<String>>(
        "SELECT asset_id FROM noise_preset_tracks WHERE id = 'track-fk'",
      )
      .fetch_one(&pool)
      .await
      .expect("read preset track");
      assert!(asset_id.is_none());
      let preset_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM noise_presets WHERE id = 'preset-fk'")
          .fetch_one(&pool)
          .await
          .expect("preset survives");
      assert_eq!(preset_count, 1);
      crate::media::repository::db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }

  #[test]
  fn asset_query_filters_tags_favorites_and_returns_metadata() {
    let path = std::env::temp_dir().join(format!("lull-noise-library-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      super::super::catalog::seed(&pool).await.expect("seed");
      let source = repository::ensure_local_source(&pool)
        .await
        .expect("local source");
      let item = repository::NewAsset {
        id: "noise_asset_test",
        source_id: &source,
        name: "Local Rain",
        description: Some("field recording"),
        media_kind: "file",
        format: "wav",
        storage_key: "abc.wav",
        size_bytes: 100,
        mtime_ms: None,
        duration_ms: Some(60_000),
        sample_rate: Some(48_000),
        channels: Some(2),
        content_hash: "hash-test",
        category_id: Some("noise_cat_weather"),
        capabilities_json: r#"{"loop":true,"seek":true,"fade":true}"#,
      };
      repository::insert_asset(&pool, &item, &["noise_tag_rain".to_string()])
        .await
        .expect("insert asset");

      let query = NoiseAssetQuery {
        keyword: Some("rain".to_string()),
        tag_id: Some("noise_tag_rain".to_string()),
        ..NoiseAssetQuery::default()
      };
      let (rows, total) = repository::list_assets(&pool, &query).await.expect("list");
      assert_eq!(total, 1);
      let view = asset_view(rows.into_iter().next().expect("row"));
      assert_eq!(view.name, "Local Rain");
      assert_eq!(
        view.category.as_ref().map(|item| item.id.as_str()),
        Some("noise_cat_weather")
      );
      assert_eq!(view.tags[0].id, "noise_tag_rain");
      assert!(view.capabilities.seek);
      assert!(!view.favorite);

      repository::set_favorite(&pool, "noise_asset_test", true)
        .await
        .expect("favorite");
      let query = NoiseAssetQuery {
        favorite_only: Some(true),
        ..NoiseAssetQuery::default()
      };
      let (_, total) = repository::list_assets(&pool, &query)
        .await
        .expect("list fav");
      assert_eq!(total, 1);
      crate::media::repository::db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }

  #[test]
  fn user_taxonomy_crud_and_cycle_guard() {
    let path =
      std::env::temp_dir().join(format!("lull-noise-taxonomy-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      super::super::catalog::seed(&pool).await.expect("seed");
      repository::insert_category(&pool, "cat_parent", "User parent", None, None, 100)
        .await
        .expect("parent");
      repository::insert_category(
        &pool,
        "cat_child",
        "User child",
        Some("cat_parent"),
        Some("leaf"),
        101,
      )
      .await
      .expect("child");
      assert!(
        repository::category_name_exists(&pool, "user child", Some("cat_parent"), None)
          .await
          .expect("name check")
      );
      assert!(
        validate_category_parent(&pool, Some("cat_parent"), Some("cat_child"))
          .await
          .is_err()
      );
      assert!(
        validate_category_parent(&pool, Some("cat_child"), Some("cat_parent"))
          .await
          .is_ok()
      );
      repository::update_category(
        &pool,
        "cat_child",
        "Renamed child",
        Some("cat_parent"),
        None,
        102,
      )
      .await
      .expect("update category");
      let category = repository::category(&pool, "cat_child")
        .await
        .expect("get category")
        .expect("exists");
      assert_eq!(category.name, "Renamed child");
      assert_eq!(category.source_type, "user");
      assert_eq!(
        repository::category_children_count(&pool, "cat_parent")
          .await
          .expect("children"),
        1
      );

      repository::insert_tag(&pool, "tag_user", "Rain", "rain")
        .await
        .expect("tag");
      assert!(repository::tag_name_exists(&pool, "rain", None)
        .await
        .expect("tag check"));
      repository::update_tag(&pool, "tag_user", "Heavy Rain", "heavy rain")
        .await
        .expect("update tag");
      let tag = repository::tag(&pool, "tag_user")
        .await
        .expect("get tag")
        .expect("exists");
      assert_eq!(tag.name, "Heavy Rain");
      assert_eq!(tag.source_type, "user");

      repository::delete_tag(&pool, "tag_user")
        .await
        .expect("delete tag");
      assert!(repository::tag(&pool, "tag_user")
        .await
        .expect("tag gone")
        .is_none());
      repository::delete_category(&pool, "cat_child")
        .await
        .expect("delete child");
      repository::delete_category(&pool, "cat_parent")
        .await
        .expect("delete parent");
      crate::media::repository::db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
