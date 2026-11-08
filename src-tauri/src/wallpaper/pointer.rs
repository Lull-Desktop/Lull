//! 桌面鼠标位置采样：只读取光标坐标，不读取任何按键状态。
//!
//! 壁纸窗口是 `WS_EX_TRANSPARENT` 的，永远收不到 DOM 鼠标事件；同时我们也不想
//! 安装 `WH_MOUSE_LL` 钩子（那会看到点击）。这里用 30Hz 的位置采样实现“只传递
//! 移动”：坐标没变就不发，点击本身不会产生任何消息。
//!
//! 数据流：`GetPhysicalCursorPos` / `WindowFromPoint` → `Tracker`（去重、
//! moving/idle）→ Tauri 定向事件 `wallpaper-pointer` → 壁纸顶层页面 → iframe
//! 里的 `@lull/scene-sdk`。
#![allow(unsafe_code)]

use tauri::AppHandle;
#[cfg(windows)]
use tauri::Emitter;

#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use super::runtime::snapshot_targets;

/// 与前端 `src/scenes/pointer-stream.ts` 的 WALLPAPER_POINTER_EVENT 保持一致。
#[cfg(windows)]
pub(crate) const POINTER_EVENT: &str = "wallpaper-pointer";
/// 采样周期：30Hz。不做逐硬件事件透传，视觉反馈足够且 IPC 开销可控。
#[cfg(windows)]
const SAMPLE_MS: u64 = 33;
/// 停止移动多久后补发 `moving=false`。
const IDLE_AFTER_MS: u64 = 120;

/// 一次位置采样（平台无关，便于单测）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RawPointer {
  x: i32,
  y: i32,
  over_desktop: bool,
}

/// 下发给壁纸页面的样本；只含位置与移动状态，没有任何按键/点击字段。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PointerSample {
  x: i32,
  y: i32,
  over_desktop: bool,
  moving: bool,
}

#[derive(Default)]
struct Tracker {
  last: Option<RawPointer>,
  moving: bool,
  last_move_ms: u64,
}

impl Tracker {
  fn reset(&mut self) {
    *self = Self::default();
  }

  /// 输入一次采样，返回需要下发的样本；无变化时返回 `None`。
  fn advance(&mut self, raw: RawPointer, now_ms: u64) -> Option<PointerSample> {
    let moved = self
      .last
      .is_none_or(|last| last.x != raw.x || last.y != raw.y);
    let desktop_changed = self
      .last
      .is_none_or(|last| last.over_desktop != raw.over_desktop);
    self.last = Some(raw);

    if !raw.over_desktop {
      // 移出桌面只补一条取消样本，之后的位置变化不再产生消息。
      self.moving = false;
      return desktop_changed.then(|| sample(raw, false));
    }

    if moved || desktop_changed {
      self.moving = moved;
      if moved {
        self.last_move_ms = now_ms;
      }
      return Some(sample(raw, self.moving));
    }

    if self.moving && now_ms.saturating_sub(self.last_move_ms) >= IDLE_AFTER_MS {
      self.moving = false;
      return Some(sample(raw, false));
    }
    None
  }
}

fn sample(raw: RawPointer, moving: bool) -> PointerSample {
  PointerSample {
    x: raw.x,
    y: raw.y,
    over_desktop: raw.over_desktop,
    moving,
  }
}

/// 启动壁纸鼠标位置采样线程（仅 Windows；其他平台为空实现）。
pub(crate) fn spawn(app: AppHandle) {
  #[cfg(windows)]
  {
    super::ffi::wlog("pointer: 启动鼠标位置采样（30Hz，只读坐标，不读按键）");
    std::thread::spawn(move || run(app));
  }
  #[cfg(not(windows))]
  {
    let _ = app;
  }
}

#[cfg(windows)]
fn run(app: AppHandle) {
  let started = Instant::now();
  let mut tracker = Tracker::default();
  let mut last_targets: Vec<(String, isize)> = Vec::new();
  loop {
    std::thread::sleep(Duration::from_millis(SAMPLE_MS));
    let targets: Vec<(String, isize)> = snapshot_targets()
      .into_iter()
      .filter(|(_, raw, _)| window_visible(*raw))
      .map(|(label, raw, _)| (label, raw))
      .collect();
    if targets != last_targets {
      // 新窗口 / 重建 / 隐藏后重新显示都补发一个当前样本，不必等鼠标再次移动。
      tracker.reset();
      last_targets = targets.clone();
    }
    if targets.is_empty() {
      continue;
    }
    let Some(raw) = sample_cursor() else {
      tracker.reset();
      continue;
    };
    let now_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let Some(pointer) = tracker.advance(raw, now_ms) else {
      continue;
    };
    for (label, _) in &targets {
      let _ = app.emit_to(label.as_str(), POINTER_EVENT, pointer.clone());
    }
  }
}

#[cfg(windows)]
fn window_visible(raw: isize) -> bool {
  use std::ffi::c_void;
  use windows::Win32::Foundation::HWND;
  use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;

  let hwnd = HWND(raw as *mut c_void);
  !hwnd.is_invalid() && unsafe { IsWindowVisible(hwnd) }.as_bool()
}

#[cfg(windows)]
fn sample_cursor() -> Option<RawPointer> {
  use windows::Win32::Foundation::POINT;
  use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetPhysicalCursorPos, WindowFromPoint, GA_ROOT,
  };

  let mut point = POINT { x: 0, y: 0 };
  unsafe { GetPhysicalCursorPos(&mut point) }.ok()?;
  let hwnd = unsafe { WindowFromPoint(point) };
  let over_desktop = !hwnd.is_invalid() && {
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    !root.is_invalid() && is_desktop_class(&window_class(root))
  };
  Some(RawPointer {
    x: point.x,
    y: point.y,
    over_desktop,
  })
}

#[cfg(windows)]
fn window_class(hwnd: windows::Win32::Foundation::HWND) -> String {
  use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

  let mut buffer = [0u16; 64];
  let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
  let end = usize::try_from(len.max(0)).unwrap_or(0).min(buffer.len());
  String::from_utf16_lossy(&buffer[..end])
}

/// 只认桌面宿主类名；应用窗口（包括被置顶的）一律返回 false。
fn is_desktop_class(class: &str) -> bool {
  matches!(class, "Progman" | "WorkerW")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn raw(x: i32, y: i32, over_desktop: bool) -> RawPointer {
    RawPointer { x, y, over_desktop }
  }

  fn at(x: i32, y: i32, over_desktop: bool, moving: bool) -> PointerSample {
    PointerSample {
      x,
      y,
      over_desktop,
      moving,
    }
  }

  #[test]
  fn first_desktop_sample_emits_moving() {
    let mut tracker = Tracker::default();
    assert_eq!(
      tracker.advance(raw(10, 20, true), 0),
      Some(at(10, 20, true, true))
    );
  }

  #[test]
  fn stationary_pointer_emits_once_then_idle_sample() {
    let mut tracker = Tracker::default();
    assert_eq!(
      tracker.advance(raw(10, 20, true), 0),
      Some(at(10, 20, true, true))
    );
    assert_eq!(tracker.advance(raw(10, 20, true), 33), None);
    assert_eq!(tracker.advance(raw(10, 20, true), 100), None);
    assert_eq!(
      tracker.advance(raw(10, 20, true), 133),
      Some(at(10, 20, true, false))
    );
    assert_eq!(tracker.advance(raw(10, 20, true), 200), None);
  }

  #[test]
  fn movement_after_idle_resumes_moving() {
    let mut tracker = Tracker::default();
    let _ = tracker.advance(raw(10, 20, true), 0);
    let _ = tracker.advance(raw(10, 20, true), 200);
    assert_eq!(
      tracker.advance(raw(11, 20, true), 233),
      Some(at(11, 20, true, true))
    );
  }

  #[test]
  fn click_without_moving_emits_nothing() {
    // 单击/双击改变的是按键状态，不改变坐标；采样器根本不读按键，
    // 因此这些操作在坐标不变时不会产生任何消息。
    let mut tracker = Tracker::default();
    let _ = tracker.advance(raw(10, 20, true), 0);
    let _ = tracker.advance(raw(10, 20, true), 200);
    for tick in 0..30 {
      assert_eq!(tracker.advance(raw(10, 20, true), 233 + tick * 33), None);
    }
  }

  #[test]
  fn leaving_desktop_emits_single_cancel() {
    let mut tracker = Tracker::default();
    let _ = tracker.advance(raw(10, 20, true), 0);
    assert_eq!(
      tracker.advance(raw(30, 40, false), 33),
      Some(at(30, 40, false, false))
    );
    assert_eq!(tracker.advance(raw(31, 41, false), 66), None);
    assert_eq!(tracker.advance(raw(32, 42, false), 99), None);
  }

  #[test]
  fn reentering_desktop_emits_even_without_movement() {
    let mut tracker = Tracker::default();
    let _ = tracker.advance(raw(10, 20, true), 0);
    let _ = tracker.advance(raw(30, 40, false), 33);
    assert_eq!(
      tracker.advance(raw(30, 40, true), 66),
      Some(at(30, 40, true, false))
    );
  }

  #[test]
  fn reset_reemits_initial_sample() {
    let mut tracker = Tracker::default();
    let _ = tracker.advance(raw(10, 20, true), 0);
    tracker.reset();
    assert_eq!(
      tracker.advance(raw(10, 20, true), 33),
      Some(at(10, 20, true, true))
    );
  }

  #[test]
  fn only_desktop_shell_classes_are_accepted() {
    assert!(is_desktop_class("Progman"));
    assert!(is_desktop_class("WorkerW"));
    assert!(!is_desktop_class("Chrome_WidgetWin_1"));
    assert!(!is_desktop_class("Shell_TrayWnd"));
    assert!(!is_desktop_class(""));
  }
}
