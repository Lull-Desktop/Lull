//! media-pp native backend: one decoder per session, one Tee branch per display.
//!
//! The first surface builds the pipeline; later surfaces attach a runtime branch.
//! Every branch ends in `D3d11Renderer` and a `D3d11FrameRenderer` that copies the
//! decoded NV12 texture through the C++ WebView2 TextureStream bridge.

#![allow(unsafe_code)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use media_pp::elements::{
  D3d11FrameRenderer, D3d11Gpu, D3d11Renderer, DecodeTarget, FileDemuxer, FileDemuxerHandle, Pacer,
  TeeHandle, VideoDecodeBin,
};
use media_pp::ffmpeg;
use media_pp::pipeline::{Pipeline, SeekMode};
use media_pp::queue::OverflowPolicy;
use windows::core::Interface;
use windows::Win32::Foundation::HINSTANCE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
  D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
  D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1};

use super::super::config::MediaConfig;
use super::super::native_bridge::{
  NativeStream, STREAM_STATE_ADAPTER_LOST, STREAM_STATE_ERROR, STREAM_STATE_STOPPED,
};

/// 同一个流连续这么久没有可用目标纹理，说明渲染侧根本没有在消费帧
/// （窗口隐藏/被遮挡、合成器停摆），继续复制只是往显存里堆 4K 纹理。
const NO_TEXTURE_STALL_MS: u64 = 3_000;
/// 同一个 surface 的“流已死”报告间隔，避免解码线程每帧都发事件。
const STALL_REPORT_COOLDOWN_MS: u64 = 5_000;

/// One D3D11 device per WebView2 render adapter LUID. media-pp says one
/// `D3d11Gpu` per pipeline (or per process); cloning shares the device/lock.
pub(crate) struct NativeContext {
  gpu: D3d11Gpu,
  luid: u64,
}

static CONTEXTS: OnceLock<Mutex<HashMap<u64, Arc<NativeContext>>>> = OnceLock::new();

fn contexts() -> &'static Mutex<HashMap<u64, Arc<NativeContext>>> {
  CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn luid_u64(high: i32, low: u32) -> u64 {
  (u64::from(u32::from_ne_bytes(high.to_ne_bytes())) << 32) | u64::from(low)
}

fn create_gpu_for_luid(luid: u64) -> Result<D3d11Gpu, String> {
  let factory: IDXGIFactory1 =
    unsafe { CreateDXGIFactory1() }.map_err(|error| format!("DXGI factory: {error}"))?;
  let mut index = 0u32;
  loop {
    let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
      break;
    };
    let desc =
      unsafe { adapter.GetDesc1() }.map_err(|error| format!("DXGI adapter desc: {error}"))?;
    if luid_u64(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart) == luid {
      let adapter: IDXGIAdapter = adapter
        .cast()
        .map_err(|error| format!("DXGI adapter cast: {error}"))?;
      let mut device: Option<ID3D11Device> = None;
      unsafe {
        D3D11CreateDevice(
          Some(&adapter),
          D3D_DRIVER_TYPE_UNKNOWN,
          HINSTANCE::default().into(),
          D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
          None,
          D3D11_SDK_VERSION,
          Some(&mut device),
          None,
          None,
        )
      }
      .map_err(|error| format!("D3D11CreateDevice: {error}"))?;
      let device = device.ok_or_else(|| "D3D11CreateDevice returned no device".to_string())?;
      return D3d11Gpu::from_device(device)
        .map_err(|error| format!("D3d11Gpu::from_device: {error}"));
    }
    index = index.saturating_add(1);
  }
  Err(format!("找不到 WebView2 渲染适配器 LUID 0x{luid:016x}"))
}

impl NativeContext {
  pub(crate) fn for_luid(luid: u64) -> Result<Arc<Self>, String> {
    let mut cache = contexts().lock().map_err(|error| error.to_string())?;
    if let Some(context) = cache.get(&luid) {
      return Ok(Arc::clone(context));
    }
    let context = Arc::new(Self {
      gpu: create_gpu_for_luid(luid)?,
      luid,
    });
    cache.insert(luid, Arc::clone(&context));
    Ok(context)
  }

  pub(crate) fn luid(&self) -> u64 {
    self.luid
  }

  pub(crate) fn gpu(&self) -> D3d11Gpu {
    self.gpu.clone()
  }

  pub(crate) fn device_ptr(&self) -> *mut std::ffi::c_void {
    self.gpu.device().as_raw()
  }
}

struct WebViewStreamRenderer {
  gpu: D3d11Gpu,
  stream: Arc<NativeStream>,
  session_id: String,
  label: String,
  start: Instant,
  last_timestamp: AtomicU64,
  presented: AtomicU64,
  dropped: AtomicU64,
  /// 上一次真正呈现的帧（相对 `start` 的毫秒）；0 表示还没有首帧。
  last_present_ms: AtomicU64,
  /// 上一次提交（呈现或丢弃）的时间点，用来识别暂停造成的空档。
  last_submit_ms: AtomicU64,
  /// 开始拿不到目标纹理的时间点；有帧呈现时清零。
  no_texture_since_ms: AtomicU64,
  /// 上一次上报“流已死”的时间点。
  last_stall_report_ms: AtomicU64,
}

impl WebViewStreamRenderer {
  fn new(
    gpu: D3d11Gpu,
    stream: Arc<NativeStream>,
    session_id: String,
    label: String,
  ) -> Self {
    Self {
      gpu,
      stream,
      session_id,
      label,
      start: Instant::now(),
      last_timestamp: AtomicU64::new(0),
      presented: AtomicU64::new(0),
      dropped: AtomicU64::new(0),
      last_present_ms: AtomicU64::new(0),
      last_submit_ms: AtomicU64::new(0),
      no_texture_since_ms: AtomicU64::new(0),
      last_stall_report_ms: AtomicU64::new(0),
    }
  }

  fn next_timestamp(&self) -> u64 {
    let elapsed = u64::try_from(self.start.elapsed().as_micros()).unwrap_or(u64::MAX);
    let last = self.last_timestamp.load(Ordering::Relaxed);
    let next = elapsed.max(last.saturating_add(1));
    self.last_timestamp.store(next, Ordering::Relaxed);
    next
  }

  fn now_ms(&self) -> u64 {
    u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
  }

  /// 流离开 `Started` 后不会再自己回来：之后每一帧都是“dropped”，必须让页面
  /// 重新取流。这里只报告一次，重建流程失败时由前端计数决定是否降级。
  fn check_dead_stream(&self) {
    if self.presented.load(Ordering::Relaxed) == 0 {
      return;
    }
    let Some(state) = self.stream.state() else {
      return;
    };
    let reason = match state {
      STREAM_STATE_STOPPED => "stopped",
      STREAM_STATE_ERROR => "error",
      STREAM_STATE_ADAPTER_LOST => "adapter-lost",
      _ => return,
    };
    self.report_stall(reason, state);
  }

  /// 有帧在提交、但渲染侧持续不归还目标纹理：画面不会前进，且继续
  /// `CreateTexture` 会把 4K NV12 纹理堆到显存耗尽。
  ///
  /// `previous_submit_ms` 用来识别暂停：管线停了一段时间后第一帧再拿不到纹理，
  /// 不能把暂停的时长算进“渲染侧不消费”的窗口。
  fn check_starved(&self, previous_submit_ms: u64) {
    if self.last_present_ms.load(Ordering::Relaxed) == 0 {
      return;
    }
    let now = self.now_ms();
    let since = self.no_texture_since_ms.load(Ordering::Relaxed);
    if since == 0 || now.saturating_sub(previous_submit_ms) > 1_000 {
      self.no_texture_since_ms.store(now, Ordering::Relaxed);
      return;
    }
    if now.saturating_sub(since) < NO_TEXTURE_STALL_MS {
      return;
    }
    // 重新计时：即使事件丢了，下一轮还会再报告。
    self.no_texture_since_ms.store(now, Ordering::Relaxed);
    let state = self.stream.state().unwrap_or(-1);
    self.report_stall("not-compositing", state);
  }

  fn report_stall(&self, reason: &str, state: i32) {
    let now = self.now_ms();
    let last = self.last_stall_report_ms.load(Ordering::Relaxed);
    if now.saturating_sub(last) < STALL_REPORT_COOLDOWN_MS {
      return;
    }
    self.last_stall_report_ms.store(now, Ordering::Relaxed);
    if let Some(stats) = self.stream.stats() {
      crate::wallpaper::wlog(&format!(
        "media: native stream stats stream={} abi={} state={} textures={} created={} \
         transient={} err_kind={} last_present_tick={} since_last_present={}ms",
        self.stream.id(),
        stats.abi_version,
        stats.state,
        stats.texture_count,
        stats.created_textures,
        stats.transient_errors,
        stats.last_error_kind,
        stats.last_present_tick_ms,
        stats.since_last_present_ms
      ));
    }
    crate::media::report_stream_stalled(
      &self.session_id,
      &self.label,
      self.stream.id(),
      reason,
      state,
      self.presented.load(Ordering::Relaxed),
      self.dropped.load(Ordering::Relaxed),
    );
  }
}

impl D3d11FrameRenderer for WebViewStreamRenderer {
  fn device(&self) -> windows::Win32::Graphics::Direct3D11::ID3D11Device {
    self.gpu.device().clone()
  }

  unsafe fn submit_bgra_texture(
    &self,
    _texture: ID3D11Texture2D,
    _array_index: u32,
    _width: u32,
    _height: u32,
  ) -> Result<(), media_pp::elements::SubmitError> {
    // Native sessions are built only for NV12 output.
    Err(media_pp::elements::SubmitError::InvalidFrame)
  }

  unsafe fn submit_nv12_texture(
    &self,
    texture: ID3D11Texture2D,
    array_index: u32,
    width: u32,
    height: u32,
    _color: media_pp::color::ColorDescription,
  ) -> Result<(), media_pp::elements::SubmitError> {
    let now = self.now_ms();
    let previous_submit = self.last_submit_ms.swap(now, Ordering::Relaxed);
    let timestamp = self.next_timestamp();
    let rc = self
      .stream
      .submit_nv12(texture.as_raw(), array_index, width, height, timestamp);
    match rc {
      0 => {
        let presented = self.presented.fetch_add(1, Ordering::Relaxed);
        let previous = self.last_present_ms.swap(now, Ordering::Relaxed);
        self.no_texture_since_ms.store(0, Ordering::Relaxed);
        if presented == 0 {
          crate::wallpaper::wlog(&format!(
            "media: native first frame stream={} {}x{} ts={timestamp}",
            self.stream.id(),
            width,
            height
          ));
        } else if previous > 0 && now.saturating_sub(previous) > 1_000 {
          crate::wallpaper::wlog(&format!(
            "media: native stream resumed stream={} gap={}ms",
            self.stream.id(),
            now.saturating_sub(previous)
          ));
        }
        Ok(())
      }
      1 => {
        // 流还停在 Created（JS 尚未取流）或已经 Stopped/Error：两种都是
        // “这一帧不会被呈现”，但只有后者不可自愈，需要通知页面重建。
        self.dropped.fetch_add(1, Ordering::Relaxed);
        self.check_dead_stream();
        Ok(())
      }
      2 => {
        // 没有可写目标纹理 / keyed mutex 忙：渲染侧没有在消费。
        self.dropped.fetch_add(1, Ordering::Relaxed);
        self.check_starved(previous_submit);
        Ok(())
      }
      _ => {
        let _ = self.stream.last_error();
        Err(media_pp::elements::SubmitError::RenderFailed)
      }
    }
  }

  fn resize(&self, _width: u32, _height: u32) -> Result<(), media_pp::elements::SubmitError> {
    Ok(())
  }
}

/// A running media-pp pipeline. Built lazily on the first surface.
pub(crate) struct NativeSession {
  pipeline: Arc<Pipeline>,
  tee: TeeHandle,
  branches: Mutex<HashMap<String, media_pp::graph::BranchId>>,
  /// label → 该窗口的 TextureStream；只用于读诊断计数。
  streams: Mutex<HashMap<String, Arc<NativeStream>>>,
  decode_path: String,
  demux: FileDemuxerHandle,
  luid: u64,
  session_id: String,
}

impl NativeSession {
  pub(crate) fn new(
    path: &Path,
    config: &MediaConfig,
    context: Arc<NativeContext>,
    first_stream: Arc<NativeStream>,
    first_label: &str,
    session_id: &str,
  ) -> Result<Self, String> {
    let (source, _streams) =
      FileDemuxer::open("lull-demux", path).map_err(|error| format!("打开视频失败: {error}"))?;
    let video = source
      .best(ffmpeg::media::Type::Video)
      .map_err(|error| format!("没有视频轨: {error}"))?;
    let demux = source.looping_handle();
    demux.set_looping(config.loop_playback);

    let decoder = VideoDecodeBin::open(
      "lull-decode",
      video.parameters.clone(),
      DecodeTarget::D3d11 {
        gpu: context.gpu(),
        downstream_hw_frames: 16,
      },
      None,
    )
    .map_err(|error| format!("创建解码器失败: {error}"))?;
    if decoder.output_format() != Some(ffmpeg::format::Pixel::NV12) {
      return Err(format!(
        "原生路径只支持 NV12，解码输出为 {:?}",
        decoder.output_format()
      ));
    }
    let decoder_handle = decoder.handle();
    let video_index = video.index;
    let gpu = context.gpu();
    let label = first_label.to_string();
    let stream = Arc::clone(&first_stream);
    let session_id = session_id.to_string();
    let pipeline_session = session_id.clone();

    let (pipeline, (tee, first_branch, decode_path)) =
      Pipeline::new("lull-media", source, move |source, ctx| {
        let (tee_branch, tee) = ctx.tee("tee").build_dynamic()?;
        let branch = ctx
          .branch()
          .pipe(decoder)
          .queue("decode", 8)
          .pipe(Pacer::new("pacer"))
          .to_branch(tee_branch)?;
        ctx.attach(source, video_index, branch)?;

        let renderer = D3d11Renderer::new(
          "display",
          Box::new(WebViewStreamRenderer::new(
            gpu,
            stream,
            pipeline_session,
            label.clone(),
          )),
        );
        let branch = tee
          .branch()?
          .queue_with_policy(format!("display-{label}"), 2, OverflowPolicy::DropNewest)
          .to(renderer)?;
        let first_branch_id = tee.attach(branch)?;
        let path = format!("{:?}", decoder_handle.path());
        Ok((tee, first_branch_id, path))
      })
      .map_err(|error| format!("构建媒体管线失败: {error}"))?;
    pipeline
      .run()
      .map_err(|error| format!("启动媒体管线失败: {error}"))?;

    let mut branches = HashMap::new();
    branches.insert(first_label.to_string(), first_branch);
    let mut streams = HashMap::new();
    streams.insert(first_label.to_string(), Arc::clone(&first_stream));
    Ok(Self {
      pipeline,
      tee,
      branches: Mutex::new(branches),
      streams: Mutex::new(streams),
      decode_path,
      demux,
      luid: context.luid(),
      session_id,
    })
  }

  pub(crate) fn luid(&self) -> u64 {
    self.luid
  }

  pub(crate) fn add_surface(
    &self,
    label: &str,
    stream: Arc<NativeStream>,
    gpu: D3d11Gpu,
  ) -> Result<(), String> {
    // 同一窗口重挂：旧流最后一次出帧距今多久，决定这次重挂是不是必要的。
    self.log_surface_stats(label, "re-attach");
    let renderer = D3d11Renderer::new(
      "display",
      Box::new(WebViewStreamRenderer::new(
        gpu,
        Arc::clone(&stream),
        self.session_id.clone(),
        label.to_string(),
      )),
    );
    let branch = self
      .tee
      .branch()
      .map_err(|error| format!("创建显示分支失败: {error}"))?
      .queue_with_policy(format!("display-{label}"), 2, OverflowPolicy::DropNewest)
      .to(renderer)
      .map_err(|error| format!("连接显示分支失败: {error}"))?;
    let branch_id = self
      .tee
      .attach(branch)
      .map_err(|error| format!("挂载显示分支失败: {error}"))?;
    {
      let mut branches = self.branches.lock().map_err(|error| error.to_string())?;
      // 同一窗口可能因为 StrictMode/页面重载再次 attach；先摘掉旧分支，
      // 否则旧 renderer 会继续向已销毁的 TextureStream 提交帧。
      if let Some(previous) = branches.remove(label) {
        if let Err(error) = self.tee.detach(previous) {
          crate::wallpaper::wlog(&format!(
            "media: detach previous branch {label} failed: {error}"
          ));
        }
      }
      branches.insert(label.to_string(), branch_id);
    }
    if let Ok(mut streams) = self.streams.lock() {
      streams.insert(label.to_string(), stream);
    }
    self.pipeline.resume();
    Ok(())
  }

  pub(crate) fn remove_surface(&self, label: &str) {
    // 关一屏前先记下这一路“距上次出帧多久”：>1s 说明画面本来就停了（看门狗重挂
    // 合理），接近 0 说明帧一直在走、黑屏是重建本身造成的。
    self.log_surface_stats(label, "detach");
    if let Ok(mut streams) = self.streams.lock() {
      streams.remove(label);
    }
    let Ok(mut branches) = self.branches.lock() else {
      return;
    };
    let Some(branch_id) = branches.remove(label) else {
      return;
    };
    let started = Instant::now();
    if let Err(error) = self.tee.detach(branch_id) {
      eprintln!("[media] detach {label} failed: {error}");
    }
    let detach = started.elapsed();
    let left = branches.len();
    if left == 0 {
      self.pipeline.pause();
    }
    if detach.as_millis() > 50 {
      crate::wallpaper::wlog(&format!(
        "media: detach branch {label} 用时 {detach:?}（剩余分支 {left}）"
      ));
    }
  }

  /// 该窗口 TextureStream 的计数器；没有原生 surface 时为 `None`。
  #[must_use]
  pub(crate) fn surface_stats(
    &self,
    label: &str,
  ) -> Option<super::super::native_bridge::StreamStats> {
    let stream = self.streams.lock().ok()?.get(label).cloned()?;
    stream.stats()
  }

  /// 把某个 surface 的计数器写进日志；没有原生流时静默。
  fn log_surface_stats(&self, label: &str, why: &str) {
    let Some(stats) = self.surface_stats(label) else {
      return;
    };
    crate::wallpaper::wlog(&format!(
      "media: {why} {label} state={} presented={} dropped={} since_last_present={}ms",
      stats.state,
      stats.presented,
      stats
        .dropped_not_started
        .saturating_add(stats.dropped_no_texture),
      stats.since_last_present_ms
    ));
  }

  pub(crate) fn pause(&self) {
    self.pipeline.pause();
  }

  pub(crate) fn resume(&self) {
    self.pipeline.resume();
  }

  pub(crate) fn seek(&self, position_ms: u64) -> Result<(), String> {
    self
      .pipeline
      .seek(Duration::from_millis(position_ms), SeekMode::Accurate)
      .map_err(|error| format!("Seek 失败: {error}"))
  }

  pub(crate) fn set_loop(&self, enabled: bool) {
    self.demux.set_looping(enabled);
  }

  pub(crate) fn stop(&self) {
    self.pipeline.stop();
  }

  #[must_use]
  pub(crate) fn position_ms(&self) -> u64 {
    self.pipeline.position().map_or(0, |position| {
      u64::try_from(position.as_millis()).unwrap_or(u64::MAX)
    })
  }

  #[must_use]
  pub(crate) fn decode_path(&self) -> &str {
    &self.decode_path
  }
}

impl Drop for NativeSession {
  fn drop(&mut self) {
    self.pipeline.stop();
  }
}
