//! 壁纸运行时：配置状态、窗口清单、生命周期与 IPC 命令。
//!
//! 本模块是壁纸子系统的唯一门面；窗口创建/重建在 `windows`，看门狗在
//! `watchdog`，几何与 ABI 分别在 `topology` / `ffi`。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use super::{ffi, protocol, topology, watchdog, windows};
use crate::config::{DisplayMode, WallpaperConfig};

pub(crate) struct ConfigState {
  pub(crate) path: PathBuf,
  pub(crate) data: WallpaperConfig,
}

static CONFIG: OnceLock<Mutex<ConfigState>> = OnceLock::new();

/// 配置句柄。未初始化 = 壁纸子系统未启动（dev 未启用壁纸时的正常态）。
pub(crate) fn config() -> Result<MutexGuard<'static, ConfigState>, String> {
  CONFIG
    .get()
    .ok_or_else(|| {
      "壁纸子系统未启动（dev 下用 pnpm test-mode 或 LULL_WALLPAPER=1 启动）".to_string()
    })?
    .lock()
    .map_err(|error| error.to_string())
}

pub(crate) struct Target {
  pub(crate) label: String,
  pub(crate) raw: isize,
  pub(crate) device: String,
}

static TARGETS: OnceLock<Mutex<Vec<Target>>> = OnceLock::new();

fn targets() -> &'static Mutex<Vec<Target>> {
  TARGETS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) fn push_target(label: &str, raw: isize, device: &str) {
  if let Ok(mut guard) = targets().lock() {
    guard.push(Target {
      label: label.to_string(),
      raw,
      device: device.to_string(),
    });
  }
}

pub(crate) fn snapshot_targets() -> Vec<(String, isize, String)> {
  targets()
    .lock()
    .map(|guard| {
      guard
        .iter()
        .map(|target| (target.label.clone(), target.raw, target.device.clone()))
        .collect()
    })
    .unwrap_or_default()
}

pub(crate) fn remove_target(label: &str) {
  if let Ok(mut guard) = targets().lock() {
    guard.retain(|target| target.label != label);
  }
}

pub(crate) fn take_targets() -> Vec<Target> {
  targets()
    .lock()
    .map(|mut guard| std::mem::take(&mut *guard))
    .unwrap_or_default()
}

/// 通知 WebView（设置页）壁纸清单/开关有变化。
pub(crate) fn emit_changed(app: &AppHandle) {
  let _ = app.emit("wallpaper-changed", ());
}

/// 壁纸启用策略：
/// - `LULL_WALLPAPER=0` / `--no-wallpaper` 显式关闭；
/// - `LULL_WALLPAPER=1` / `--wallpaper` 显式开启；
/// - 默认 release 开启、debug 关闭（避免日常 UI 开发被壁纸接管桌面）。
pub fn enabled() -> bool {
  let args: Vec<String> = std::env::args().collect();
  let has = |name: &str| args.iter().any(|arg| arg == name);
  let env_eq = |name: &str, value: &str| std::env::var(name).as_deref() == Ok(value);

  if env_eq("LULL_WALLPAPER", "0") || has("--no-wallpaper") {
    return false;
  }
  if env_eq("LULL_WALLPAPER", "1") || has("--wallpaper") {
    return true;
  }
  cfg!(not(debug_assertions))
}

/// 读取配置：优先 `display.json`；旧 `wallpaper.json` 自动迁移并落盘到新文件名。
fn load_config(app: &tauri::App) -> (PathBuf, WallpaperConfig) {
  let dir = app
    .path()
    .app_config_dir()
    .unwrap_or_else(|_| PathBuf::from("."));
  let path = dir.join("display.json");
  let legacy = dir.join("wallpaper.json");
  let source = if path.exists() {
    path.clone()
  } else if legacy.exists() {
    ffi::wlog(&format!(
      "发现旧配置 {}，迁移到 display.json",
      legacy.display()
    ));
    legacy
  } else {
    return (path, WallpaperConfig::default());
  };

  let outcome = WallpaperConfig::load_outcome(&source);
  if let Some(warning) = &outcome.warning {
    ffi::wlog(warning);
  }
  if let Some(version) = outcome.migrated_from {
    ffi::wlog(&format!("配置从 v{version} 迁移到当前版本"));
    if let Err(error) = outcome.config.save(&path) {
      ffi::wlog(&format!("迁移后的配置写盘失败（继续使用内存值）: {error}"));
    }
  }
  (path, outcome.config)
}

/// 产品主路径：壁纸窗常驻。任何失败都只降级壁纸，托盘与设置窗保持可用。
pub fn autostart(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let host = ffi::host().map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
  let (path, data) = load_config(app);
  ffi::wlog(&format!(
    "配置 {}: master={} 已关闭的显示器={:?}",
    path.display(),
    data.master_visible,
    data
      .monitors
      .iter()
      .filter(|(_, monitor)| !monitor.enabled)
      .map(|(device, _)| device.as_str())
      .collect::<Vec<_>>()
  ));

  let infos = topology::monitor_infos(host);
  let total = infos.len();
  let enabled_targets = topology::enabled_display_targets(&data, &infos);
  let snapshot = data.clone();
  let _ = CONFIG.set(Mutex::new(ConfigState { path, data }));

  ffi::wlog(&format!(
    "按配置创建壁纸窗口：{}/{} 台显示器",
    enabled_targets.len(),
    total
  ));
  let app_handle = app.handle().clone();
  for (index, device, physical) in &enabled_targets {
    match protocol::monitor_url(&snapshot, &infos, *index) {
      Ok(url) => {
        if let Err(error) = windows::create_one(
          &app_handle,
          *index,
          device,
          &url,
          *physical,
          host,
          snapshot.master_visible,
        ) {
          ffi::wlog(&error);
        }
      }
      Err(error) => ffi::wlog(&error),
    }
  }

  watchdog::spawn(app_handle);
  Ok(())
}

pub fn shutdown() {
  if let Ok(host) = ffi::host() {
    for target in take_targets() {
      let rc = unsafe { (host.detach)(target.raw as *mut std::ffi::c_void) };
      ffi::wlog(&format!("shutdown {} detach rc={rc}", target.label));
    }
  }
}

/// 所有壁纸窗口的状态（每行一个窗口）。
#[tauri::command]
pub fn wallpaper_status() -> Result<String, String> {
  let host = ffi::host()?;
  let snapshot = snapshot_targets();
  if snapshot.is_empty() {
    return Err("没有壁纸窗口".into());
  }
  Ok(
    snapshot
      .iter()
      .map(|(label, raw, _)| {
        format!(
          "{label}: {}",
          ffi::status_line(host, *raw as *mut std::ffi::c_void)
        )
      })
      .collect::<Vec<_>>()
      .join("\n"),
  )
}

/// 卸载全部壁纸窗口（还原桌面层级；窗口保留、保持隐藏）。
#[tauri::command]
pub fn wallpaper_detach() -> Result<String, String> {
  let host = ffi::host()?;
  let old = take_targets();
  let mut out = Vec::new();
  for target in &old {
    let rc = unsafe { (host.detach)(target.raw as *mut std::ffi::c_void) };
    out.push(format!("{} rc={rc}", target.label));
  }
  Ok(out.join("; "))
}

/// 当前显示器清单 + 每屏启用状态（设置页用；展示顺序由前端按几何排）。
#[derive(serde::Serialize)]
pub struct MonitorView {
  pub device: String,
  pub index: usize,
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
  pub dpi: u32,
  pub primary: bool,
  pub enabled: bool,
  /// 生效场景（每屏覆盖 → 全局回退）；UI 据此渲染每行场景选中态。
  pub scene: String,
}

#[tauri::command]
pub fn wallpaper_monitors() -> Result<Vec<MonitorView>, String> {
  let host = ffi::host()?;
  let config = config()?;
  Ok(
    topology::monitor_infos(host)
      .into_iter()
      .enumerate()
      .filter_map(|(index, result)| {
        let monitor = result.ok()?;
        Some(MonitorView {
          enabled: config.data.monitor_enabled(&monitor.device),
          scene: config.data.resolved_scene(&monitor.device),
          device: monitor.device,
          index,
          x: monitor.x,
          y: monitor.y,
          w: monitor.w,
          h: monitor.h,
          dpi: monitor.dpi,
          primary: monitor.primary,
        })
      })
      .collect(),
  )
}

/// 开启 / 关闭单台显示器的壁纸（enabled ⟺ 窗口存在；关闭 = detach+销毁；开启 = 按需创建）。
/// async = 在 async 运行时（非主线程）执行：建窗走 WebviewWindowBuilder 的标准路径。
#[tauri::command]
pub async fn wallpaper_set_monitor_visible(
  app: AppHandle,
  device: String,
  visible: bool,
) -> Result<(), String> {
  ffi::wlog(&format!(
    "set_monitor_visible 进入: {device} visible={visible}"
  ));
  {
    let mut config = config()?;
    config.data.set_monitor_enabled(&device, visible);
    if let Err(error) = config.data.save(&config.path) {
      config.data.set_monitor_enabled(&device, !visible); // 写盘失败：回滚内存状态
      return Err(format!("保存配置失败: {error}"));
    }
  }
  let result = windows::apply_monitor_visibility(&app, &device, visible);
  if let Err(error) = &result {
    ffi::wlog(&format!(
      "set_monitor_visible({device}, {visible}) 失败: {error}"
    ));
  }
  // 成功要让设置页刷新；失败也要（点击后的乐观跳动要回正）。
  emit_changed(&app);
  result
}

/// 全局显示配置（模式/同步/场景）。
#[tauri::command]
pub fn wallpaper_display_get() -> Result<crate::config::DisplayConfig, String> {
  Ok(config()?.data.display.clone())
}

/// 部分更新全局显示配置（None = 不改）。写盘失败回滚；随后热更所有壁纸窗。
#[tauri::command]
pub async fn wallpaper_set_display(
  app: AppHandle,
  mode: Option<DisplayMode>,
  sync: Option<bool>,
  scene: Option<String>,
) -> Result<(), String> {
  {
    let mut config = config()?;
    let old = config.data.display.clone();
    config.data.display.apply_patch(mode, sync, scene);
    if let Err(error) = config.data.save(&config.path) {
      config.data.display = old;
      return Err(format!("保存配置失败: {error}"));
    }
  }
  windows::reapply_display(&app)
}

/// 每屏场景覆盖（仅 independent 模式消费）。
#[tauri::command]
pub async fn wallpaper_set_monitor_scene(
  app: AppHandle,
  device: String,
  scene: String,
) -> Result<(), String> {
  {
    let mut config = config()?;
    let old = config
      .data
      .monitors
      .get(&device)
      .and_then(|monitor| monitor.scene.clone());
    config.data.set_monitor_scene(&device, Some(scene));
    if let Err(error) = config.data.save(&config.path) {
      config.data.set_monitor_scene(&device, old);
      return Err(format!("保存配置失败: {error}"));
    }
  }
  windows::reapply_display(&app)
}

/// 总开关：临时显隐全部壁纸层（ShowWindow；窗口保持挂载，不重挂不闪），并持久化。
#[tauri::command]
pub fn wallpaper_set_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
  let host = ffi::host()?;
  {
    let mut config = config()?;
    config.data.master_visible = visible;
    if let Err(error) = config.data.save(&config.path) {
      config.data.master_visible = !visible; // 写盘失败：回滚内存状态
      return Err(format!("保存配置失败: {error}"));
    }
  }
  for (_, raw, _) in snapshot_targets() {
    unsafe {
      (host.set_visible)(raw as *mut std::ffi::c_void, if visible { 1 } else { 0 });
    }
  }
  emit_changed(&app);
  Ok(visible)
}

/// 总开关当前状态（持久化的期望值，而非逐窗现场查询）。
#[tauri::command]
pub fn wallpaper_get_visible() -> Result<bool, String> {
  Ok(config()?.data.master_visible)
}
