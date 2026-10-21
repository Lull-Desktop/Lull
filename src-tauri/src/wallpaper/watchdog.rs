//! 壁纸看门狗：周期检查原生挂载状态、拓扑指纹与 WorkerW 宿主。
//!
//! 这里的所有操作都必须幂等：修复失败只记日志，绝不 panic 或结束应用。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::time::Duration;

use tauri::AppHandle;

use super::ffi;
use super::runtime::snapshot_targets;
use super::windows;

const TICK_MS: u64 = 700;

pub(crate) fn spawn(app: AppHandle) {
  std::thread::spawn(move || ensure_loop(app));
}

fn ensure_loop(app_handle: AppHandle) {
  let mut tick: u64 = 0;
  let mut last_hash: u64 = 0;
  let mut host_missing_logged = false;
  loop {
    std::thread::sleep(Duration::from_millis(TICK_MS));
    tick += 1;
    let snapshot = snapshot_targets();

    if let Ok(host) = ffi::host() {
      for (label, raw, _) in &snapshot {
        let fixed = unsafe { (host.ensure)(*raw as *mut c_void) };
        if fixed != 0 {
          ffi::wlog(&format!("{label} ensure_fixed={fixed}"));
        }
      }

      if tick.is_multiple_of(30) {
        if let Some((label, raw, _)) = snapshot.first() {
          ffi::wlog(&format!(
            "tick={tick} 窗口数={} | {label}: {}",
            snapshot.len(),
            ffi::status_line(host, *raw as *mut c_void)
          ));
        }
      }

      // 拓扑变化检测（约 2.1s 一次）：数量/设备名/矩形/DPI/主屏/宿主尺寸任一变化
      // → 按配置重建。窗口数可为 0（用户把每屏都关了）——此时同样要检测，
      // 新插入的显示器才能自动开。
      if tick.is_multiple_of(3) {
        let hash = unsafe { (host.topology_hash)() };
        if last_hash == 0 {
          last_hash = hash;
        } else if hash != last_hash {
          ffi::wlog(&format!(
            "显示器/桌面拓扑变化（hash {last_hash:x} -> {hash:x}），按配置重建壁纸窗口"
          ));
          last_hash = hash;
          // 重建跑在 async 运行时（非主线程）——建窗走 WebviewWindowBuilder 封送，
          // 不在主线程分发上下文里同步建 WebView2（会卡死）。
          let app = app_handle.clone();
          tauri::async_runtime::spawn(async move {
            if let Err(error) = windows::rebuild(&app) {
              ffi::wlog(&format!("rebuild 失败: {error}"));
            }
          });
        }
      }

      // 看门狗 5（全局宿主门）：系统壁纸为纯色/未设置时 WorkerW 不会自然存在，
      // DefView 会不透明涂色整块盖住壁纸层（状态位全“正常”）。约 3.5s 复查一次、
      // 缺失即 Post 0x052C 补建口信；仅在状态翻转时留日志（避免刷屏）。
      if tick.is_multiple_of(5) {
        let rc = unsafe { (host.ensure_host)() };
        if rc == 1 && !host_missing_logged {
          ffi::wlog("壁纸宿主 WorkerW 缺失：已请求 Progman 补建（0x052C）");
          host_missing_logged = true;
        } else if rc == 0 && host_missing_logged {
          ffi::wlog("壁纸宿主 WorkerW 已补建");
          host_missing_logged = false;
        }
      }
    }
  }
}
