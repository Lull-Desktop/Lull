//! Widget 窗口运行时辅助：宿主壳页 ready 握手、窗口存在性/关闭等待。
//!
//! Slot 切换只需要“窗口 + SDK 桥已就绪”这一层信号，不关心包内业务；因此放在
//! `widget_package` 而不是 Slot 模块，避免 Slot 反向依赖窗口实现。

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, Window};

static READY_WAITERS: OnceLock<Mutex<HashMap<String, Sender<()>>>> = OnceLock::new();

fn waiters() -> &'static Mutex<HashMap<String, Sender<()>>> {
  READY_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 在打开窗口前登记等待者；返回的 receiver 收到一次 ready 后即完成。
pub fn expect_ready(label: &str) -> Result<Receiver<()>, String> {
  let (sender, receiver) = mpsc::channel();
  let mut map = waiters().lock().map_err(|error| error.to_string())?;
  if map.contains_key(label) {
    return Err(format!("窗口 {label} 已在等待 ready"));
  }
  map.insert(label.to_string(), sender);
  Ok(receiver)
}

/// 宿主壳页报告 ready；重复调用是幂等的。
pub fn mark_ready(label: &str) {
  let Ok(mut map) = waiters().lock() else {
    return;
  };
  if let Some(sender) = map.remove(label) {
    let _ = sender.send(());
  }
}

/// 窗口销毁/打开失败时取消等待，让 `recv_timeout` 尽快返回。
pub fn cancel(label: &str) {
  if let Ok(mut map) = waiters().lock() {
    map.remove(label);
  }
}

pub fn wait_ready(receiver: Receiver<()>, timeout: Duration) -> Result<(), String> {
  receiver
    .recv_timeout(timeout)
    .map_err(|_| format!("等待扩展 ready 超时（{} ms）", timeout.as_millis()))
}

/// 阻塞等待窗口真正销毁；用于切换事务，避免旧窗口残留导致两个 active。
pub fn wait_closed(app: &AppHandle, id: &str, timeout: Duration) -> Result<(), String> {
  let label = super::label_for(id);
  let started = std::time::Instant::now();
  while app.get_webview_window(&label).is_some() {
    if started.elapsed() >= timeout {
      return Err(format!("等待窗口 {label} 关闭超时"));
    }
    std::thread::sleep(Duration::from_millis(20));
  }
  Ok(())
}

#[must_use]
pub fn is_open(app: &AppHandle, id: &str) -> bool {
  app.get_webview_window(&super::label_for(id)).is_some()
}

pub fn show(app: &AppHandle, id: &str) -> Result<(), String> {
  let window = app
    .get_webview_window(&super::label_for(id))
    .ok_or_else(|| "扩展窗口不存在".to_string())?;
  window.show().map_err(|error| error.to_string())?;
  let _ = window.unminimize();
  let _ = window.set_focus();
  Ok(())
}

/// 宿主壳页调用：标记 `widget-<id>` 已 ready。
#[tauri::command]
pub fn widget_package_ready(window: Window) -> Result<(), String> {
  let label = window.label();
  if !super::is_plugin_label(label) {
    return Err("只有插件窗口可以上报 ready".to_string());
  }
  mark_ready(label);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ready_waiter_receives_once() {
    let label = format!(
      "widget-ready-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    );
    let receiver = expect_ready(&label).expect("waiter");
    mark_ready(&label);
    assert!(receiver.recv_timeout(Duration::from_millis(200)).is_ok());
    // 第二次是 no-op，不会 panic。
    mark_ready(&label);
    cancel(&label);
  }

  #[test]
  fn waiter_can_be_cancelled() {
    let label = format!(
      "widget-cancel-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    );
    let receiver = expect_ready(&label).expect("waiter");
    cancel(&label);
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
  }
}
