//! 桌面应用二进制入口：在发布版隐藏控制台窗口，并将启动流程委托给库 crate。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  lull_lib::run()
}
