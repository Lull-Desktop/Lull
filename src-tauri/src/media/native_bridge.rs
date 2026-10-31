//! C ABI loader for the optional native media bridge in `lull_native.dll`.
//!
//! The exports are optional: an older DLL simply has no `lull_media_*` symbols,
//! in which case the engine stays on the HTML fallback. No COM pointer is kept
//! here; environment/device pointers are borrowed for one call and the stream is
//! an opaque u64 owned by the C++ registry.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::OnceLock;

use super::diagnostics::MediaCapabilities;

type ProbeFn = unsafe extern "C" fn(*mut c_void, *mut ProbeResult) -> i32;
type CreateFn =
  unsafe extern "C" fn(*mut c_void, *mut c_void, *const u16, *const u16, *mut i32) -> u64;
type TakeErrorFn = unsafe extern "C" fn(u64, *mut i32) -> i32;
type StateFn = unsafe extern "C" fn(u64) -> i32;
type StatsFn = unsafe extern "C" fn(u64, *mut StreamStats) -> i32;
type SubmitNv12Fn = unsafe extern "C" fn(u64, *mut c_void, u32, u32, u32, u64) -> i32;
type DestroyFn = unsafe extern "C" fn(u64);

#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
struct ProbeResult {
  abi_version: u32,
  flags: u32,
  adapter_luid: u64,
}

/// Mirrors `lull_media_stream_stats` in `media_bridge.h`.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StreamStats {
  pub abi_version: u32,
  pub state: i32,
  pub texture_count: u32,
  pub last_error_kind: u32,
  pub presented: u64,
  pub dropped_not_started: u64,
  pub dropped_no_texture: u64,
  pub created_textures: u64,
  pub transient_errors: u64,
  pub last_present_tick_ms: u64,
  pub since_last_present_ms: u64,
}

/// TextureStream states, shared with the C++ bridge.
pub(crate) const STREAM_STATE_STOPPED: i32 = 2;
pub(crate) const STREAM_STATE_ERROR: i32 = 3;
pub(crate) const STREAM_STATE_ADAPTER_LOST: i32 = 4;

struct MediaApi {
  probe: ProbeFn,
  create: CreateFn,
  take_error: TakeErrorFn,
  state: Option<StateFn>,
  stats: Option<StatsFn>,
  submit_nv12: SubmitNv12Fn,
  destroy: DestroyFn,
  _lib: libloading::Library,
}

static API: OnceLock<Result<MediaApi, String>> = OnceLock::new();

fn candidates() -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      out.push(dir.join("lull_native.dll"));
    }
  }
  out.push(
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("native")
      .join("lull_native.dll"),
  );
  out
}

fn load() -> Result<MediaApi, String> {
  let mut errors = Vec::new();
  for path in candidates() {
    if !path.is_file() {
      errors.push(format!("{} (不存在)", path.display()));
      continue;
    }
    let lib = match unsafe { libloading::Library::new(&path) } {
      Ok(lib) => lib,
      Err(error) => {
        errors.push(format!("{} ({error})", path.display()));
        continue;
      }
    };
    let loaded = unsafe {
      let probe = lib.get::<ProbeFn>(b"lull_media_probe\0");
      let create = lib.get::<CreateFn>(b"lull_media_stream_create\0");
      let take_error = lib.get::<TakeErrorFn>(b"lull_media_stream_take_error\0");
      let submit_nv12 = lib.get::<SubmitNv12Fn>(b"lull_media_stream_submit_nv12\0");
      let destroy = lib.get::<DestroyFn>(b"lull_media_stream_destroy\0");
      // `state`/`stats` are diagnostics: an older DLL without them must still
      // serve frames, so they stay optional instead of failing the whole load.
      let state = lib
        .get::<StateFn>(b"lull_media_stream_state\0")
        .ok()
        .map(|function| *function);
      let stats = lib
        .get::<StatsFn>(b"lull_media_stream_stats\0")
        .ok()
        .map(|function| *function);
      match (probe, create, take_error, submit_nv12, destroy) {
        (Ok(probe), Ok(create), Ok(take_error), Ok(submit_nv12), Ok(destroy)) => Some(MediaApi {
          probe: *probe,
          create: *create,
          take_error: *take_error,
          state,
          stats,
          submit_nv12: *submit_nv12,
          destroy: *destroy,
          _lib: lib,
        }),
        _ => {
          errors.push(format!("{} (缺少 lull_media_* 导出)", path.display()));
          None
        }
      }
    };
    if let Some(api) = loaded {
      return Ok(api);
    }
  }
  Err(format!("原生媒体桥不可用: {}", errors.join("; ")))
}

fn api() -> Result<&'static MediaApi, String> {
  API.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// Whether the DLL has the media exports. Environment12 is probed per WebView.
#[must_use]
pub(crate) fn api_available() -> bool {
  api().is_ok()
}

fn to_wide(value: &str) -> Vec<u16> {
  value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Probe Environment12 through the WebView's environment pointer.
pub(crate) fn probe(environment: *mut c_void) -> Result<MediaCapabilities, String> {
  if environment.is_null() {
    return Err("WebView2 environment 为空".to_string());
  }
  let api = api()?;
  let mut result = ProbeResult::default();
  let hr = unsafe { (api.probe)(environment, &mut result) };
  if hr < 0 {
    return Err(format!("lull_media_probe 失败: 0x{hr:08x}"));
  }
  let available = result.flags & 0b11 == 0b11;
  Ok(MediaCapabilities {
    native_texture_stream: available,
    hardware_decode: available,
    reason: if available {
      None
    } else {
      Some("WebView2 Environment12/TextureStream 不可用".to_string())
    },
    runtime_version: None,
    adapter_luid: Some(result.adapter_luid),
    html_fallback: true,
  })
}

/// Create a stream for one WebView. The returned handle is owned by `NativeStream`.
pub(crate) fn create_stream(
  environment: *mut c_void,
  device: *mut c_void,
  stream_id: &str,
  origin: &str,
) -> Result<u64, String> {
  if environment.is_null() || device.is_null() {
    return Err("WebView2 environment / D3D11 device 为空".to_string());
  }
  let api = api()?;
  let id = to_wide(stream_id);
  let origin = to_wide(origin);
  let mut hr = 0i32;
  let handle = unsafe { (api.create)(environment, device, id.as_ptr(), origin.as_ptr(), &mut hr) };
  if handle == 0 || hr < 0 {
    return Err(format!("lull_media_stream_create 失败: 0x{hr:08x}"));
  }
  Ok(handle)
}

/// RAII wrapper. The last clone's drop destroys the C++ stream.
pub(crate) struct NativeStream {
  handle: u64,
  id: String,
}

// The C++ registry serializes stream state and owns all COM objects; a handle is
// just an integer and may be submitted from media-pp pipeline threads.
unsafe impl Send for NativeStream {}
unsafe impl Sync for NativeStream {}

impl NativeStream {
  #[must_use]
  pub(crate) fn new(handle: u64, id: String) -> Self {
    Self { handle, id }
  }

  #[must_use]
  pub(crate) fn id(&self) -> &str {
    &self.id
  }

  /// 0 presented/dropped intentionally, 1 not started, negative error.
  pub(crate) fn submit_nv12(
    &self,
    texture: *mut c_void,
    array_index: u32,
    width: u32,
    height: u32,
    timestamp_us: u64,
  ) -> i32 {
    let Ok(api) = api() else {
      return -1;
    };
    unsafe {
      (api.submit_nv12)(
        self.handle,
        texture,
        array_index,
        width,
        height,
        timestamp_us,
      )
    }
  }

  #[must_use]
  pub(crate) fn last_error(&self) -> Option<i32> {
    let api = api().ok()?;
    let mut code = 0i32;
    let rc = unsafe { (api.take_error)(self.handle, &mut code) };
    (rc == 0 && code < 0).then_some(code)
  }

  /// 0 created, 1 started, 2 stopped, 3 error, 4 adapter lost.
  #[must_use]
  pub(crate) fn state(&self) -> Option<i32> {
    let api = api().ok()?;
    api.state.map(|function| unsafe { function(self.handle) })
  }

  #[must_use]
  pub(crate) fn stats(&self) -> Option<StreamStats> {
    let api = api().ok()?;
    let function = api.stats?;
    let mut out = StreamStats::default();
    let rc = unsafe { function(self.handle, &mut out) };
    (rc == 0).then_some(out)
  }
}

impl Drop for NativeStream {
  fn drop(&mut self) {
    if let Ok(api) = api() {
      unsafe { (api.destroy)(self.handle) };
    }
  }
}
