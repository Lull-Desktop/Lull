//! Lull 应用装配层：注册插件与 IPC 命令，初始化托盘和壁纸生命周期，并处理退出流程。
//!
//! 该文件只做“接线”：业务能力在 `wallpaper` / `window_host` / `config` 中，
//! 新增命令请先确认归属模块，不要把实现写回这里。
#![allow(linker_messages)]

use tauri::Manager;

mod config;
mod content_package;
mod content_trust;
mod extension;
mod game;
mod game_package;
mod i18n;
mod media;
mod package_hash;
mod resource;
pub(crate) mod tray;
pub(crate) mod wallpaper;
mod webview;
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
    // 用户内容包资源协议：只读服务 %APPDATA%\content\<id>\，供沙箱 iframe 加载。
    .register_uri_scheme_protocol("lullcontent", |ctx, request| {
      content_package::handle_protocol(ctx, request)
    })
    // 第三方游戏包资源协议：只读服务 %APPDATA%\games\<id>\，按包注入 CSP。
    .register_uri_scheme_protocol("lullgame", |ctx, request| {
      game_package::handle_protocol(ctx, request)
    })
    .invoke_handler(tauri::generate_handler![
      window_frame::window_set_frame,
      window_host::widget_open,
      window_host::widget_take_open_tab,
      window_host::widget_visibility,
      window_host::widget_states,
      window_host::widget_close,
      extension::extensions_list,
      extension::extensions_slots,
      extension::extensions_slot_use,
      extension::extensions_slot_activate,
      extension::extensions_slot_deactivate,
      extension::extensions_inspect,
      extension::extensions_pick,
      extension::extensions_install,
      extension::extensions_remove,
      extension::extensions_set_enabled,
      extension::extensions_set_capability,
      extension::extensions_open,
      extension::extensions_close,
      extension::extensions_stop,
      extension::extensions_open_dir,
      extension::extensions_dev_state,
      extension::extensions_dev_set_enabled,
      extension::extensions_dev_pick_and_add,
      extension::extensions_dev_remove,
      extension::extensions_dev_reload,
      window_host::prefs::window_prefs_get,
      window_host::prefs::window_prefs_set,
      content_trust::policy::content_trust_policy_get,
      content_trust::policy::content_trust_policy_set,
      i18n::i18n_boot,
      i18n::i18n_set_locale,
      widget_package::widget_package_notify,
      widget_package::runtime::widget_package_ready,
      widget_package::widget_state_get,
      widget_package::widget_state_set,
      widget_package::widget_state_remove,
      widget_package::widget_set_transparent,
      widget_package::widget_apply_resize,
      widget_package::widget_align_player,
      wallpaper::runtime::wallpaper_status,
      wallpaper::runtime::wallpaper_detach,
      wallpaper::runtime::wallpaper_set_visible,
      wallpaper::runtime::wallpaper_get_visible,
      wallpaper::runtime::wallpaper_monitors,
      wallpaper::runtime::wallpaper_set_monitor_visible,
      wallpaper::runtime::wallpaper_display_get,
      wallpaper::runtime::wallpaper_set_display,
      wallpaper::runtime::wallpaper_set_game,
      wallpaper::runtime::wallpaper_set_scene_params,
      wallpaper::runtime::wallpaper_set_monitor_scene,
      media::video::commands::media_capabilities,
      media::video::commands::media_assets,
      media::video::commands::media_asset_pick,
      media::video::commands::media_asset_remove,
      media::video::commands::media_asset_url,
      media::video::commands::media_asset_pick_many,
      media::video::commands::media_asset_rename,
      media::video::commands::media_asset_prune,
      media::video::commands::media_config_get,
      media::video::commands::media_config_set,
      media::video::commands::media_activate,
      media::video::commands::media_open,
      media::video::commands::media_attach,
      media::video::commands::media_detach,
      media::video::commands::media_degrade,
      media::video::commands::media_play,
      media::video::commands::media_pause,
      media::video::commands::media_seek,
      media::video::commands::media_resync,
      media::video::commands::media_set_loop,
      media::video::commands::media_status,
      media::video::commands::media_stats,
      media::api::commands::media_call,
      media::api::commands::media_connect,
      media::api::commands::media_disconnect,
      media::api::commands::media_engine_ready,
      media::api::commands::media_engine_event,
      content_package::content_packages,
      game::api::games_list,
      game::api::games_config_get,
      game::api::games_config_set,
      game::api::game_runtime_diagnostics,
      game::api::game_replica_entry,
      game::api::game_auto_start,
      game::api::game_start,
      game::api::game_stop,
      game::api::game_flush,
      game::api::game_suspend,
      game::api::game_resume,
      game::api::game_set_background,
      game::api::game_save_delete,
      game::api::game_connect,
      game::api::game_snapshot_get,
      game::api::game_state_commit,
      game::api::game_event_publish,
      game::api::game_render_state_publish,
      game::api::game_command_result,
      game::api::game_ready,
      game::api::game_heartbeat,
      game::api::game_report_error,
      game::api::game_detach,
      game::api::game_command_send
    ])
    .setup(|app| {
      // 语言必须在建窗与建托盘之前定下来，否则系统托盘会先出基准语言再跳变。
      i18n::init(app.handle());
      // 游戏运行时：标记残留运行态并拉起 ticker；必须在壁纸窗创建之前。
      game::init(app.handle());
      // 官方扩展随安装包分发：启动时默认启用、升级补授新增能力、保留用户撤销。
      widget_package::official::reconcile(app.handle());
      // 功能槽位只恢复用户选择，不自动开窗/播放。
      extension::slots::init(app.handle());
      media::init(app.handle().clone());
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
    .on_window_event(|window, event| match event {
      tauri::WindowEvent::CloseRequested { api, .. } => {
        // 退出模型：所有应用窗口的 X / Alt+F4 都只是隐藏（应用与壁纸继续运行），
        // 只有托盘「退出」才真正结束整个进程（见 tray.rs 的 app.exit(0)）。
        if window_host::is_managed(window.label())
          || widget_package::is_plugin_label(window.label())
        {
          api.prevent_close();
          let _ = window.hide();
          // 工具窗/插件窗被 Alt+F4 隐藏后，通知设置页刷新显示开关。
          window_host::notify_changed(window.app_handle());
        } else if window.label() == media::engine::ENGINE_LABEL {
          api.prevent_close();
          let _ = window.hide();
        }
      }
      tauri::WindowEvent::Destroyed => {
        media::on_window_destroyed(window.app_handle(), window.label());
        widget_package::on_window_destroyed(window.label());
        extension::slots::on_window_destroyed(window.app_handle(), window.label());
        game::on_window_destroyed(window.app_handle(), window.label());
      }
      _ => {}
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, event| match event {
      // 壁纸窗在“关闭所有显示器”时会全部销毁；设置窗也可能被隐藏。
      // 托盘应用必须靠 tray 的显式 app.exit(0) 退出，不能被 last-window-close
      // 默认行为带走，否则再次打开显示器时进程已经没了。程序化 exit 的
      // code 是 Some(_)，用户关窗/系统请求是 None。
      tauri::RunEvent::ExitRequested {
        code: None, api, ..
      } => api.prevent_exit(),
      tauri::RunEvent::Exit => {
        game::shutdown(_app);
        media::shutdown(_app);
        wallpaper::shutdown();
      }
      _ => {}
    });
}
