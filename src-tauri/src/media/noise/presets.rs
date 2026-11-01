//! N4 Noise Preset：列表/详情、保存/更新/删除、加载与缺失映射、收藏、导入导出。
//!
//! Preset 只保存配置快照（Asset 引用/哈希/名称/音量/循环/fade），不包含音频、
//! 脚本或任意路径。导入生成新的本地 ID，原 ID 写入 `origin_id`。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::dto::{
  NoisePresetDetail, NoisePresetExportResult, NoisePresetLoadResult, NoisePresetMissing,
  NoisePresetQuery, NoisePresetSummary, NoisePresetTrackView,
};
use super::{library, repository, session};
use crate::media::api::dto::Page;
use crate::media::api::errors::MediaError;
use crate::media::repository::new_id;

const SCHEMA_VERSION: u32 = 1;
const PRESET_TYPE: &str = "lull-noise-preset";
const MAX_TRACKS: usize = 32;
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_BYTES: usize = 2048;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_FADE_MS: i64 = 10_000;

fn read_allowed(label: &str) -> bool {
  matches!(label, "settings" | "noise" | "library")
}

fn write_allowed(label: &str) -> bool {
  matches!(label, "settings" | "noise")
}

fn file_allowed(label: &str) -> bool {
  label == "settings"
}

fn require_read(label: &str) -> Result<(), MediaError> {
  if read_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口不能读取 Noise Preset",
    ))
  }
}

fn require_write(label: &str) -> Result<(), MediaError> {
  if write_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口不能修改 Noise Preset",
    ))
  }
}

fn require_favorite(label: &str) -> Result<(), MediaError> {
  if read_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口不能收藏 Noise Preset",
    ))
  }
}

fn require_file(label: &str) -> Result<(), MediaError> {
  if file_allowed(label) {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "只有设置窗口可以导入/导出 Noise Preset 文件",
    ))
  }
}

fn summary(row: repository::PresetRow) -> NoisePresetSummary {
  NoisePresetSummary {
    id: row.id,
    origin_id: row.origin_id,
    name: row.name,
    description: row.description,
    source_type: row.source_type,
    author: row.author,
    schema_version: row.schema_version,
    master_volume: row.master_volume,
    cover_ref: row.cover_ref,
    favorite: row.favorite != 0,
    track_count: row.track_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

fn track_view(
  row: repository::PresetTrackRecord,
  asset_name: Option<String>,
) -> NoisePresetTrackView {
  let status = if asset_name.is_some() {
    "resolved"
  } else {
    "missing"
  };
  NoisePresetTrackView {
    id: row.id,
    asset_id: row.asset_id,
    asset_hash: row.asset_hash,
    asset_source_type: row.asset_source_type,
    asset_source_id: row.asset_source_id,
    expected_name: row.expected_name,
    volume: row.volume,
    enabled: row.enabled != 0,
    loop_: row.loop_ != 0,
    fade_in_ms: row.fade_in_ms,
    fade_out_ms: row.fade_out_ms,
    sort_order: row.sort_order,
    status: status.to_string(),
    asset_name,
  }
}

async fn summary_or_error(
  pool: &sqlx::SqlitePool,
  preset_id: &str,
) -> Result<repository::PresetRow, MediaError> {
  repository::preset(pool, preset_id)
    .await?
    .ok_or_else(|| MediaError::new("noise.preset.not-found", "Noise 预设不存在"))
}

async fn detail(pool: &sqlx::SqlitePool, preset_id: &str) -> Result<NoisePresetDetail, MediaError> {
  let row = summary_or_error(pool, preset_id).await?;
  let tracks = repository::preset_records(pool, preset_id).await?;
  let mut views = Vec::with_capacity(tracks.len());
  for track in tracks {
    let asset_name = resolve_asset(pool, &track).await?.map(|asset| asset.name);
    views.push(track_view(track, asset_name));
  }
  Ok(NoisePresetDetail {
    preset: summary(row),
    tracks: views,
  })
}

fn validate_name(name: &str) -> Result<String, MediaError> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
    return Err(MediaError::invalid("Preset 名称长度必须为 1–80"));
  }
  Ok(name.to_string())
}

fn validate_description(description: Option<&str>) -> Result<Option<String>, MediaError> {
  let Some(description) = description else {
    return Ok(None);
  };
  if description.len() > MAX_DESCRIPTION_BYTES {
    return Err(MediaError::invalid("Preset 描述不能超过 2 KB"));
  }
  Ok(Some(description.to_string()))
}

fn validate_cover(cover: Option<&str>) -> Result<Option<String>, MediaError> {
  let Some(cover) = cover else {
    return Ok(None);
  };
  let cover = cover.trim();
  if cover.is_empty() {
    return Ok(None);
  }
  if cover.starts_with("file:")
    || cover.starts_with('/')
    || cover.starts_with('\\')
    || Path::new(cover).is_absolute()
    || cover.len() > 512
  {
    return Err(MediaError::invalid("cover 只能是不透明 token"));
  }
  Ok(Some(cover.to_string()))
}

fn validate_volume(volume: f64) -> Result<f64, MediaError> {
  if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
    return Err(MediaError::invalid("音量必须在 0–1"));
  }
  Ok(volume)
}

fn validate_fade(value: Option<i64>) -> Result<Option<i64>, MediaError> {
  if value.is_some_and(|value| !(0..=MAX_FADE_MS).contains(&value)) {
    return Err(MediaError::invalid("fade 必须在 0–10000ms"));
  }
  Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetFile {
  #[serde(default = "default_schema")]
  schema_version: u32,
  #[serde(rename = "type")]
  kind: String,
  #[serde(default)]
  id: Option<String>,
  name: String,
  #[serde(default)]
  description: Option<String>,
  #[serde(default)]
  author: Option<String>,
  #[serde(default)]
  cover: Option<String>,
  #[serde(default = "default_master")]
  master_volume: f64,
  tracks: Vec<PresetFileTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetFileTrack {
  #[serde(default)]
  asset_id: Option<String>,
  #[serde(default)]
  asset_hash: Option<String>,
  #[serde(default)]
  asset_source_type: Option<String>,
  #[serde(default)]
  asset_source_id: Option<String>,
  expected_name: String,
  #[serde(default = "default_volume")]
  volume: f64,
  #[serde(default = "default_true")]
  enabled: bool,
  #[serde(rename = "loop", default = "default_true")]
  loop_: bool,
  #[serde(default)]
  fade_in_ms: Option<i64>,
  #[serde(default)]
  fade_out_ms: Option<i64>,
  #[serde(default)]
  order: Option<i64>,
}

fn default_schema() -> u32 {
  SCHEMA_VERSION
}

fn default_master() -> f64 {
  1.0
}

fn default_volume() -> f64 {
  1.0
}

fn default_true() -> bool {
  true
}

fn preset_file(detail: &NoisePresetDetail) -> Result<PresetFile, MediaError> {
  let mut tracks = Vec::with_capacity(detail.tracks.len());
  for (index, track) in detail.tracks.iter().enumerate() {
    tracks.push(PresetFileTrack {
      asset_id: track.asset_id.clone(),
      asset_hash: track.asset_hash.clone(),
      asset_source_type: track.asset_source_type.clone(),
      asset_source_id: track.asset_source_id.clone(),
      expected_name: track.expected_name.clone(),
      volume: track.volume,
      enabled: track.enabled,
      loop_: track.loop_,
      fade_in_ms: track.fade_in_ms,
      fade_out_ms: track.fade_out_ms,
      order: Some(i64::try_from(index).unwrap_or(i64::MAX)),
    });
  }
  Ok(PresetFile {
    schema_version: SCHEMA_VERSION,
    kind: PRESET_TYPE.to_string(),
    id: Some(
      detail
        .preset
        .origin_id
        .clone()
        .unwrap_or_else(|| detail.preset.id.clone()),
    ),
    name: detail.preset.name.clone(),
    description: detail.preset.description.clone(),
    author: detail.preset.author.clone(),
    cover: detail.preset.cover_ref.clone(),
    master_volume: detail.preset.master_volume,
    tracks,
  })
}

fn validate_file(mut file: PresetFile) -> Result<PresetFile, MediaError> {
  if file.schema_version != SCHEMA_VERSION || file.kind != PRESET_TYPE {
    return Err(MediaError::new(
      "noise.preset.version",
      "不支持的 Noise Preset 文件版本",
    ));
  }
  file.name = validate_name(&file.name)?;
  file.description = validate_description(file.description.as_deref())?;
  file.cover = validate_cover(file.cover.as_deref())?;
  file.master_volume = validate_volume(file.master_volume)?;
  if file.tracks.is_empty() || file.tracks.len() > MAX_TRACKS {
    return Err(MediaError::invalid("Preset 轨道数量必须为 1–32"));
  }
  let mut orders = HashSet::new();
  for track in &mut file.tracks {
    track.expected_name = validate_name(&track.expected_name)?;
    track.volume = validate_volume(track.volume)?;
    track.fade_in_ms = validate_fade(track.fade_in_ms)?;
    track.fade_out_ms = validate_fade(track.fade_out_ms)?;
    if let Some(order) = track.order {
      if !orders.insert(order) {
        return Err(MediaError::invalid("Preset track order 不能重复"));
      }
    }
  }
  file
    .tracks
    .sort_by_key(|track| track.order.unwrap_or(i64::MAX));
  Ok(file)
}

fn emit_preset(app: &AppHandle, topic: &str, preset_id: &str, name: &str) {
  crate::media::events::emit(
    app,
    topic,
    super::next_library_revision(),
    json!({ "presetId": preset_id, "name": name }),
  );
}

fn safe_filename(name: &str) -> String {
  let mut value: String = name
    .chars()
    .map(|ch| match ch {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      _ => ch,
    })
    .take(60)
    .collect();
  if value.trim().is_empty() {
    value = "noise-preset".to_string();
  }
  format!("{value}.lull-noise.json")
}

pub async fn call(
  app: &AppHandle,
  label: &str,
  method: &str,
  args: &Value,
) -> Result<Value, MediaError> {
  match method {
    "listPresets" => {
      require_read(label)?;
      let query: NoisePresetQuery = serde_json::from_value(args.clone())
        .map_err(|error| MediaError::invalid(format!("Preset 查询参数无效：{error}")))?;
      let pool = crate::media::library::pool()?;
      let (rows, total) = repository::list_presets(pool, &query).await?;
      let page = Page::new(
        rows.into_iter().map(summary).collect(),
        total,
        query.page(),
        query.page_size(),
      );
      serde_json::to_value(page)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "getPreset" => {
      require_read(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let pool = crate::media::library::pool()?;
      serde_json::to_value(detail(pool, preset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "savePreset" => {
      require_write(label)?;
      let name = validate_name(string_arg(args, "name")?)?;
      let description = validate_description(args.get("description").and_then(Value::as_str))?;
      let cover = validate_cover(args.get("cover").and_then(Value::as_str))?;
      let snapshot = session::snapshot()?;
      if snapshot.tracks.is_empty() {
        return Err(MediaError::new(
          "noise.session.empty",
          "当前 Session 没有音轨，无法保存 Preset",
        ));
      }
      let pool = crate::media::library::pool()?;
      let mut tracks = Vec::with_capacity(snapshot.tracks.len());
      for (index, track) in snapshot.tracks.iter().enumerate() {
        let identity = repository::asset_identity(pool, &track.asset_id).await?;
        tracks.push(repository::NewPresetTrack {
          id: new_id("noise_preset_track"),
          asset_id: Some(track.asset_id.clone()),
          asset_hash: identity.as_ref().and_then(|item| item.content_hash.clone()),
          asset_source_type: identity.as_ref().map(|item| item.source_type.clone()),
          asset_source_id: identity.as_ref().map(|item| item.source_id.clone()),
          expected_name: track.name.clone(),
          volume: track.volume,
          enabled: track.enabled,
          loop_: track.loop_,
          fade_in_ms: track.fade_in_ms,
          fade_out_ms: track.fade_out_ms,
          sort_order: i64::try_from(index).unwrap_or(i64::MAX),
        });
      }
      let preset_id = new_id("noise_preset");
      repository::insert_preset(
        pool,
        &repository::NewPreset {
          id: preset_id.clone(),
          origin_id: None,
          name: name.clone(),
          description,
          source_type: "user".to_string(),
          author: None,
          schema_version: i64::from(SCHEMA_VERSION),
          master_volume: snapshot.master_volume,
          cover_ref: cover,
          tracks,
        },
      )
      .await?;
      session::remember_preset(Some(preset_id.clone()));
      emit_preset(app, "noise.preset.created", &preset_id, &name);
      serde_json::to_value(detail(pool, &preset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "updatePreset" => {
      require_write(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let pool = crate::media::library::pool()?;
      let existing = summary_or_error(pool, preset_id).await?;
      if existing.source_type == "builtin" {
        return Err(MediaError::new(
          "noise.preset.builtin",
          "内置 Noise 预设不能修改",
        ));
      }
      let name = match args.get("name") {
        Some(Value::String(value)) => validate_name(value)?,
        Some(_) => return Err(MediaError::invalid("name 必须是字符串")),
        None => existing.name.clone(),
      };
      let description = if args.get("description").is_some() {
        validate_description(args.get("description").and_then(Value::as_str))?
      } else {
        existing.description.clone()
      };
      let cover = if args.get("cover").is_some() {
        validate_cover(args.get("cover").and_then(Value::as_str))?
      } else {
        existing.cover_ref.clone()
      };
      repository::update_preset_metadata(
        pool,
        preset_id,
        &name,
        description.as_deref(),
        cover.as_deref(),
      )
      .await?;
      emit_preset(app, "noise.preset.updated", preset_id, &name);
      serde_json::to_value(detail(pool, preset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "deletePreset" => {
      require_write(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let pool = crate::media::library::pool()?;
      let existing = summary_or_error(pool, preset_id).await?;
      if existing.source_type == "builtin" {
        return Err(MediaError::new(
          "noise.preset.builtin",
          "内置 Noise 预设不能删除",
        ));
      }
      repository::delete_preset(pool, preset_id).await?;
      session::forget_preset_if(preset_id);
      emit_preset(app, "noise.preset.deleted", preset_id, &existing.name);
      Ok(json!({ "removed": true }))
    }
    "setPresetFavorite" => {
      require_favorite(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let favorite = args
        .get("favorite")
        .and_then(Value::as_bool)
        .ok_or_else(|| MediaError::invalid("缺少 favorite"))?;
      let pool = crate::media::library::pool()?;
      let _ = summary_or_error(pool, preset_id).await?;
      repository::set_preset_favorite(pool, preset_id, favorite).await?;
      let updated = summary_or_error(pool, preset_id).await?;
      emit_preset(app, "noise.preset.updated", preset_id, &updated.name);
      serde_json::to_value(summary(updated))
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "loadPreset" => {
      require_write(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let pool = crate::media::library::pool()?;
      let detail = detail(pool, preset_id).await?;
      let tracks = repository::preset_records(pool, preset_id).await?;
      let mut resolved_tracks = Vec::new();
      let mut resolved = Vec::new();
      let mut missing = Vec::new();
      for track in tracks {
        if let Some(asset) = resolve_asset(pool, &track).await? {
          resolved_tracks.push(session::PresetSessionTrack {
            asset,
            name: track.expected_name,
            volume: track.volume,
            enabled: track.enabled != 0,
            loop_: track.loop_ != 0,
            fade_in_ms: track.fade_in_ms,
            fade_out_ms: track.fade_out_ms,
          });
          resolved.push(track.id);
        } else {
          let candidates = candidates(pool, &track.expected_name).await?;
          missing.push(NoisePresetMissing {
            preset_track_id: track.id,
            expected_name: track.expected_name,
            candidates,
          });
        }
      }
      let session_view = session::replace_with_preset(
        app,
        resolved_tracks,
        detail.preset.master_volume,
        Some(preset_id.to_string()),
      )?;
      serde_json::to_value(NoisePresetLoadResult {
        preset: detail.preset,
        session: session_view,
        resolved,
        missing,
      })
      .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 结果失败：{error}")))
    }
    "mapPresetTrack" => {
      require_write(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let preset_track_id = string_arg(args, "presetTrackId")?;
      let asset_id = string_arg(args, "assetId")?;
      let pool = crate::media::library::pool()?;
      let existing = summary_or_error(pool, preset_id).await?;
      if existing.source_type == "builtin" {
        return Err(MediaError::new(
          "noise.preset.builtin",
          "内置 Noise 预设不能修改轨道映射",
        ));
      }
      let asset = repository::asset(pool, asset_id)
        .await?
        .ok_or_else(|| MediaError::new("noise.asset.not-found", "Noise 素材不存在"))?;
      if asset.status != "available" {
        return Err(MediaError::new("noise.asset.missing", "Noise 素材不可用"));
      }
      repository::map_preset_track(pool, preset_id, preset_track_id, asset_id).await?;
      emit_preset(app, "noise.preset.updated", preset_id, &existing.name);
      serde_json::to_value(detail(pool, preset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    "exportPreset" => {
      require_file(label)?;
      let preset_id = string_arg(args, "presetId")?;
      let pool = crate::media::library::pool()?;
      let detail = detail(pool, preset_id).await?;
      let file = preset_file(&detail)?;
      let text = serde_json::to_string_pretty(&file)
        .map_err(|error| MediaError::internal(format!("序列化 Preset 文件失败：{error}")))?;
      let suggested = safe_filename(&detail.preset.name);
      let path = match args.get("path").and_then(Value::as_str) {
        Some(path) => PathBuf::from(path),
        None => {
          let Some(path) = rfd::FileDialog::new()
            .add_filter("Lull Noise Preset", &["json"])
            .set_file_name(&suggested)
            .save_file()
          else {
            return serde_json::to_value(NoisePresetExportResult { file_name: None })
              .map_err(|error| MediaError::internal(format!("序列化导出结果失败：{error}")));
          };
          path
        }
      };
      std::fs::write(&path, text)
        .map_err(|error| MediaError::internal(format!("写入 Preset 文件失败：{error}")))?;
      let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string);
      serde_json::to_value(NoisePresetExportResult { file_name })
        .map_err(|error| MediaError::internal(format!("序列化导出结果失败：{error}")))
    }
    "importPreset" => {
      require_file(label)?;
      let path = match args.get("path").and_then(Value::as_str) {
        Some(path) => PathBuf::from(path),
        None => {
          let Some(path) = rfd::FileDialog::new()
            .add_filter("Lull Noise Preset", &["json"])
            .pick_file()
          else {
            return Ok(Value::Null);
          };
          path
        }
      };
      let metadata = std::fs::metadata(&path)
        .map_err(|error| MediaError::internal(format!("读取 Preset 文件失败：{error}")))?;
      if metadata.len() > MAX_FILE_BYTES {
        return Err(MediaError::new(
          "noise.preset.too-large",
          "Preset 文件不能超过 512 KB",
        ));
      }
      let text = std::fs::read_to_string(&path)
        .map_err(|error| MediaError::internal(format!("读取 Preset 文件失败：{error}")))?;
      let parsed: PresetFile = serde_json::from_str(&text).map_err(|error| {
        MediaError::new("noise.preset.invalid", format!("Preset JSON 无效：{error}"))
      })?;
      let file = validate_file(parsed)?;
      let pool = crate::media::library::pool()?;
      let preset_id = new_id("noise_preset");
      let mut tracks = Vec::with_capacity(file.tracks.len());
      for (index, track) in file.tracks.iter().enumerate() {
        tracks.push(repository::NewPresetTrack {
          id: new_id("noise_preset_track"),
          asset_id: track.asset_id.clone(),
          asset_hash: track.asset_hash.clone(),
          asset_source_type: track.asset_source_type.clone(),
          asset_source_id: track.asset_source_id.clone(),
          expected_name: track.expected_name.clone(),
          volume: track.volume,
          enabled: track.enabled,
          loop_: track.loop_,
          fade_in_ms: track.fade_in_ms,
          fade_out_ms: track.fade_out_ms,
          sort_order: i64::try_from(index).unwrap_or(i64::MAX),
        });
      }
      repository::insert_preset(
        pool,
        &repository::NewPreset {
          id: preset_id.clone(),
          origin_id: file.id,
          name: file.name.clone(),
          description: file.description,
          source_type: "community".to_string(),
          author: file.author,
          schema_version: i64::from(SCHEMA_VERSION),
          master_volume: file.master_volume,
          cover_ref: file.cover,
          tracks,
        },
      )
      .await?;
      emit_preset(app, "noise.preset.created", &preset_id, &file.name);
      serde_json::to_value(detail(pool, &preset_id).await?)
        .map_err(|error| MediaError::internal(format!("序列化 Noise Preset 失败：{error}")))
    }
    _ => Err(MediaError::new(
      "method.unknown",
      format!("不支持的 Noise Preset 方法：{method}"),
    )),
  }
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, MediaError> {
  args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| MediaError::invalid(format!("缺少 {key}")))
}

async fn resolve_asset(
  pool: &sqlx::SqlitePool,
  track: &repository::PresetTrackRecord,
) -> Result<Option<repository::AssetRow>, MediaError> {
  if let Some(asset_id) = track.asset_id.as_deref() {
    if let Some(asset) = repository::asset(pool, asset_id).await? {
      if asset.status == "available" {
        return Ok(Some(asset));
      }
    }
  }
  if let Some(hash) = track.asset_hash.as_deref() {
    if let Some(asset) = repository::asset_by_hash(pool, hash).await? {
      if asset.status == "available" {
        return Ok(Some(asset));
      }
    }
  }
  Ok(None)
}

async fn candidates(
  pool: &sqlx::SqlitePool,
  name: &str,
) -> Result<Vec<super::dto::NoiseAssetView>, MediaError> {
  let mut candidates = Vec::new();
  for asset in repository::assets_by_name(pool, name, 5).await? {
    if let Some(row) = repository::asset_detail(pool, &asset.id).await? {
      candidates.push(library::asset_view(row));
    }
  }
  Ok(candidates)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preset_file_validation_rejects_versions_and_duplicate_orders() {
    let mut file = PresetFile {
      schema_version: SCHEMA_VERSION,
      kind: PRESET_TYPE.to_string(),
      id: None,
      name: "Test".to_string(),
      description: None,
      author: None,
      cover: None,
      master_volume: 0.8,
      tracks: vec![
        PresetFileTrack {
          asset_id: None,
          asset_hash: None,
          asset_source_type: None,
          asset_source_id: None,
          expected_name: "Rain".to_string(),
          volume: 0.5,
          enabled: true,
          loop_: true,
          fade_in_ms: Some(80),
          fade_out_ms: Some(120),
          order: Some(0),
        },
        PresetFileTrack {
          asset_id: None,
          asset_hash: None,
          asset_source_type: None,
          asset_source_id: None,
          expected_name: "Wind".to_string(),
          volume: 0.3,
          enabled: true,
          loop_: true,
          fade_in_ms: None,
          fade_out_ms: None,
          order: Some(0),
        },
      ],
    };
    assert!(validate_file(file.clone()).is_err());
    file.tracks[1].order = Some(1);
    assert!(validate_file(file.clone()).is_ok());
    file.schema_version = 2;
    assert!(validate_file(file).is_err());
  }

  #[test]
  fn cover_tokens_reject_paths() {
    assert!(validate_cover(Some("cover-token")).is_ok());
    assert!(validate_cover(Some("C:\\cover.png")).is_err());
    assert!(validate_cover(Some("/tmp/cover.png")).is_err());
    assert!(validate_cover(Some("file:///cover.png")).is_err());
  }

  #[test]
  fn preset_file_roundtrips_export_shape() {
    let detail = NoisePresetDetail {
      preset: NoisePresetSummary {
        id: "preset".to_string(),
        origin_id: None,
        name: "Night".to_string(),
        description: None,
        source_type: "user".to_string(),
        author: None,
        schema_version: 1,
        master_volume: 0.8,
        cover_ref: None,
        favorite: false,
        track_count: 1,
        created_at: 1,
        updated_at: 2,
      },
      tracks: vec![NoisePresetTrackView {
        id: "track".to_string(),
        asset_id: Some("asset".to_string()),
        asset_hash: Some("hash".to_string()),
        asset_source_type: Some("local".to_string()),
        asset_source_id: Some("source".to_string()),
        expected_name: "Rain".to_string(),
        volume: 0.7,
        enabled: true,
        loop_: true,
        fade_in_ms: Some(80),
        fade_out_ms: Some(120),
        sort_order: 0,
        status: "resolved".to_string(),
        asset_name: Some("Rain".to_string()),
      }],
    };
    let file = preset_file(&detail).expect("file");
    let text = serde_json::to_string(&file).expect("serialize");
    assert!(text.contains("\"type\":\"lull-noise-preset\""));
    assert!(text.contains("\"loop\":true"));
    let parsed: PresetFile = serde_json::from_str(&text).expect("deserialize");
    assert_eq!(parsed.name, "Night");
    assert_eq!(parsed.tracks[0].expected_name, "Rain");
  }

  #[test]
  fn preset_repository_lists_favorites_and_user_presets() {
    let path = std::env::temp_dir().join(format!("lull-noise-presets-{}.db", uuid::Uuid::now_v7()));
    tauri::async_runtime::block_on(async {
      let pool = crate::media::repository::db::open_at(&path)
        .await
        .expect("open db");
      super::super::catalog::seed(&pool).await.expect("seed");
      let query = NoisePresetQuery::default();
      let (presets, total) = repository::list_presets(&pool, &query)
        .await
        .expect("list presets");
      assert!(total >= 4);
      let builtin = presets
        .iter()
        .find(|preset| preset.source_type == "builtin")
        .expect("builtin");
      let records = repository::preset_records(&pool, &builtin.id)
        .await
        .expect("records");
      assert!(!records.is_empty());
      let identity = repository::asset_identity(&pool, "noise:builtin:rain")
        .await
        .expect("identity")
        .expect("asset");
      assert_eq!(identity.source_type, "builtin");

      repository::set_preset_favorite(&pool, &builtin.id, true)
        .await
        .expect("favorite");
      let favorite_query = NoisePresetQuery {
        favorite_only: Some(true),
        ..NoisePresetQuery::default()
      };
      let (favorites, favorites_total) = repository::list_presets(&pool, &favorite_query)
        .await
        .expect("favorites");
      assert_eq!(favorites_total, 1);
      assert_eq!(favorites[0].id, builtin.id);

      let user_id = "noise_preset_test";
      repository::insert_preset(
        &pool,
        &repository::NewPreset {
          id: user_id.to_string(),
          origin_id: Some("origin".to_string()),
          name: "User".to_string(),
          description: Some("test".to_string()),
          source_type: "user".to_string(),
          author: None,
          schema_version: 1,
          master_volume: 0.6,
          cover_ref: Some("token".to_string()),
          tracks: vec![repository::NewPresetTrack {
            id: "track".to_string(),
            asset_id: Some("noise:builtin:rain".to_string()),
            asset_hash: identity.content_hash,
            asset_source_type: Some(identity.source_type),
            asset_source_id: Some(identity.source_id),
            expected_name: "Rain".to_string(),
            volume: 0.7,
            enabled: true,
            loop_: true,
            fade_in_ms: Some(80),
            fade_out_ms: Some(120),
            sort_order: 0,
          }],
        },
      )
      .await
      .expect("insert");
      let user = repository::preset(&pool, user_id)
        .await
        .expect("get")
        .expect("exists");
      assert_eq!(user.name, "User");
      assert_eq!(user.track_count, 1);
      assert_eq!(user.source_type, "user");

      repository::map_preset_track(&pool, user_id, "track", "noise:builtin:wind")
        .await
        .expect("map track");
      let mapped = repository::preset_records(&pool, user_id)
        .await
        .expect("mapped records");
      assert_eq!(mapped[0].asset_id.as_deref(), Some("noise:builtin:wind"));
      assert_eq!(mapped[0].asset_source_type.as_deref(), Some("builtin"));
      repository::delete_preset(&pool, user_id)
        .await
        .expect("delete");
      crate::media::repository::db::close(&pool).await;
    });
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
  }
}
