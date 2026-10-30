//! 媒体 Tauri 命令：配置、素材库、会话与诊断。
//!
//! 安全边界：
//! - 素材选择/配置写入只允许 `settings` 窗口；
//! - 壁纸窗口只能操作会话，且必须带顶层帧 token；
//! - JS 永远不能传文件路径或 display/webview 标识。

#[cfg(feature = "native-media")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "native-media")]
use std::sync::Arc;
#[cfg(feature = "native-media")]
use std::time::Duration;

use tauri::{AppHandle, WebviewWindow};
#[cfg(feature = "native-media")]
use windows::core::Interface;

use super::assets::{self, MediaAssetView};
#[cfg(feature = "native-media")]
use super::backends::media_pp::NativeContext;
use super::config::MediaConfig;
use super::diagnostics::{
  MediaAttachResult, MediaCapabilities, MediaConfigView, MediaOpenResult, MediaSessionView,
  MediaStats,
};
use super::engine::engine;
use super::events;
use super::lifecycle;
#[cfg(feature = "native-media")]
use super::native_bridge::{self, NativeStream};
use crate::config::{DisplayConfig, DisplayMode};
use crate::wallpaper::runtime;

#[cfg(feature = "native-media")]
static STREAM_GENERATION: AtomicU64 = AtomicU64::new(1);

const ALLOWED_ORIGINS: &[&str] = &[
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

fn ensure_settings(label: &str) -> Result<(), String> {
  if label == "settings" {
    Ok(())
  } else {
    Err("只有设置窗口可以执行该媒体操作".to_string())
  }
}

fn authorize(label: &str, token: Option<&str>) -> Result<(), String> {
  lifecycle::authorize(label, token)
}

fn validate_origin(origin: &str) -> Result<(), String> {
  if ALLOWED_ORIGINS.contains(&origin) {
    Ok(())
  } else {
    Err(format!("不支持的媒体来源: {origin}"))
  }
}

fn share_global(display: &DisplayConfig) -> bool {
  match display.mode {
    DisplayMode::Mirror | DisplayMode::Span => true,
    DisplayMode::Independent => display.media.share == "shared",
  }
}

fn current_display() -> Result<DisplayConfig, String> {
  let guard = runtime::config()?;
  Ok(guard.data.display.clone())
}

#[tauri::command]
pub fn media_capabilities() -> MediaCapabilities {
  engine().capabilities()
}

#[tauri::command]
pub fn media_assets(app: AppHandle, webview: WebviewWindow) -> Result<Vec<MediaAssetView>, String> {
  ensure_settings(webview.label())?;
  Ok(assets::list(&app))
}

#[tauri::command]
pub async fn media_asset_pick(
  app: AppHandle,
  webview: WebviewWindow,
) -> Result<Option<MediaAssetView>, String> {
  ensure_settings(webview.label())?;
  let picked = tauri::async_runtime::spawn_blocking(|| {
    rfd::FileDialog::new()
      .add_filter("Video", &["mp4", "m4v", "webm", "mov"])
      .pick_file()
  })
  .await
  .map_err(|error| error.to_string())?;
  let Some(path) = picked else {
    return Ok(None);
  };
  assets::add_from_path(&app, &path).map(Some)
}

#[tauri::command]
pub fn media_asset_remove(
  app: AppHandle,
  webview: WebviewWindow,
  id: String,
) -> Result<(), String> {
  ensure_settings(webview.label())?;
  {
    let mut guard = runtime::config()?;
    let old = guard.data.display.media.clone();
    if old.asset_id.as_deref() == Some(id.as_str()) {
      guard.data.display.media.asset_id = None;
      if let Err(error) = guard.data.save(&guard.path) {
        guard.data.display.media = old;
        return Err(format!("保存配置失败: {error}"));
      }
    }
  }
  assets::remove(&app, &id)?;
  engine().stop_all();
  runtime::reapply(&app)?;
  events::emit_config_changed(&app);
  Ok(())
}

#[tauri::command]
pub fn media_config_get(
  app: AppHandle,
  webview: WebviewWindow,
  token: Option<String>,
) -> Result<MediaConfigView, String> {
  authorize(webview.label(), token.as_deref())?;
  let display = current_display()?;
  let asset = display
    .media
    .asset_id
    .as_deref()
    .and_then(|id| assets::list(&app).into_iter().find(|item| item.id == id));
  let asset_url = asset.as_ref().and_then(|item| {
    if !item.available {
      return None;
    }
    let file = assets::find(&app, &item.id)?;
    assets::allow_asset(&app, &file.path);
    assets::asset_url(&webview, &file.path).ok()
  });
  Ok(MediaConfigView {
    config: display.media,
    asset,
    asset_url,
    capabilities: engine().capabilities(),
  })
}

#[tauri::command]
pub fn media_config_set(
  app: AppHandle,
  webview: WebviewWindow,
  config: MediaConfig,
) -> Result<MediaConfigView, String> {
  ensure_settings(webview.label())?;
  let normalized = config.normalized();
  let playback_changed = {
    let mut guard = runtime::config()?;
    let old = guard.data.display.media.clone();
    let playback_changed = !old.playback_eq(&normalized);
    guard.data.display.media = normalized;
    if let Err(error) = guard.data.save(&guard.path) {
      guard.data.display.media = old;
      return Err(format!("保存配置失败: {error}"));
    }
    playback_changed
  };
  if playback_changed {
    engine().stop_all();
  }
  runtime::reapply(&app)?;
  events::emit_config_changed(&app);
  events::emit_changed(&app, Vec::new());
  media_config_get(app, webview, None)
}

#[tauri::command]
pub fn media_activate(
  app: AppHandle,
  webview: WebviewWindow,
  asset_id: String,
) -> Result<MediaConfigView, String> {
  ensure_settings(webview.label())?;
  let asset = assets::find(&app, &asset_id).ok_or_else(|| "素材不存在".to_string())?;
  if !std::path::Path::new(&asset.path).is_file() {
    return Err("视频文件不存在或已被移动".to_string());
  }
  {
    let mut guard = runtime::config()?;
    let old_display = guard.data.display.clone();
    guard.data.display.scene = "lull.video".to_string();
    guard.data.display.media.asset_id = Some(asset_id);
    guard.data.display.media = guard.data.display.media.clone().normalized();
    if let Err(error) = guard.data.save(&guard.path) {
      guard.data.display = old_display;
      return Err(format!("保存配置失败: {error}"));
    }
  }
  engine().stop_all();
  runtime::reapply(&app)?;
  events::emit_config_changed(&app);
  events::emit_changed(&app, Vec::new());
  media_config_get(app, webview, None)
}

#[tauri::command]
pub fn media_open(
  app: AppHandle,
  webview: WebviewWindow,
  token: Option<String>,
  scene_id: String,
) -> Result<MediaOpenResult, String> {
  authorize(webview.label(), token.as_deref())?;
  let display = current_display()?;
  let asset_id = display
    .media
    .asset_id
    .clone()
    .ok_or_else(|| "尚未选择视频素材".to_string())?;
  let asset = assets::find(&app, &asset_id).ok_or_else(|| "视频素材不存在".to_string())?;
  if !std::path::Path::new(&asset.path).is_file() {
    return Err("视频文件不存在或已被移动".to_string());
  }
  assets::allow_asset(&app, &asset.path);
  let asset_url = assets::asset_url(&webview, &asset.path)?;
  let label = webview.label().to_string();
  let device = lifecycle::device_for_label(&label);
  let share = share_global(&display);
  let result = engine().open(
    &scene_id,
    &asset_id,
    &asset.name,
    &asset_url,
    std::path::Path::new(&asset.path),
    &display.media,
    device.as_deref(),
    share,
  );
  events::emit_changed(&app, vec![result.session_id.clone()]);
  Ok(result)
}

#[cfg(feature = "native-media")]
fn create_native_surface(
  window: &WebviewWindow,
  stream_id: &str,
  origin: &str,
) -> Result<(Arc<NativeContext>, Arc<NativeStream>), String> {
  let (tx, rx) = std::sync::mpsc::channel();
  let id = stream_id.to_string();
  let origin = origin.to_string();
  window
    .with_webview(move |webview| {
      let environment = webview.environment();
      let environment_raw = environment.as_raw();
      let result = native_bridge::probe(environment_raw).and_then(|capabilities| {
        if !capabilities.native_texture_stream {
          return Err(
            capabilities
              .reason
              .unwrap_or_else(|| "WebView2 TextureStream 不可用".to_string()),
          );
        }
        let luid = capabilities
          .adapter_luid
          .ok_or_else(|| "WebView2 未报告渲染适配器 LUID".to_string())?;
        let context = NativeContext::for_luid(luid)?;
        let handle =
          native_bridge::create_stream(environment_raw, context.device_ptr(), &id, &origin)?;
        Ok((context, Arc::new(NativeStream::new(handle, id.clone()))))
      });
      let _ = tx.send(result);
    })
    .map_err(|error| format!("with_webview 失败: {error}"))?;
  rx.recv_timeout(Duration::from_secs(20))
    .map_err(|error| format!("等待 WebView2 environment 超时: {error}"))?
}

#[cfg(feature = "native-media")]
fn attach_native(
  webview: &WebviewWindow,
  session_id: &str,
  label: &str,
  device: Option<&str>,
  origin: &str,
) -> Result<MediaAttachResult, String> {
  let generation = STREAM_GENERATION.fetch_add(1, Ordering::Relaxed);
  let stream_id = format!("lull-{session_id}-{label}-{generation}");
  let (context, stream) = create_native_surface(webview, &stream_id, origin)?;
  engine().attach_native(session_id, label, device, stream, context)
}

#[tauri::command]
pub fn media_attach(
  app: AppHandle,
  webview: WebviewWindow,
  token: Option<String>,
  session_id: String,
  origin: String,
) -> Result<MediaAttachResult, String> {
  authorize(webview.label(), token.as_deref())?;
  validate_origin(&origin)?;
  let label = webview.label().to_string();
  let device = lifecycle::device_for_label(&label);
  #[cfg(feature = "native-media")]
  let result = if engine().capabilities().native_texture_stream {
    match attach_native(&webview, &session_id, &label, device.as_deref(), &origin) {
      Ok(result) => {
        crate::wallpaper::wlog(&format!(
          "media: native attach {label} session={session_id} stream={:?}",
          result.stream_id
        ));
        result
      }
      Err(reason) => {
        crate::wallpaper::wlog(&format!(
          "media: native attach {label} session={session_id} failed: {reason}; HTML fallback"
        ));
        let mut fallback = engine().attach(&session_id, &label, device.as_deref())?;
        fallback.reason = Some(reason);
        fallback
      }
    }
  } else {
    engine().attach(&session_id, &label, device.as_deref())?
  };
  #[cfg(not(feature = "native-media"))]
  let result = engine().attach(&session_id, &label, device.as_deref())?;
  events::emit_changed(&app, vec![session_id]);
  Ok(result)
}

#[tauri::command]
pub fn media_detach(
  app: AppHandle,
  webview: WebviewWindow,
  token: Option<String>,
  session_id: String,
) -> Result<(), String> {
  authorize(webview.label(), token.as_deref())?;
  engine().detach(webview.label());
  events::emit_changed(&app, vec![session_id]);
  Ok(())
}

#[tauri::command]
pub fn media_degrade(
  app: AppHandle,
  webview: WebviewWindow,
  token: Option<String>,
  session_id: String,
  reason: String,
) -> Result<MediaAttachResult, String> {
  authorize(webview.label(), token.as_deref())?;
  let result = engine().degrade(&session_id, &reason)?;
  events::emit_degraded(&app, &session_id, &result.asset_url, &reason);
  events::emit_changed(&app, vec![session_id]);
  Ok(result)
}

#[tauri::command]
pub fn media_play(
  app: AppHandle,
  webview: WebviewWindow,
  session_id: String,
) -> Result<(), String> {
  ensure_settings(webview.label())?;
  engine().set_paused(&session_id, false)?;
  events::emit_changed(&app, vec![session_id]);
  Ok(())
}

#[tauri::command]
pub fn media_pause(
  app: AppHandle,
  webview: WebviewWindow,
  session_id: String,
) -> Result<(), String> {
  ensure_settings(webview.label())?;
  engine().set_paused(&session_id, true)?;
  events::emit_changed(&app, vec![session_id]);
  Ok(())
}

#[tauri::command]
pub fn media_seek(
  app: AppHandle,
  webview: WebviewWindow,
  session_id: String,
  position_ms: u64,
) -> Result<(), String> {
  ensure_settings(webview.label())?;
  engine().seek(&session_id, position_ms)?;
  events::emit_changed(&app, vec![session_id]);
  Ok(())
}

#[tauri::command]
pub fn media_set_loop(
  app: AppHandle,
  webview: WebviewWindow,
  session_id: String,
  enabled: bool,
) -> Result<(), String> {
  ensure_settings(webview.label())?;
  engine().set_loop(&session_id, enabled)?;
  events::emit_changed(&app, vec![session_id]);
  Ok(())
}

#[tauri::command]
pub fn media_status(webview: WebviewWindow) -> Result<Vec<MediaSessionView>, String> {
  ensure_settings(webview.label())?;
  Ok(engine().status())
}

#[tauri::command]
pub fn media_stats(webview: WebviewWindow) -> Result<MediaStats, String> {
  ensure_settings(webview.label())?;
  Ok(engine().stats())
}
