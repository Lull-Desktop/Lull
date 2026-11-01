//! Noise 本地文件素材：受管目录、导入复制、hash 与缺失检查。
//!
//! 用户文件只读；导入时复制到 `<music>/noise/assets/<sha256>.<ext>`，数据库
//! 只保存文件名。任何路径都不进入公开 DTO。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::Manager;
use uuid::Uuid;

use crate::media::api::errors::MediaError;
use crate::media::library::metadata;
use crate::media::repository::db;

pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_DURATION_MS: i64 = 30 * 60 * 1000;
const EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac"];

pub fn assets_dir(app: &tauri::AppHandle) -> PathBuf {
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
  let dir = root.join("noise").join("assets");
  let _ = fs::create_dir_all(&dir);
  dir
}

#[must_use]
pub fn path_for(app: &tauri::AppHandle, storage_key: &str) -> PathBuf {
  let name = Path::new(storage_key)
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("missing");
  assets_dir(app).join(name)
}

#[must_use]
pub fn supported_extension(path: &Path) -> Option<String> {
  path
    .extension()
    .and_then(|value| value.to_str())
    .map(str::to_lowercase)
    .filter(|value| EXTENSIONS.contains(&value.as_str()))
}

#[derive(Debug, Clone)]
pub struct PreparedImport {
  pub name: String,
  pub format: String,
  pub storage_key: String,
  pub content_hash: String,
  pub size_bytes: i64,
  pub mtime_ms: Option<i64>,
  pub duration_ms: Option<i64>,
  pub sample_rate: Option<i64>,
  pub channels: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ImportError {
  pub code: String,
  pub reason: String,
}

impl ImportError {
  fn new(code: &str, reason: impl Into<String>) -> Self {
    Self {
      code: code.to_string(),
      reason: reason.into(),
    }
  }
}

impl From<MediaError> for ImportError {
  fn from(error: MediaError) -> Self {
    Self {
      code: error.code.to_string(),
      reason: error.message,
    }
  }
}

fn metadata_failure(reason: impl Into<String>) -> ImportError {
  ImportError::new("noise.asset.invalid", reason)
}

/// 复制 + 流式 SHA-256 + 元数据。调用方应在 `spawn_blocking` 中运行。
pub fn prepare_import(dir: &Path, path: &Path) -> Result<PreparedImport, ImportError> {
  let extension = supported_extension(path)
    .ok_or_else(|| ImportError::new("noise.asset.unsupported", "不支持的音频格式"))?;
  let source_meta = fs::metadata(path).map_err(|error| {
    ImportError::new("noise.asset.unreadable", format!("无法读取文件：{error}"))
  })?;
  if source_meta.len() > MAX_BYTES {
    return Err(ImportError::new(
      "noise.asset.too-large",
      "单个素材不能超过 100 MB",
    ));
  }

  let parsed = metadata::parse_file(path)
    .map_err(|error| metadata_failure(format!("无法解析音频元数据：{error}")))?;
  if let Some(duration) = parsed.duration_ms {
    if duration > MAX_DURATION_MS {
      return Err(ImportError::new(
        "noise.asset.too-long",
        "单个素材不能超过 30 分钟",
      ));
    }
  }

  let temp = dir.join(format!(".import-{}.tmp", Uuid::new_v4()));
  let copy_result = (|| -> Result<(String, u64), ImportError> {
    let mut source = File::open(path).map_err(|error| {
      ImportError::new("noise.asset.unreadable", format!("无法读取文件：{error}"))
    })?;
    let mut target = File::create(&temp).map_err(|error| {
      ImportError::new(
        "noise.asset.copy-failed",
        format!("无法创建临时文件：{error}"),
      )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
      let read = source.read(&mut buffer).map_err(|error| {
        ImportError::new("noise.asset.unreadable", format!("读取文件失败：{error}"))
      })?;
      if read == 0 {
        break;
      }
      hasher.update(&buffer[..read]);
      target.write_all(&buffer[..read]).map_err(|error| {
        ImportError::new(
          "noise.asset.copy-failed",
          format!("写入临时文件失败：{error}"),
        )
      })?;
      size += u64::try_from(read).unwrap_or(0);
    }
    target.sync_all().map_err(|error| {
      ImportError::new(
        "noise.asset.copy-failed",
        format!("同步临时文件失败：{error}"),
      )
    })?;
    Ok((format!("{:x}", hasher.finalize()), size))
  })();

  let (hash, size) = match copy_result {
    Ok(result) => result,
    Err(error) => {
      let _ = fs::remove_file(&temp);
      return Err(error);
    }
  };
  let storage_key = format!("{hash}.{extension}");
  let destination = dir.join(&storage_key);
  if destination.exists() {
    let _ = fs::remove_file(&temp);
  } else if let Err(error) = fs::rename(&temp, &destination) {
    let _ = fs::remove_file(&temp);
    return Err(ImportError::new(
      "noise.asset.copy-failed",
      format!("保存素材失败：{error}"),
    ));
  }

  let file_name = path
    .file_stem()
    .and_then(|value| value.to_str())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("未命名素材");
  let name = parsed
    .title
    .filter(|value| !value.trim().is_empty())
    .unwrap_or_else(|| file_name.to_string());
  let name: String = name.trim().chars().take(80).collect();
  let mtime_ms = source_meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .and_then(|duration| i64::try_from(duration.as_millis()).ok());

  Ok(PreparedImport {
    name,
    format: extension,
    storage_key,
    content_hash: hash,
    size_bytes: i64::try_from(size).unwrap_or(i64::MAX),
    mtime_ms,
    duration_ms: parsed.duration_ms,
    sample_rate: parsed.sample_rate,
    channels: parsed.channels,
  })
}

pub fn remove_stored(app: &tauri::AppHandle, storage_key: &str) {
  let path = path_for(app, storage_key);
  if path.is_file() {
    let _ = fs::remove_file(path);
  }
}

#[must_use]
pub fn stored_exists(app: &tauri::AppHandle, storage_key: &str) -> bool {
  path_for(app, storage_key).is_file()
}

pub fn collect_folder(root: &Path) -> Vec<PathBuf> {
  walkdir::WalkDir::new(root)
    .follow_links(false)
    .into_iter()
    .filter_map(Result::ok)
    .filter(|entry| entry.file_type().is_file())
    .filter(|entry| supported_extension(entry.path()).is_some())
    .map(walkdir::DirEntry::into_path)
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write_wav(path: &Path, sample_rate: u32, seconds: u32) {
    let channels = 1_u16;
    let bits = 16_u16;
    let data_size = sample_rate * seconds * u32::from(channels) * u32::from(bits / 8);
    let mut bytes = Vec::with_capacity((44 + data_size) as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&bits.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.resize((44 + data_size) as usize, 0);
    std::fs::write(path, bytes).expect("write wav");
  }

  #[test]
  fn import_copies_hashes_and_reports_metadata() {
    let root = std::env::temp_dir().join(format!("lull-noise-assets-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create root");
    let source = root.join("rain.wav");
    write_wav(&source, 8000, 1);
    let prepared = prepare_import(&root, &source).expect("prepare import");
    assert_eq!(prepared.format, "wav");
    assert_eq!(prepared.content_hash.len(), 64);
    assert_eq!(prepared.sample_rate, Some(8000));
    assert_eq!(prepared.channels, Some(1));
    assert!(prepared.duration_ms.unwrap_or(0) >= 900);
    assert!(root.join(&prepared.storage_key).is_file());
    let second = prepare_import(&root, &source).expect("duplicate prepare");
    assert_eq!(second.content_hash, prepared.content_hash);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn unsupported_or_oversized_files_are_rejected() {
    let root = std::env::temp_dir().join(format!("lull-noise-bad-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create root");
    let text = root.join("note.txt");
    std::fs::write(&text, b"nope").expect("write");
    let error = prepare_import(&root, &text).expect_err("reject text");
    assert_eq!(error.code, "noise.asset.unsupported");
    let _ = std::fs::remove_dir_all(&root);
  }
}
