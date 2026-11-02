//! 本地媒体素材库（图片 / 视频）。
//!
//! 素材文件不复制，只登记用户通过系统文件对话框选中的绝对路径。前端永远拿不到
//! 任意路径，只能拿 `assetId`；真正的文件读取由 Rust 完成，HTML 渲染则通过
//! Tauri asset protocol（支持 Range）把文件交给 WebView。
//!
//! 存储：`%APPDATA%\\app.lull.desktop\\media.json`。文件损坏/缺失只回退空库，
//! 不影响壁纸与设置页启动。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::wallpaper::wlog;

pub const MEDIA_STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "media.json";
/// 图片白名单：WebView2 的 `<img>` 能直接解码的格式。
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];
/// 视频白名单：HTML `<video>` 在 WebView2 里保证可播的容器。
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "webm", "mov"];

/// 扩展名 → `image` / `video`；不在白名单里返回 None。
#[must_use]
pub fn media_kind(path: &Path) -> Option<&'static str> {
  let extension = path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(str::to_ascii_lowercase)?;
  if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
    return Some("image");
  }
  if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
    return Some("video");
  }
  None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetFile {
  pub id: String,
  pub path: String,
  pub name: String,
  /// `image` / `video`；旧库可能没有该字段，读取时按扩展名补算。
  #[serde(default)]
  pub kind: String,
  pub size_bytes: u64,
  pub added_at: u64,
}

/// 返回给前端的素材视图：不包含完整路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetView {
  pub id: String,
  pub name: String,
  /// `image` / `video`；前端据此选择 `<img>` 或 `<video>`。
  pub kind: String,
  pub size_bytes: u64,
  pub added_at: u64,
  pub available: bool,
}

/// 批量导入里单条失败的信息：只回文件名与原因，**不含**绝对路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetImportFailure {
  pub name: String,
  pub reason: String,
}

/// 批量导入结果：成功登记、重复跳过、失败明细。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetImportResult {
  pub added: Vec<MediaAssetView>,
  pub skipped: usize,
  pub failed: Vec<MediaAssetImportFailure>,
}

/// 显示名长度上限（按字符计，中文不按字节误判）。
pub const MAX_ASSET_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaStoreData {
  #[serde(default = "default_version")]
  version: u32,
  #[serde(default)]
  assets: Vec<MediaAssetFile>,
}

fn default_version() -> u32 {
  MEDIA_STORE_VERSION
}

impl Default for MediaStoreData {
  fn default() -> Self {
    Self {
      version: MEDIA_STORE_VERSION,
      assets: Vec::new(),
    }
  }
}

pub fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join(STORE_FILE))
    .map_err(|error| error.to_string())
}

fn load_data(app: &tauri::AppHandle) -> MediaStoreData {
  let Ok(path) = store_path(app) else {
    return MediaStoreData::default();
  };
  let Ok(text) = std::fs::read_to_string(&path) else {
    return MediaStoreData::default();
  };
  match serde_json::from_str::<MediaStoreData>(&text) {
    Ok(data) if data.version == MEDIA_STORE_VERSION => data,
    Ok(data) => {
      wlog(&format!(
        "media.json 版本 {} 与当前 {MEDIA_STORE_VERSION} 不兼容，已回退空素材库",
        data.version
      ));
      MediaStoreData::default()
    }
    Err(error) => {
      wlog(&format!("media.json 解析失败，已回退空素材库: {error}"));
      MediaStoreData::default()
    }
  }
}

fn save_data(app: &tauri::AppHandle, data: &MediaStoreData) -> Result<(), String> {
  let path = store_path(app)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let text = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
  let tmp = path.with_extension("json.tmp");
  {
    use std::io::Write;
    let mut file = std::fs::File::create(&tmp).map_err(|error| error.to_string())?;
    file
      .write_all(text.as_bytes())
      .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
  }
  match std::fs::rename(&tmp, &path) {
    Ok(()) => Ok(()),
    Err(first) => {
      let _ = std::fs::remove_file(&path);
      std::fs::rename(&tmp, &path).map_err(|second| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入 media.json 失败: {first}; 重试失败: {second}")
      })
    }
  }
}

/// 素材类型；旧库 `kind` 为空时按扩展名补算。
#[must_use]
pub fn kind_of(asset: &MediaAssetFile) -> &str {
  if asset.kind.is_empty() {
    media_kind(Path::new(&asset.path)).unwrap_or("video")
  } else {
    &asset.kind
  }
}

fn view(asset: &MediaAssetFile) -> MediaAssetView {
  MediaAssetView {
    id: asset.id.clone(),
    name: asset.name.clone(),
    kind: kind_of(asset).to_string(),
    size_bytes: asset.size_bytes,
    added_at: asset.added_at,
    available: Path::new(&asset.path).is_file(),
  }
}

pub fn list(app: &tauri::AppHandle) -> Vec<MediaAssetView> {
  load_data(app).assets.iter().map(view).collect()
}

pub fn find(app: &tauri::AppHandle, id: &str) -> Option<MediaAssetFile> {
  load_data(app)
    .assets
    .into_iter()
    .find(|asset| asset.id == id)
}

/// 单文件 → 待登记条目。纯 I/O，不读写 `media.json`，便于批量导入时逐条容错。
fn file_meta(path: &Path) -> Result<MediaAssetFile, String> {
  let path = path
    .canonicalize()
    .map_err(|error| format!("路径不可用: {error}"))?;
  if !path.is_file() {
    return Err("所选路径不是文件".to_string());
  }
  let extension = path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(str::to_ascii_lowercase)
    .unwrap_or_default();
  let kind = media_kind(&path).ok_or_else(|| format!("不支持的素材扩展名: .{extension}"))?;
  let path_text = path
    .to_str()
    .ok_or_else(|| "素材路径不是合法 UTF-8".to_string())?
    .to_string();
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("media")
    .to_string();
  let size_bytes = std::fs::metadata(&path)
    .map_err(|error| error.to_string())?
    .len();
  let added_at = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
    .unwrap_or_default();
  let id = id_for_path(&path_text);
  Ok(MediaAssetFile {
    id,
    path: path_text,
    name,
    kind: kind.to_string(),
    size_bytes,
    added_at,
  })
}

pub fn add_from_path(app: &tauri::AppHandle, path: &Path) -> Result<MediaAssetView, String> {
  let asset = file_meta(path)?;
  let mut data = load_data(app);
  if let Some(existing) = data.assets.iter().find(|item| item.id == asset.id) {
    return Ok(view(existing));
  }
  data.assets.push(asset.clone());
  save_data(app, &data)?;
  allow_asset(app, &asset.path);
  Ok(view(&asset))
}

/// 批量登记。单条失败不影响整批；只有确实新增了条目才写盘一次。
pub fn add_many(
  app: &tauri::AppHandle,
  paths: &[PathBuf],
) -> Result<MediaAssetImportResult, String> {
  let mut data = load_data(app);
  let mut result = MediaAssetImportResult::default();
  let mut added_files: Vec<MediaAssetFile> = Vec::new();
  for path in paths {
    match file_meta(path) {
      Err(reason) => result.failed.push(MediaAssetImportFailure {
        name: path
          .file_name()
          .and_then(|name| name.to_str())
          .unwrap_or("未知文件")
          .to_string(),
        reason,
      }),
      Ok(asset) if data.assets.iter().any(|item| item.id == asset.id) => {
        result.skipped += 1;
      }
      Ok(asset) => {
        result.added.push(view(&asset));
        data.assets.push(asset.clone());
        added_files.push(asset);
      }
    }
  }
  if added_files.is_empty() {
    return Ok(result);
  }
  // 写盘失败时 media.json 未被改动（tmp + rename），此时也还没放开 asset 白名单。
  save_data(app, &data)?;
  for asset in &added_files {
    allow_asset(app, &asset.path);
  }
  Ok(result)
}

/// 文件已不存在的素材 id；纯函数，便于单测。
fn missing_ids(assets: &[MediaAssetFile], exists: impl Fn(&str) -> bool) -> Vec<String> {
  assets
    .iter()
    .filter(|asset| !exists(&asset.path))
    .map(|asset| asset.id.clone())
    .collect()
}

/// 移除所有源文件已丢失的登记。只删索引，不动磁盘文件；没有可清理项时不写盘。
pub fn prune_missing(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
  let mut data = load_data(app);
  let missing = missing_ids(&data.assets, |path| Path::new(path).is_file());
  if missing.is_empty() {
    return Ok(missing);
  }
  data.assets.retain(|asset| !missing.contains(&asset.id));
  save_data(app, &data)?;
  Ok(missing)
}

/// 显示名归一化：去首尾空白、拒绝空名/控制字符/超长。
pub fn normalize_name(raw: &str) -> Result<String, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("素材名称不能为空".to_string());
  }
  if trimmed.chars().any(char::is_control) {
    return Err("素材名称不能包含控制字符".to_string());
  }
  if trimmed.chars().count() > MAX_ASSET_NAME_CHARS {
    return Err(format!("素材名称不能超过 {MAX_ASSET_NAME_CHARS} 个字符"));
  }
  Ok(trimmed.to_string())
}

/// 重命名显示名：不动 `path`、不改扩展名、不影响可用性判定。同名不写盘。
pub fn rename(app: &tauri::AppHandle, id: &str, name: &str) -> Result<MediaAssetView, String> {
  let name = normalize_name(name)?;
  let mut data = load_data(app);
  let position = data
    .assets
    .iter()
    .position(|asset| asset.id == id)
    .ok_or_else(|| "素材不存在".to_string())?;
  if data.assets[position].name == name {
    return Ok(view(&data.assets[position]));
  }
  data.assets[position].name = name;
  save_data(app, &data)?;
  Ok(view(&data.assets[position]))
}

pub fn remove(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
  let mut data = load_data(app);
  let before = data.assets.len();
  data.assets.retain(|asset| asset.id != id);
  if data.assets.len() == before {
    return Err("素材不存在".to_string());
  }
  save_data(app, &data)
}

/// 把素材加入 Tauri asset protocol 的动态白名单。
pub fn allow_asset(app: &tauri::AppHandle, path: &str) {
  if let Err(error) = app.asset_protocol_scope().allow_file(path) {
    wlog(&format!("asset protocol 白名单添加失败 {path}: {error}"));
  }
}

/// 生成 HTML `<video>` 可用的 asset URL（Tauri asset protocol，支持 Range）。
pub fn asset_url(webview: &tauri::WebviewWindow, path: &str) -> Result<String, String> {
  webview
    .convert_file_src(path, None)
    .map_err(|error| error.to_string())
}

fn id_for_path(path: &str) -> String {
  let digest = Sha256::digest(path.as_bytes());
  let hex = format!("{digest:x}");
  format!("m_{}", &hex[..16])
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn id_is_stable_and_path_specific() {
    let a = id_for_path(r"C:\Videos\a.mp4");
    let b = id_for_path(r"C:\Videos\a.mp4");
    let c = id_for_path(r"C:\Videos\b.mp4");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with("m_"));
    assert_eq!(a.len(), 18);
  }

  #[test]
  fn store_default_is_empty_and_current_version() {
    let data = MediaStoreData::default();
    assert_eq!(data.version, MEDIA_STORE_VERSION);
    assert!(data.assets.is_empty());
  }

  #[test]
  fn media_kind_matches_extension_whitelist() {
    assert_eq!(media_kind(Path::new("a.JPG")), Some("image"));
    assert_eq!(media_kind(Path::new("a.webp")), Some("image"));
    assert_eq!(media_kind(Path::new("a.bmp")), Some("image"));
    assert_eq!(media_kind(Path::new("a.MP4")), Some("video"));
    assert_eq!(media_kind(Path::new("a.mov")), Some("video"));
    // 不在白名单的格式不给前端“能选不能播”的假象。
    assert_eq!(media_kind(Path::new("a.mkv")), None);
    assert_eq!(media_kind(Path::new("a.svg")), None);
    assert_eq!(media_kind(Path::new("a")), None);
  }

  #[test]
  fn legacy_asset_without_kind_is_inferred_from_path() {
    let asset = MediaAssetFile {
      id: "m_1".into(),
      path: r"C:\Pictures\wall.png".into(),
      name: "wall.png".into(),
      kind: String::new(),
      size_bytes: 1,
      added_at: 0,
    };
    assert_eq!(kind_of(&asset), "image");
  }

  #[test]
  fn normalize_asset_name_trims_and_rejects() {
    assert_eq!(normalize_name("  夜景  ").as_deref(), Ok("夜景"));
    assert!(normalize_name("").is_err());
    assert!(normalize_name("   ").is_err());
    assert!(normalize_name("a\u{7}").is_err());
    assert!(normalize_name(&"a".repeat(MAX_ASSET_NAME_CHARS + 1)).is_err());
    // 按字符计长度：120 个汉字仍然是合法名称。
    let long = "夜".repeat(MAX_ASSET_NAME_CHARS);
    assert_eq!(normalize_name(&long).as_deref(), Ok(long.as_str()));
  }

  #[test]
  fn missing_ids_reports_only_missing_files() {
    let assets = vec![
      MediaAssetFile {
        id: "m_1".into(),
        path: r"C:\a.mp4".into(),
        name: "a.mp4".into(),
        kind: "video".into(),
        size_bytes: 1,
        added_at: 0,
      },
      MediaAssetFile {
        id: "m_2".into(),
        path: r"C:\b.png".into(),
        name: "b.png".into(),
        kind: "image".into(),
        size_bytes: 1,
        added_at: 0,
      },
    ];
    let missing = missing_ids(&assets, |path| path.ends_with("a.mp4"));
    assert_eq!(missing, vec!["m_2".to_string()]);
    assert!(missing_ids(&assets, |_| true).is_empty());
  }

  #[test]
  fn import_result_default_is_empty() {
    let result = MediaAssetImportResult::default();
    assert!(result.added.is_empty());
    assert_eq!(result.skipped, 0);
    assert!(result.failed.is_empty());
  }
}
