//! 媒体会话注册表与状态机。
//!
//! 本模块只维护“会话/呈现面”的业务状态；真正的解码管线在
//! `backends/media_pp.rs`（后续接入）。当前后端能力探测失败时，会话仍以
//! `HtmlVideo` 建立，用于统一前端 API、素材 URL、诊断与生命周期。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use sha2::{Digest, Sha256};

#[cfg(feature = "native-media")]
use super::backends::media_pp::{NativeContext, NativeSession};
use super::config::MediaConfig;
use super::diagnostics::{
  MediaAttachResult, MediaBackend, MediaCapabilities, MediaOpenResult, MediaSessionState,
  MediaSessionView, MediaStats, MediaSurfaceView,
};
#[cfg(feature = "native-media")]
use super::native_bridge::{self, NativeStream};

#[cfg(not(feature = "native-media"))]
struct NativeSession;
#[cfg(not(feature = "native-media"))]
#[allow(dead_code)]
struct NativeContext;

#[cfg(feature = "native-media")]
fn native_available() -> bool {
  native_bridge::api_available()
}

#[cfg(not(feature = "native-media"))]
const fn native_available() -> bool {
  false
}

fn session_position(session: &SessionRecord) -> u64 {
  #[cfg(feature = "native-media")]
  if let Some(native) = &session.native {
    return native.position_ms();
  }
  session.position_ms
}

struct SessionRecord {
  session_id: String,
  scene_id: String,
  asset_id: String,
  asset_name: String,
  asset_url: String,
  asset_path: PathBuf,
  config: MediaConfig,
  backend: MediaBackend,
  state: MediaSessionState,
  consumers: BTreeSet<String>,
  position_ms: u64,
  duration_ms: Option<u64>,
  last_error: Option<String>,
  decode_path: Option<String>,
  decoder_instances: u32,
  native: Option<Arc<NativeSession>>,
}

#[derive(Debug, Clone)]
struct SurfaceRecord {
  label: String,
  device: Option<String>,
  session_id: String,
  backend: MediaBackend,
  stream_id: Option<String>,
  started: bool,
  presented: u64,
  dropped: u64,
  last_media_pts_us: Option<i64>,
  last_presented_at_ms: Option<u64>,
  adapter_luid: Option<u64>,
  attached_at: Instant,
}

#[derive(Default)]
struct EngineState {
  sessions: BTreeMap<String, SessionRecord>,
  surfaces: BTreeMap<String, SurfaceRecord>,
  master_visible: bool,
}

pub struct MediaEngine {
  state: Mutex<EngineState>,
  capabilities: MediaCapabilities,
}

static ENGINE: OnceLock<MediaEngine> = OnceLock::new();

/// 进程级媒体引擎。未显式 `init` 时首次访问自动初始化。
pub(crate) fn engine() -> &'static MediaEngine {
  ENGINE.get_or_init(|| {
    let native = native_available();
    MediaEngine {
      state: Mutex::new(EngineState {
        sessions: BTreeMap::new(),
        surfaces: BTreeMap::new(),
        master_visible: true,
      }),
      capabilities: MediaCapabilities {
        native_texture_stream: native,
        hardware_decode: native,
        reason: if native {
          None
        } else {
          Some("原生媒体桥未加载".to_string())
        },
        runtime_version: None,
        adapter_luid: None,
        html_fallback: true,
      },
    }
  })
}

impl MediaEngine {
  fn lock(&self) -> MutexGuard<'_, EngineState> {
    self
      .state
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  #[must_use]
  pub fn capabilities(&self) -> MediaCapabilities {
    self.capabilities.clone()
  }

  /// Open or reuse a session. `share_global=false` buckets by display.
  #[allow(clippy::too_many_arguments)]
  pub fn open(
    &self,
    scene_id: &str,
    asset_id: &str,
    asset_name: &str,
    asset_url: &str,
    asset_path: &Path,
    config: &MediaConfig,
    device: Option<&str>,
    share_global: bool,
  ) -> MediaOpenResult {
    let config = config.clone().normalized();
    let key = session_key(scene_id, asset_id, &config, device, share_global);
    let session_id = session_id_for_key(&key);
    let mut state = self.lock();
    if let Some(existing) = state.sessions.get_mut(&session_id) {
      existing.asset_url = asset_url.to_string();
      existing.asset_path = asset_path.to_path_buf();
      existing.config = config;
      existing.asset_name = asset_name.to_string();
      return MediaOpenResult {
        session_id,
        backend: existing.backend,
        asset_url: existing.asset_url.clone(),
        state: existing.state,
        reason: existing.last_error.clone(),
      };
    }
    let backend = if self.capabilities.native_texture_stream {
      MediaBackend::NativeTexture
    } else {
      MediaBackend::HtmlVideo
    };
    let session_state = if state.master_visible {
      MediaSessionState::Playing
    } else {
      MediaSessionState::Paused
    };
    let record = SessionRecord {
      session_id: session_id.clone(),
      scene_id: scene_id.to_string(),
      asset_id: asset_id.to_string(),
      asset_name: asset_name.to_string(),
      asset_url: asset_url.to_string(),
      asset_path: asset_path.to_path_buf(),
      config,
      backend,
      state: session_state,
      consumers: BTreeSet::new(),
      position_ms: 0,
      duration_ms: None,
      last_error: None,
      decode_path: None,
      decoder_instances: u32::from(backend == MediaBackend::NativeTexture),
      native: None,
    };
    let result = MediaOpenResult {
      session_id: session_id.clone(),
      backend,
      asset_url: record.asset_url.clone(),
      state: record.state,
      reason: record.last_error.clone(),
    };
    state.sessions.insert(session_id, record);
    result
  }

  pub fn attach(
    &self,
    session_id: &str,
    label: &str,
    device: Option<&str>,
  ) -> Result<MediaAttachResult, String> {
    let mut state = self.lock();
    let master_visible = state.master_visible;
    let session = state
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| "媒体会话不存在".to_string())?;
    // This is the HTML/fallback surface path. A session with no native pipeline
    // must report HTML; an existing native session may still serve other screens.
    let backend = MediaBackend::HtmlVideo;
    if session.native.is_none() {
      session.backend = MediaBackend::HtmlVideo;
      session.decoder_instances = 0;
      session.decode_path = None;
    }
    session.consumers.insert(label.to_string());
    if session.state == MediaSessionState::Paused && master_visible {
      session.state = MediaSessionState::Playing;
    }
    let result = MediaAttachResult {
      backend,
      stream_id: None,
      asset_url: session.asset_url.clone(),
      state: session.state,
      reason: session.last_error.clone(),
    };
    state.surfaces.insert(
      label.to_string(),
      SurfaceRecord {
        label: label.to_string(),
        device: device.map(str::to_string),
        session_id: session_id.to_string(),
        backend,
        stream_id: None,
        started: true,
        presented: 0,
        dropped: 0,
        last_media_pts_us: None,
        last_presented_at_ms: None,
        adapter_luid: None,
        attached_at: Instant::now(),
      },
    );
    Ok(result)
  }

  #[cfg(feature = "native-media")]
  pub fn attach_native(
    &self,
    session_id: &str,
    label: &str,
    device: Option<&str>,
    stream: Arc<NativeStream>,
    context: Arc<NativeContext>,
  ) -> Result<MediaAttachResult, String> {
    let stream_id = stream.id().to_string();
    let mut state = self.lock();
    let master_visible = state.master_visible;
    let (asset_url, session_state, reason) = {
      let session = state
        .sessions
        .get_mut(session_id)
        .ok_or_else(|| "媒体会话不存在".to_string())?;
      let gpu = context.gpu();
      if let Some(native) = &session.native {
        if native.luid() != context.luid() {
          return Err("显示器与已有媒体会话不在同一 GPU 适配器".to_string());
        }
        native.add_surface(label, Arc::clone(&stream), gpu)?;
      } else {
        let native = NativeSession::new(
          &session.asset_path,
          &session.config,
          context,
          Arc::clone(&stream),
          label,
          session_id,
        )?;
        session.decode_path = Some(native.decode_path().to_string());
        session.native = Some(Arc::new(native));
        session.decoder_instances = 1;
      }
      session.backend = MediaBackend::NativeTexture;
      session.state = if master_visible {
        MediaSessionState::Playing
      } else {
        MediaSessionState::Paused
      };
      session.consumers.insert(label.to_string());
      (
        session.asset_url.clone(),
        session.state,
        session.last_error.clone(),
      )
    };
    let result = MediaAttachResult {
      backend: MediaBackend::NativeTexture,
      stream_id: Some(stream_id.clone()),
      asset_url,
      state: session_state,
      reason,
    };
    state.surfaces.insert(
      label.to_string(),
      SurfaceRecord {
        label: label.to_string(),
        device: device.map(str::to_string),
        session_id: session_id.to_string(),
        backend: MediaBackend::NativeTexture,
        stream_id: Some(stream_id),
        started: true,
        presented: 0,
        dropped: 0,
        last_media_pts_us: None,
        last_presented_at_ms: None,
        adapter_luid: None,
        attached_at: Instant::now(),
      },
    );
    Ok(result)
  }

  /// 解绑一个 Surface。`expected_stream_id` 用于过滤 StrictMode/旧页面迟到的
  /// detach：只有当前 Surface 的 stream id 仍匹配时才移除，避免误删新 attach。
  pub fn detach(&self, label: &str, expected_stream_id: Option<&str>) {
    let mut state = self.lock();
    let matches = state.surfaces.get(label).is_some_and(|surface| {
      expected_stream_id.map_or(true, |expected| {
        surface.stream_id.as_deref() == Some(expected)
      })
    });
    if !matches {
      return;
    }
    let Some(surface) = state.surfaces.remove(label) else {
      return;
    };
    if let Some(session) = state.sessions.get_mut(&surface.session_id) {
      #[cfg(feature = "native-media")]
      if let Some(native) = &session.native {
        native.remove_surface(label);
      }
      session.consumers.remove(label);
      if session.consumers.is_empty() {
        session.state = MediaSessionState::Paused;
      }
    }
  }

  pub fn detach_all_surfaces(&self) {
    let mut state = self.lock();
    let labels: Vec<String> = state.surfaces.keys().cloned().collect();
    for label in labels {
      if let Some(surface) = state.surfaces.remove(&label) {
        if let Some(session) = state.sessions.get_mut(&surface.session_id) {
          #[cfg(feature = "native-media")]
          if let Some(native) = &session.native {
            native.remove_surface(&label);
          }
          session.consumers.remove(&label);
          if session.consumers.is_empty() {
            session.state = MediaSessionState::Paused;
          }
        }
      }
    }
  }

  pub fn stop_all(&self) {
    let mut state = self.lock();
    #[cfg(feature = "native-media")]
    for session in state.sessions.values() {
      if let Some(native) = &session.native {
        native.stop();
      }
    }
    state.sessions.clear();
    state.surfaces.clear();
  }

  /// 只保留仍有呈现面位于视频显示器上的会话。
  ///
  /// 用于场景切换：切到非视频场景的显示器会释放自己的会话；其它仍处于
  /// `lull.video` 的显示器（independent 模式）继续复用原解码器/纹理流。没有
  /// surface 的会话在这次配置变化中一并回收，避免留下后台解码线程。
  pub fn retain_video_devices(&self, video_devices: &BTreeSet<String>) {
    let mut state = self.lock();
    let active_sessions: BTreeSet<String> = state
      .surfaces
      .values()
      .filter(|surface| {
        surface
          .device
          .as_ref()
          .is_some_and(|device| video_devices.contains(device))
      })
      .map(|surface| surface.session_id.clone())
      .collect();
    // 关一屏后另一个窗口黑屏：先看这里到底把哪些 surface/device 算成了“不在视频屏”。
    crate::wallpaper::wlog(&format!(
      "media: retain devices={video_devices:?} surfaces={:?}",
      state
        .surfaces
        .values()
        .map(|surface| (
          surface.label.clone(),
          surface.device.clone(),
          surface.session_id.clone()
        ))
        .collect::<Vec<_>>()
    ));
    let stale_sessions: Vec<String> = state
      .sessions
      .keys()
      .filter(|session_id| !active_sessions.contains(*session_id))
      .cloned()
      .collect();
    for session_id in stale_sessions {
      if let Some(_session) = state.sessions.remove(&session_id) {
        #[cfg(feature = "native-media")]
        if let Some(native) = &_session.native {
          native.stop();
        }
      }
    }
    let live_sessions: BTreeSet<String> = state.sessions.keys().cloned().collect();
    state
      .surfaces
      .retain(|_, surface| live_sessions.contains(&surface.session_id));
  }

  pub fn set_master_visible(&self, visible: bool) {
    let mut state = self.lock();
    state.master_visible = visible;
    for session in state.sessions.values_mut() {
      if visible {
        if !session.consumers.is_empty() {
          #[cfg(feature = "native-media")]
          if let Some(native) = &session.native {
            native.resume();
          }
          session.state = MediaSessionState::Playing;
        }
      } else if session.state == MediaSessionState::Playing {
        #[cfg(feature = "native-media")]
        if let Some(native) = &session.native {
          native.pause();
        }
        session.state = MediaSessionState::Paused;
      }
    }
  }

  pub fn set_paused(&self, session_id: &str, paused: bool) -> Result<(), String> {
    let mut state = self.lock();
    let session = state
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| "媒体会话不存在".to_string())?;
    #[cfg(feature = "native-media")]
    if let Some(native) = &session.native {
      if paused {
        native.pause();
      } else {
        native.resume();
      }
    }
    session.state = if paused {
      MediaSessionState::Paused
    } else {
      MediaSessionState::Playing
    };
    Ok(())
  }

  pub fn seek(&self, session_id: &str, position_ms: u64) -> Result<(), String> {
    let mut state = self.lock();
    let session = state
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| "媒体会话不存在".to_string())?;
    #[cfg(feature = "native-media")]
    if let Some(native) = &session.native {
      native.seek(position_ms)?;
    }
    session.position_ms = position_ms;
    Ok(())
  }

  /// 把所有视频会话拉到同一个位置并恢复播放，返回被同步的会话数。
  ///
  /// 共享/独立 Session 都走这里：原生会话直接 seek 解码器；HTML 会话只更新
  /// Engine 里的位置，真正的 `<video>` seek 由 `media-resync` 事件在壁纸页完成。
  pub fn resync(&self, position_ms: u64) -> Result<usize, String> {
    let mut state = self.lock();
    let master_visible = state.master_visible;
    let mut synced = 0usize;
    for session in state.sessions.values_mut() {
      let was_paused = session.state == MediaSessionState::Paused;
      #[cfg(feature = "native-media")]
      if let Some(native) = &session.native {
        native.seek(position_ms)?;
        if master_visible && was_paused {
          native.resume();
        }
      }
      if master_visible && was_paused {
        session.state = MediaSessionState::Playing;
      }
      session.position_ms = position_ms;
      synced += 1;
    }
    Ok(synced)
  }

  pub fn set_loop(&self, session_id: &str, loop_playback: bool) -> Result<(), String> {
    let mut state = self.lock();
    let session = state
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| "媒体会话不存在".to_string())?;
    session.config.loop_playback = loop_playback;
    #[cfg(feature = "native-media")]
    if let Some(native) = &session.native {
      native.set_loop(loop_playback);
    }
    Ok(())
  }

  /// 原生路径失败时把整个会话切到 HTML；幂等。
  pub fn degrade(&self, session_id: &str, reason: &str) -> Result<MediaAttachResult, String> {
    let mut state = self.lock();
    let (asset_url, session_state) = {
      let session = state
        .sessions
        .get_mut(session_id)
        .ok_or_else(|| "媒体会话不存在".to_string())?;
      #[cfg(feature = "native-media")]
      if let Some(native) = session.native.take() {
        native.stop();
      }
      session.backend = MediaBackend::HtmlVideo;
      session.state = MediaSessionState::Degraded;
      session.last_error = Some(reason.to_string());
      session.decode_path = None;
      session.decoder_instances = 0;
      (session.asset_url.clone(), session.state)
    };
    for surface in state.surfaces.values_mut() {
      if surface.session_id == session_id {
        surface.backend = MediaBackend::HtmlVideo;
      }
    }
    Ok(MediaAttachResult {
      backend: MediaBackend::HtmlVideo,
      stream_id: None,
      asset_url,
      state: session_state,
      reason: Some(reason.to_string()),
    })
  }

  #[must_use]
  pub fn status(&self) -> Vec<MediaSessionView> {
    let state = self.lock();
    let mut views = Vec::with_capacity(state.sessions.len());
    for session in state.sessions.values() {
      let position_ms = session_position(session);
      let surfaces = state
        .surfaces
        .values()
        .filter(|surface| surface.session_id == session.session_id)
        .map(|surface| {
          // 原生 surface 的计数来自 C++ 桥；引擎自身不逐帧提交，不能凭空统计。
          #[cfg(feature = "native-media")]
          let (presented, dropped) = session
            .native
            .as_ref()
            .and_then(|native| native.surface_stats(&surface.label))
            .map_or((surface.presented, surface.dropped), |stats| {
              (
                stats.presented,
                stats
                  .dropped_not_started
                  .saturating_add(stats.dropped_no_texture),
              )
            });
          #[cfg(not(feature = "native-media"))]
          let (presented, dropped) = (surface.presented, surface.dropped);
          MediaSurfaceView {
            label: surface.label.clone(),
            device: surface.device.clone(),
            backend: surface.backend,
            started: surface.started,
            presented,
            dropped,
            last_media_pts_us: surface.last_media_pts_us,
            last_presented_at_ms: surface.last_presented_at_ms.or_else(|| {
              Some(u64::try_from(surface.attached_at.elapsed().as_millis()).unwrap_or(u64::MAX))
            }),
            adapter_luid: surface.adapter_luid,
          }
        })
        .collect();
      views.push(MediaSessionView {
        session_id: session.session_id.clone(),
        scene_id: session.scene_id.clone(),
        asset_id: session.asset_id.clone(),
        asset_name: Some(session.asset_name.clone()),
        backend: session.backend,
        state: session.state,
        loop_playback: session.config.loop_playback,
        muted: session.config.muted,
        rate: session.config.rate,
        preferred_fps: session.config.preferred_fps,
        hardware_decode: session.config.hardware_decode.clone(),
        share: session.config.share.clone(),
        decode_path: session.decode_path.clone(),
        decoder_instances: session.decoder_instances,
        position_ms,
        duration_ms: session.duration_ms,
        last_error: session.last_error.clone(),
        surfaces,
      });
    }
    views
  }

  #[must_use]
  pub fn stats(&self) -> MediaStats {
    let session_views = self.status();
    let native_sessions = session_views
      .iter()
      .filter(|view| view.backend == MediaBackend::NativeTexture)
      .count();
    let fallback_sessions = session_views
      .iter()
      .filter(|view| view.backend == MediaBackend::HtmlVideo)
      .count();
    let decoder_instances = session_views
      .iter()
      .map(|view| view.decoder_instances)
      .sum();
    MediaStats {
      sessions: session_views.len(),
      native_sessions,
      fallback_sessions,
      decoder_instances,
      cpu_readback_bytes: 0,
      capabilities: self.capabilities(),
      session_views,
    }
  }
}

/// 会话 key：只由资源、播放参数、场景与共享分组决定，不由显示器数量决定。
#[must_use]
pub fn session_key(
  scene_id: &str,
  asset_id: &str,
  config: &MediaConfig,
  device: Option<&str>,
  share_global: bool,
) -> String {
  let rate_bits = config.rate.to_bits();
  let group = if share_global {
    "global".to_string()
  } else {
    format!("display:{}", device.unwrap_or("unknown"))
  };
  format!(
    "{scene_id}\u{1f}{asset_id}\u{1f}{}\u{1f}{rate_bits:08x}\u{1f}{}\u{1f}{group}",
    u8::from(config.loop_playback),
    config.hardware_decode
  )
}

#[must_use]
pub fn session_id_for_key(key: &str) -> String {
  let digest = Sha256::digest(key.as_bytes());
  let hex = format!("{digest:x}");
  format!("media-{}", &hex[..12])
}

#[cfg(test)]
mod tests {
  use super::*;

  fn config() -> MediaConfig {
    MediaConfig::default()
  }

  #[test]
  fn same_resource_and_params_share_a_session() {
    let a = session_key(
      "lull.video",
      "m_1",
      &config(),
      Some("\\\\.\\DISPLAY1"),
      true,
    );
    let b = session_key(
      "lull.video",
      "m_1",
      &config(),
      Some("\\\\.\\DISPLAY2"),
      true,
    );
    assert_eq!(a, b);
    assert_eq!(session_id_for_key(&a), session_id_for_key(&b));
  }

  #[test]
  fn independent_sessions_are_per_display() {
    let a = session_key(
      "lull.video",
      "m_1",
      &config(),
      Some("\\\\.\\DISPLAY1"),
      false,
    );
    let b = session_key(
      "lull.video",
      "m_1",
      &config(),
      Some("\\\\.\\DISPLAY2"),
      false,
    );
    assert_ne!(a, b);
  }

  #[test]
  fn playback_params_change_the_session() {
    let base = session_key("lull.video", "m_1", &config(), None, true);
    let mut other = config();
    other.loop_playback = false;
    let changed = session_key("lull.video", "m_1", &other, None, true);
    assert_ne!(base, changed);
  }

  #[test]
  fn attach_detach_preserves_session() {
    let engine = MediaEngine {
      state: Mutex::new(EngineState {
        sessions: BTreeMap::new(),
        surfaces: BTreeMap::new(),
        master_visible: true,
      }),
      capabilities: MediaCapabilities::default(),
    };
    let opened = engine.open(
      "lull.video",
      "m_1",
      "a.mp4",
      "http://asset.localhost/a.mp4",
      std::path::Path::new("a.mp4"),
      &config(),
      Some("\\\\.\\DISPLAY1"),
      true,
    );
    engine
      .attach(&opened.session_id, "wallpaper-0", Some("\\\\.\\DISPLAY1"))
      .unwrap();
    engine.detach("wallpaper-0", None);
    assert_eq!(engine.status().len(), 1, "detach 不应销毁会话");
    assert_eq!(engine.status()[0].state, MediaSessionState::Paused);
  }

  #[test]
  fn resync_moves_all_sessions_to_one_position() {
    let engine = MediaEngine {
      state: Mutex::new(EngineState {
        sessions: BTreeMap::new(),
        surfaces: BTreeMap::new(),
        master_visible: true,
      }),
      capabilities: MediaCapabilities::default(),
    };
    for display in ["\\\\.\\DISPLAY1", "\\\\.\\DISPLAY2"] {
      let opened = engine.open(
        "lull.video",
        "m_1",
        "a.mp4",
        "http://asset.localhost/a.mp4",
        std::path::Path::new("a.mp4"),
        &config(),
        Some(display),
        false,
      );
      engine
        .attach(&opened.session_id, display, Some(display))
        .unwrap();
    }
    assert_eq!(engine.resync(1_234).unwrap(), 2);
    for view in engine.status() {
      assert_eq!(view.position_ms, 1_234);
    }
  }

  #[test]
  fn stale_detach_with_old_stream_id_keeps_current_surface() {
    let engine = MediaEngine {
      state: Mutex::new(EngineState {
        sessions: BTreeMap::new(),
        surfaces: BTreeMap::new(),
        master_visible: true,
      }),
      capabilities: MediaCapabilities::default(),
    };
    let opened = engine.open(
      "lull.video",
      "m_1",
      "a.mp4",
      "http://asset.localhost/a.mp4",
      std::path::Path::new("a.mp4"),
      &config(),
      Some("\\\\.\\DISPLAY1"),
      true,
    );
    engine
      .attach(&opened.session_id, "wallpaper-0", Some("\\\\.\\DISPLAY1"))
      .unwrap();
    // StrictMode 旧 cleanup 携带旧 stream id：不匹配当前 Surface 时必须忽略。
    engine.detach("wallpaper-0", Some("lull-old-stream"));
    assert_eq!(engine.status()[0].surfaces.len(), 1);
    engine.detach("wallpaper-0", None);
    assert!(engine.status()[0].surfaces.is_empty());
  }

  #[test]
  fn retain_video_devices_releases_only_switched_displays() {
    let engine = MediaEngine {
      state: Mutex::new(EngineState {
        sessions: BTreeMap::new(),
        surfaces: BTreeMap::new(),
        master_visible: true,
      }),
      capabilities: MediaCapabilities::default(),
    };
    let one = engine.open(
      "lull.video",
      "m_1",
      "a.mp4",
      "http://asset.localhost/a.mp4",
      std::path::Path::new("a.mp4"),
      &config(),
      Some("\\\\.\\DISPLAY1"),
      false,
    );
    let two = engine.open(
      "lull.video",
      "m_1",
      "a.mp4",
      "http://asset.localhost/a.mp4",
      std::path::Path::new("a.mp4"),
      &config(),
      Some("\\\\.\\DISPLAY2"),
      false,
    );
    engine
      .attach(&one.session_id, "wallpaper-0", Some("\\\\.\\DISPLAY1"))
      .unwrap();
    engine
      .attach(&two.session_id, "wallpaper-1", Some("\\\\.\\DISPLAY2"))
      .unwrap();

    let mut only_first = BTreeSet::new();
    only_first.insert("\\\\.\\DISPLAY1".to_string());
    engine.retain_video_devices(&only_first);
    let views = engine.status();
    assert_eq!(views.len(), 1, "切走的显示器应释放会话");
    assert_eq!(views[0].session_id, one.session_id);
    assert_eq!(views[0].surfaces.len(), 1);

    engine.retain_video_devices(&BTreeSet::new());
    assert!(engine.status().is_empty(), "没有视频显示器时不得留会话");
  }
}
