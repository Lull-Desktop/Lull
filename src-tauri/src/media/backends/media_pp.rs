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
use super::super::native_bridge::NativeStream;

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
  start: Instant,
  last_timestamp: AtomicU64,
  presented: AtomicU64,
  dropped: AtomicU64,
}

impl WebViewStreamRenderer {
  fn new(gpu: D3d11Gpu, stream: Arc<NativeStream>) -> Self {
    Self {
      gpu,
      stream,
      start: Instant::now(),
      last_timestamp: AtomicU64::new(0),
      presented: AtomicU64::new(0),
      dropped: AtomicU64::new(0),
    }
  }

  fn next_timestamp(&self) -> u64 {
    let elapsed = u64::try_from(self.start.elapsed().as_micros()).unwrap_or(u64::MAX);
    let last = self.last_timestamp.load(Ordering::Relaxed);
    let next = elapsed.max(last.saturating_add(1));
    self.last_timestamp.store(next, Ordering::Relaxed);
    next
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
    let timestamp = self.next_timestamp();
    let rc = self
      .stream
      .submit_nv12(texture.as_raw(), array_index, width, height, timestamp);
    match rc {
      0 => {
        let presented = self.presented.fetch_add(1, Ordering::Relaxed);
        if presented == 0 {
          crate::wallpaper::wlog(&format!(
            "media: native first frame stream={} {}x{} ts={timestamp}",
            self.stream.id(),
            width,
            height
          ));
        }
        Ok(())
      }
      1 => {
        self.dropped.fetch_add(1, Ordering::Relaxed);
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
  decode_path: String,
  demux: FileDemuxerHandle,
  luid: u64,
}

impl NativeSession {
  pub(crate) fn new(
    path: &Path,
    config: &MediaConfig,
    context: Arc<NativeContext>,
    first_stream: Arc<NativeStream>,
    first_label: &str,
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

        let renderer =
          D3d11Renderer::new("display", Box::new(WebViewStreamRenderer::new(gpu, stream)));
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
    Ok(Self {
      pipeline,
      tee,
      branches: Mutex::new(branches),
      decode_path,
      demux,
      luid: context.luid(),
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
    let renderer = D3d11Renderer::new("display", Box::new(WebViewStreamRenderer::new(gpu, stream)));
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
    self.pipeline.resume();
    Ok(())
  }

  pub(crate) fn remove_surface(&self, label: &str) {
    let Ok(mut branches) = self.branches.lock() else {
      return;
    };
    let Some(branch_id) = branches.remove(label) else {
      return;
    };
    if let Err(error) = self.tee.detach(branch_id) {
      eprintln!("[media] detach {label} failed: {error}");
    }
    if branches.is_empty() {
      self.pipeline.pause();
    }
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
