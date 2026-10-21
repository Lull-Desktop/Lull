//! 原生桌面宿主的加载与 C ABI 绑定。
//!
//! 安全边界：只有本模块允许 `unsafe`。所有导出函数都在 `lull_native.dll` 中，
//! 加载失败时返回可读错误；壁纸子系统起不来不得带走整个应用。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::OnceLock;

pub(crate) type AttachFn = unsafe extern "C" fn(*mut c_void, i32) -> i32;
pub(crate) type DetachFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub(crate) type EnsureFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub(crate) type StatusFn = unsafe extern "C" fn(*mut c_void, *mut u8, i32) -> i32;
pub(crate) type SetVisibleFn = unsafe extern "C" fn(*mut c_void, i32) -> i32;
pub(crate) type MonitorCountFn = unsafe extern "C" fn() -> i32;
pub(crate) type MonitorInfoFn = unsafe extern "C" fn(i32, *mut u8, i32) -> i32;
pub(crate) type TopologyHashFn = unsafe extern "C" fn() -> u64;
pub(crate) type DisableDwmFrameFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub(crate) type ForceRepaintFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub(crate) type EnsureHostFn = unsafe extern "C" fn() -> i32;

/// 已加载的原生宿主。`_lib` 必须与函数指针同生命周期，字段顺序不能随意调整。
pub(crate) struct NativeHost {
  pub(crate) attach: AttachFn,
  pub(crate) detach: DetachFn,
  pub(crate) ensure: EnsureFn,
  pub(crate) status: StatusFn,
  pub(crate) set_visible: SetVisibleFn,
  pub(crate) monitor_count: MonitorCountFn,
  pub(crate) monitor_info: MonitorInfoFn,
  pub(crate) topology_hash: TopologyHashFn,
  pub(crate) disable_dwm_frame: DisableDwmFrameFn,
  pub(crate) force_repaint: ForceRepaintFn,
  pub(crate) ensure_host: EnsureHostFn,
  _lib: libloading::Library,
}

static HOST: OnceLock<Result<NativeHost, String>> = OnceLock::new();

/// 进程内单例：DLL 只加载一次，首次失败后重试成本也很低（错误字符串可读）。
pub(crate) fn host() -> Result<&'static NativeHost, String> {
  HOST.get_or_init(load).as_ref().map_err(Clone::clone)
}

const DLL_NAME: &str = "lull_native.dll";

fn candidates() -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      // 打包后：与 lull.exe 同目录（Tauri resources 映射）。
      out.push(dir.join(DLL_NAME));
    }
  }
  // 开发态：cargo test / tauri dev 的 manifest 目录。
  out.push(
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("native")
      .join(DLL_NAME),
  );
  out
}

fn load() -> Result<NativeHost, String> {
  let mut tried: Vec<String> = Vec::new();
  for path in candidates() {
    if !path.exists() {
      tried.push(format!("{} (不存在)", path.display()));
      continue;
    }
    let lib = match unsafe { libloading::Library::new(&path) } {
      Ok(lib) => lib,
      Err(error) => {
        tried.push(format!("{} ({error})", path.display()));
        continue;
      }
    };
    unsafe {
      let attach = *lib
        .get::<AttachFn>(b"lull_native_attach\0")
        .map_err(|e| e.to_string())?;
      let detach = *lib
        .get::<DetachFn>(b"lull_native_detach\0")
        .map_err(|e| e.to_string())?;
      let ensure = *lib
        .get::<EnsureFn>(b"lull_native_ensure\0")
        .map_err(|e| e.to_string())?;
      let status = *lib
        .get::<StatusFn>(b"lull_native_status\0")
        .map_err(|e| e.to_string())?;
      let set_visible = *lib
        .get::<SetVisibleFn>(b"lull_native_set_visible\0")
        .map_err(|e| e.to_string())?;
      let monitor_count = *lib
        .get::<MonitorCountFn>(b"lull_native_monitor_count\0")
        .map_err(|e| e.to_string())?;
      let monitor_info = *lib
        .get::<MonitorInfoFn>(b"lull_native_monitor_info\0")
        .map_err(|e| e.to_string())?;
      let topology_hash = *lib
        .get::<TopologyHashFn>(b"lull_native_topology_hash\0")
        .map_err(|e| e.to_string())?;
      let disable_dwm_frame = *lib
        .get::<DisableDwmFrameFn>(b"lull_native_disable_dwm_frame\0")
        .map_err(|e| e.to_string())?;
      let force_repaint = *lib
        .get::<ForceRepaintFn>(b"lull_native_force_repaint\0")
        .map_err(|e| e.to_string())?;
      let ensure_host = *lib
        .get::<EnsureHostFn>(b"lull_native_ensure_host\0")
        .map_err(|e| e.to_string())?;
      return Ok(NativeHost {
        attach,
        detach,
        ensure,
        status,
        set_visible,
        monitor_count,
        monitor_info,
        topology_hash,
        disable_dwm_frame,
        force_repaint,
        ensure_host,
        _lib: lib,
      });
    }
  }
  Err(format!(
    "{DLL_NAME} 加载失败；尝试过: {}",
    tried.join(" | ")
  ))
}

/// 壁纸子系统的日志：release 无控制台，同时落盘到 `%TEMP%\lull\app.log`。
pub(crate) fn wlog(msg: &str) {
  println!("[wallpaper] {msg}");
  let Some(dir) = std::env::var_os("TEMP") else {
    return;
  };
  let path = std::path::Path::new(&dir).join("lull").join("app.log");
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  if let Ok(mut file) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
  {
    use std::io::Write;
    let _ = writeln!(file, "[wallpaper] {msg}");
  }
}

/// 读取原生状态串（`lull_native_status` 的 k=v 单行输出）。
pub(crate) fn status_line(host: &NativeHost, raw: *mut c_void) -> String {
  let mut buf = [0u8; 512];
  let rc = unsafe { (host.status)(raw, buf.as_mut_ptr(), buf.len() as i32) };
  if rc < 0 {
    return format!("status rc={rc}");
  }
  let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
  String::from_utf8_lossy(&buf[..n]).into_owned()
}
