//! Lull 应用装配层：注册插件与 IPC 命令，初始化托盘和壁纸生命周期，并处理退出流程。
//!
//! 该文件只做“接线”：业务能力在 `wallpaper` / `window_host` / `config` 中，
//! 新增命令请先确认归属模块，不要把实现写回这里。
#![allow(linker_messages)]

use tauri::Manager;

mod config;
mod tray;
mod wallpaper;
mod widget_package;
mod window_frame;
mod window_host;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // 单实例：第二个实例启动时立即退出，并把已有实例的设置窗呼出来（官方插件，须最先注册）。
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      println!("[app] 检测到重复启动：已退出新实例，呼出现有实例的设置窗");
      window_host::open_async(app, &window_host::SETTINGS);
    }))
    .plugin(tauri_plugin_opener::init())
    // 第三方插件资源协议：只读服务用户插件包，并按插件注入 CSP。
    .register_uri_scheme_protocol("lullwidget", |ctx, request| {
      widget_package::handle_protocol(ctx, request)
    })
    .invoke_handler(tauri::generate_handler![
      window_frame::window_set_frame,
      window_host::widget_open,
      window_host::widget_states,
      window_host::widget_close,
      window_host::prefs::window_prefs_get,
      window_host::prefs::window_prefs_set,
      widget_package::widget_package_notify,
      widget_package::widget_packages,
      widget_package::widget_package_set_enabled,
      widget_package::widget_package_open,
      widget_package::widget_package_close,
      widget_package::widget_package_revoke,
      widget_package::widget_state_get,
      widget_package::widget_state_set,
      widget_package::widget_state_remove,
      widget_package::widget_set_transparent,
      wallpaper::runtime::wallpaper_status,
      wallpaper::runtime::wallpaper_detach,
      wallpaper::runtime::wallpaper_set_visible,
      wallpaper::runtime::wallpaper_get_visible,
      wallpaper::runtime::wallpaper_monitors,
      wallpaper::runtime::wallpaper_set_monitor_visible,
      wallpaper::runtime::wallpaper_display_get,
      wallpaper::runtime::wallpaper_set_display,
      wallpaper::runtime::wallpaper_set_scene_params,
      wallpaper::runtime::wallpaper_set_monitor_scene
    ])
    .setup(|app| {
      tray::init(app)?;
      if wallpaper::enabled() {
        // 产品主路径：壁纸窗常驻（release 默认；dev 需要 LULL_WALLPAPER=1 / pnpm test-mode）。
        // 壁纸子系统起不来（DLL 缺失/过期等）不应带走整个应用——托盘与设置窗保持可用，
        // 失败详情落 %TEMP%\lull\app.log（release 无控制台）。
        if let Err(error) = wallpaper::autostart(app) {
          wallpaper::wlog(&format!(
            "壁纸子系统启动失败（应用继续，壁纸关闭）: {error}"
          ));
          if cfg!(debug_assertions) {
            tray::show_settings(app.handle());
          }
        }
      } else if cfg!(debug_assertions) {
        // dev 且未启用壁纸：直接开出设置窗，方便纯 UI 开发；release 无壁纸时只留托盘。
        tray::show_settings(app.handle());
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // 退出模型：所有应用窗口的 X / Alt+F4 都只是隐藏（应用与壁纸继续运行），
        // 只有托盘「退出」才真正结束整个进程（见 tray.rs 的 app.exit(0)）。
        if window_host::is_managed(window.label())
          || widget_package::is_plugin_label(window.label())
        {
          api.prevent_close();
          let _ = window.hide();
          // 工具窗/插件窗被 Alt+F4 隐藏后，通知设置页刷新显示开关。
          window_host::notify_changed(window.app_handle());
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, event| {
      if let tauri::RunEvent::Exit = event {
        wallpaper::shutdown();
      }
    });
}
