//! 壁纸窗口生命周期：创建、挂载、销毁、重建与热更新。
//!
//! 关键约束（踩坑记录，勿随手改动）：
//! - 运行时创建 WebView2 必须从非主线程调用 `WebviewWindowBuilder`，否则主线程
//!   分发上下文里的嵌套消息泵会卡死；
//! - `.shadow(false)` 是视觉硬化终案，避免 tao 阴影帧把客户区内缩出黑边；
//! - 首次挂载后按延时做尺寸/重绘修复，覆盖 WebView2 controller bounds 与首帧残留。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::ffi::{self, NativeHost};
use super::protocol::monitor_url;
use super::runtime::{
  config, emit_changed, push_target, remove_target, snapshot_targets, take_targets,
};
use super::topology::{enabled_display_targets, monitor_infos, MonitorInfo};

/// 当前配置是否允许这个壁纸窗显示：总开关开 + 该显示器开启。
///
/// 页面首帧回调可能晚于用户再次关闭总开关/显示器；显示前必须按**当前**配置复核，
/// 不能只用建窗时的 `show` 快照，否则已关闭的壁纸会被迟到回调重新弹出来。
fn monitor_visible(device: &str, fallback: bool) -> bool {
  config().map_or(fallback, |state| {
    state.data.master_visible && state.data.monitor_enabled(device)
  })
}

pub(crate) fn create_one(
  app: &AppHandle,
  index: usize,
  device: &str,
  url: &str,
  physical: (u32, u32),
  host: &'static NativeHost,
  show: bool,
) -> Result<(), String> {
  let label = format!("wallpaper-{index}");
  // 创建路径只从非主线程调用（async 命令 / async 任务 / ensure 线程）；
  // autostart 虽在主线程，但处于事件循环启动前，等价于 tauri.conf 的建窗时机。
  ffi::wlog(&format!(
    "{label}: 开始创建（当前线程 {:?}）",
    std::thread::current().name()
  ));
  // 不能用 Tauri 默认的 800×600 建窗：WebView2 会先按小视口创建、导航与首帧，
  // 挂载后即使窗口被拉成全屏，第一帧仍可能是"小窗"再跳变。这里按目标显示器的
  // 物理矩形给初始尺寸。
  //
  // Tauri 的 inner_size 按逻辑像素解释，并用窗口创建时的缩放换算；窗口默认落在
  // 主屏，所以用主屏 DPI 反推逻辑尺寸，创建出来的物理尺寸才与目标显示器一致。
  // 直接用目标屏 DPI 会在混合 DPI 下二次换算（例如次屏 125% 时偏大 25%）。
  let primary_scale = monitor_infos(host)
    .iter()
    .filter_map(|result| result.as_ref().ok())
    .find(|monitor| monitor.primary)
    .map_or(1.0, |monitor| f64::from(monitor.dpi.max(96)) / 96.0);
  let logical = (
    f64::from(physical.0) / primary_scale,
    f64::from(physical.1) / primary_scale,
  );
  // 页面首帧门：native attach 只挂载、不显示；这里等 WebView2 的
  // PageLoadEvent::Finished 再通过 native set_visible(SW_SHOWNA) 显示。
  // 这样开关打开时，用户先看到原来那块桌面/旧壁纸，等启动幕已经渲染好才换上来，
  // 不会先闪一块深色空 WebView。attached/loaded 两个标记覆盖"页面先加载完、
  // 挂载后完成"的竞态；show 只是建窗时的快照，最终还要按当前配置复核。
  let attached = Arc::new(AtomicBool::new(false));
  let loaded = Arc::new(AtomicBool::new(false));
  let raw_slot = Arc::new(AtomicIsize::new(0));
  let attached_for_load = Arc::clone(&attached);
  let loaded_for_load = Arc::clone(&loaded);
  let raw_for_load = Arc::clone(&raw_slot);
  let device_for_load = device.to_string();
  let set_visible = host.set_visible;
  let allow_show = show;
  let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
    .title("Lull 壁纸")
    .visible(false)
    .inner_size(logical.0, logical.1)
    // 页面首帧之前的窗口底色，与 native 的 WM_ERASEBKGND / 壁纸底色一致，避免白闪。
    .background_color(tauri::window::Color(5, 10, 16, 255))
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .devtools(crate::window_host::devtools_enabled())
    .on_page_load(move |_window, payload| {
      if !matches!(payload.event(), PageLoadEvent::Finished) {
        return;
      }
      loaded_for_load.store(true, Ordering::Release);
      if !allow_show
        || !attached_for_load.load(Ordering::Acquire)
        || !monitor_visible(&device_for_load, allow_show)
      {
        return;
      }
      let raw = raw_for_load.load(Ordering::Acquire);
      if raw != 0 {
        unsafe { (set_visible)(raw as *mut c_void, 1) };
      }
    })
    .build()
    .map_err(|error| format!("创建 {label} 失败: {error}"))?;
  ffi::wlog(&format!("{label}: 窗口+WebView 已建 ({url})"));
  let raw = window.hwnd().map_err(|error| error.to_string())?.0;
  raw_slot.store(raw as isize, Ordering::Release);
  let drc = unsafe { (host.disable_dwm_frame)(raw) };
  ffi::wlog(&format!("{label}: disable_dwm_frame rc={drc}"));

  let rc = unsafe { (host.attach)(raw, i32::try_from(index).unwrap_or(i32::MAX)) };
  ffi::wlog(&format!(
    "{label}: attach rc={rc} {}",
    ffi::status_line(host, raw)
  ));
  if rc != 0 {
    let _ = window.destroy();
    return Err(format!("{label} attach rc={rc}"));
  }
  attached.store(true, Ordering::Release);
  push_target(&label, raw as isize, device);

  // 页面可能在 attach 之前就 Finished；此时回调只置了 loaded，需要在这里补一次显示。
  if show && loaded.load(Ordering::Acquire) && monitor_visible(device, show) {
    unsafe {
      (host.set_visible)(raw, 1);
    }
  }

  // 兜底：页面加载异常（dev server 未启动 / 静态资源 404）时不能让窗口永远隐藏。
  // 2.5s 后仍未显示才补一次；显示前再按当前配置复核，避免把已关闭的壁纸弹回来。
  if show {
    let fallback_app = app.clone();
    let fallback_label = label.clone();
    let fallback_device = device.to_string();
    let fallback_raw = raw as isize;
    let fallback_set_visible = host.set_visible;
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(2500));
      if !monitor_visible(&fallback_device, false) {
        return;
      }
      if let Some(window) = fallback_app.get_webview_window(&fallback_label) {
        // label 会按显示器下标复用：若旧窗已被销毁、同 label 的新窗正在加载，
        // 这个迟到的兜底不能把新窗提前弹出来。
        if window
          .hwnd()
          .map(|hwnd| hwnd.0 as isize)
          .unwrap_or_default()
          != fallback_raw
        {
          return;
        }
        if window.is_visible().unwrap_or(true) {
          return;
        }
        unsafe {
          (fallback_set_visible)(fallback_raw as *mut c_void, 1);
        }
      }
    });
  }

  // 诊断：导航是异步的，加载后延迟读取真实地址，确认参数哈希到达了 WebView。
  {
    let diag_app = app.clone();
    let diag_label = label.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(3000));
      if let Some(window) = diag_app.get_webview_window(&diag_label) {
        match window.url() {
          Ok(url) => ffi::wlog(&format!("{diag_label}: 加载后 url = {url}")),
          Err(error) => ffi::wlog(&format!("{diag_label}: 加载后 url 读取失败: {error}")),
        }
      }
    });
  }

  // 白边修复 + 尺寸兜底：挂载后按延时只改尺寸、不改位置，再由 native ensure 用
  // attach 时按宿主客户区算好的精确矩形做校正，最后强制全窗重绘（清首帧浅色像素）。
  //
  // 首个 120ms 的复查专门接住 Tauri 在 attach 之后才处理的 Resized：那条路径仍会
  // 按 tao 的 scale 缓存把 WebView bounds 做一次 logical→physical 换算，125% 屏上可能
  // 缩成 0.8×。此时窗口还停在页面首帧门之前（隐藏），修正不会被看到；等到 700ms
  // 看门狗再修就晚了。后续 700/1800/3500ms 只负责白边与慢加载场景。
  //
  // ★ 这里**不能**用 `set_bounds(position=(0,0))`：窗口已经 SetParent 到 Progman，
  //   position 是父窗口客户区坐标；虚拟桌面原点在副屏左上角时，(0,0) 会把主屏壁纸
  //   瞬间挪到 (-2560,0)，再被 EnsureRect 拉回来——这正是开关打开/窗口重建时
  //   "跳一下"的来源。set_size 只改尺寸，位置交给 native want_rect。
  let repaint = host.force_repaint;
  let ensure = host.ensure;
  let raw_isize = raw as isize;
  std::thread::spawn(move || {
    let raw = raw_isize as *mut c_void;
    for delay_ms in [120u64, 700, 1800, 3500] {
      std::thread::sleep(Duration::from_millis(delay_ms));
      let _ = window
        .as_ref()
        .set_size(tauri::PhysicalSize::new(physical.0, physical.1));
      let _ = unsafe { ensure(raw) };
      unsafe { repaint(raw) };
    }
  });
  Ok(())
}

/// 开启 → 无窗口则按需重建（窗口先隐藏，页面首帧后显示）；关闭 → detach+销毁+移出清单。
/// 在非主线程（async 命令/任务）上执行；tauri 负责把窗口相关操作封送回主线程。
pub(crate) fn apply_monitor_visibility(
  app: &AppHandle,
  device: &str,
  visible: bool,
) -> Result<(), String> {
  let host = ffi::host()?;
  let existing = snapshot_targets()
    .into_iter()
    .find(|(_, _, existing_device)| existing_device == device);
  ffi::wlog(&format!(
    "apply: {device} visible={visible} 已有窗口={}",
    existing.is_some()
  ));
  if visible {
    if existing.is_none() {
      let config = config()?.data.clone();
      let infos = monitor_infos(host);
      let found = infos
        .iter()
        .enumerate()
        .find_map(|(index, result)| match result {
          Ok(monitor) if monitor.device == device => Some((index, monitor)),
          _ => None,
        });
      let (index, monitor) = found.ok_or_else(|| format!("显示器不在线: {device}"))?;
      let url = monitor_url(&config, &infos, index)?;
      let physical = (
        u32::try_from(monitor.w).unwrap_or(1920),
        u32::try_from(monitor.h).unwrap_or(1080),
      );
      create_one(
        app,
        index,
        device,
        &url,
        physical,
        host,
        config.master_visible,
      )?;
    }
  } else if let Some((label, raw, _)) = existing {
    remove_target(&label);
    unsafe {
      (host.detach)(raw as *mut c_void);
    }
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.destroy();
    }
  }
  Ok(())
}

/// 拓扑变化后的全量重建；由看门狗在 async 运行时调用（非主线程）。
pub(crate) fn rebuild(app: &AppHandle) -> Result<(), String> {
  let host = ffi::host()?;
  let old = take_targets();
  for target in &old {
    unsafe {
      (host.detach)(target.raw as *mut c_void);
    }
    if let Some(window) = app.get_webview_window(&target.label) {
      let _ = window.destroy();
    }
  }
  let config = config()?.data.clone();
  let infos = monitor_infos(host);
  let enabled = enabled_display_targets(&config, &infos);
  ffi::wlog(&format!(
    "rebuild：销毁 {} 个旧窗口，按配置重建 {} 个",
    old.len(),
    enabled.len()
  ));
  for (index, device, physical) in &enabled {
    match monitor_url(&config, &infos, *index) {
      Ok(url) => {
        if let Err(error) = create_one(
          app,
          *index,
          device,
          &url,
          *physical,
          host,
          config.master_visible,
        ) {
          ffi::wlog(&error);
        }
      }
      Err(error) => ffi::wlog(&error),
    }
  }
  emit_changed(app);
  Ok(())
}

/// 对全部现存壁纸窗热更参数哈希（零重载）。eval 的 JS 字符串用 serde_json 序列化防注入。
fn hot_update_windows(
  app: &AppHandle,
  config: &crate::config::WallpaperConfig,
  infos: &[Result<MonitorInfo, String>],
) {
  for (label, _raw, device) in snapshot_targets() {
    let index = infos.iter().position(|result| {
      result
        .as_ref()
        .is_ok_and(|monitor| monitor.device == device)
    });
    let Some(index) = index else {
      continue;
    };
    let Ok(url) = monitor_url(config, infos, index) else {
      continue;
    };
    let hash = url.trim_start_matches('/');
    let Ok(quoted) = serde_json::to_string(hash) else {
      continue;
    };
    if let Some(window) = app.get_webview_window(&label) {
      // 参数热更只有这一条通道；成败都留日志，便于排查「设置面板改了没反应」。
      match window.eval(format!("location.hash = {quoted}")) {
        Ok(()) => ffi::wlog(&format!("{label}: 热更哈希 {hash}")),
        Err(error) => ffi::wlog(&format!("{label}: 热更哈希失败 {error}")),
      }
    }
  }
}

pub(crate) fn reapply_display(app: &AppHandle) -> Result<(), String> {
  let host = ffi::host()?;
  let config = config()?.data.clone();
  let infos = monitor_infos(host);
  hot_update_windows(app, &config, &infos);
  emit_changed(app);
  Ok(())
}
