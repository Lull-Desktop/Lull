//! 壁纸 URL 协议：把显示模式、场景与几何编码进前端 hash。
//!
//! 该协议是 Rust 与 WebView 之间唯一的画面契约；参数必须是纯函数可测的，
//! 不能依赖窗口或原生状态。

use super::topology::{virtual_bounds_from, MonitorInfo};
use crate::config::{DisplayMode, WallpaperConfig};

/// 壁纸窗参数哈希。canvas/view 为物理像素桌面坐标，可为负。
pub(crate) fn wallpaper_hash(
  mode: DisplayMode,
  sync: bool,
  scene: &str,
  canvas: (i32, i32, i32, i32),
  view: (i32, i32, i32, i32),
) -> String {
  let mode = match mode {
    DisplayMode::Mirror => "mirror",
    DisplayMode::Independent => "independent",
    DisplayMode::Span => "span",
  };
  format!(
    "#mode={mode}&sync={}&scene={scene}&canvas={},{},{},{}&view={},{},{},{}",
    if sync { 1 } else { 0 },
    canvas.0,
    canvas.1,
    canvas.2,
    canvas.3,
    view.0,
    view.1,
    view.2,
    view.3,
  )
}

/// 某屏壁纸窗的 App 相对 URL（`/#mode=…`）。index 为 native 枚举序（attach 同源）。
pub(crate) fn monitor_url(
  config: &WallpaperConfig,
  infos: &[Result<MonitorInfo, String>],
  index: usize,
) -> Result<String, String> {
  let monitor = infos
    .get(index)
    .and_then(|result| result.as_ref().ok())
    .ok_or_else(|| format!("显示器下标 {index} 无效"))?;
  let canvas = virtual_bounds_from(infos).ok_or_else(|| "没有可用显示器".to_string())?;
  let scene = if config.display.mode == DisplayMode::Independent {
    config.resolved_scene(&monitor.device)
  } else {
    config.display.scene.clone()
  };
  Ok(format!(
    "/{}",
    wallpaper_hash(
      config.display.mode,
      config.display.sync,
      &scene,
      canvas,
      (monitor.x, monitor.y, monitor.w, monitor.h)
    )
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::config::WallpaperConfig;

  fn ok_infos() -> Vec<Result<MonitorInfo, String>> {
    vec![
      Ok(MonitorInfo {
        device: "\\\\.\\DISPLAY1".into(),
        x: 0,
        y: 0,
        w: 1920,
        h: 1080,
        dpi: 96,
        primary: true,
      }),
      Ok(MonitorInfo {
        device: "\\\\.\\DISPLAY2".into(),
        x: -2560,
        y: 0,
        w: 2560,
        h: 1440,
        dpi: 120,
        primary: false,
      }),
    ]
  }

  #[test]
  fn wallpaper_hash_span_golden() {
    let hash = wallpaper_hash(
      DisplayMode::Span,
      true,
      "lull.bamboo",
      (-2560, 0, 4480, 1440),
      (0, 0, 1920, 1080),
    );
    assert_eq!(
      hash,
      "#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=0,0,1920,1080"
    );
  }

  #[test]
  fn wallpaper_hash_mirror_and_independent_shapes() {
    let hash = wallpaper_hash(
      DisplayMode::Mirror,
      false,
      "lull.aurora",
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
    );
    assert_eq!(
      hash,
      "#mode=mirror&sync=0&scene=lull.aurora&canvas=0,0,1920,1080&view=0,0,1920,1080"
    );
    let independent = wallpaper_hash(
      DisplayMode::Independent,
      true,
      "lull.bamboo",
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
    );
    assert!(independent.starts_with("#mode=independent&sync=1&scene=lull.bamboo&"));
  }

  #[test]
  fn monitor_url_span_uses_full_canvas_and_own_view() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Span;
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert_eq!(
      url,
      "/#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=-2560,0,2560,1440"
    );
  }

  #[test]
  fn monitor_url_mirror_ignores_per_monitor_scene_override() {
    let mut config = WallpaperConfig::default();
    config.set_monitor_scene("\\\\.\\DISPLAY2", Some("lull.aurora".into()));
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(url.contains("mode=mirror"));
    assert!(url.contains("scene=lull.bamboo"));
  }

  #[test]
  fn monitor_url_independent_consumes_override() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.set_monitor_scene("\\\\.\\DISPLAY2", Some("lull.aurora".into()));
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(url.contains("mode=independent"));
    assert!(url.contains("scene=lull.aurora"));
    let primary = monitor_url(&config, &ok_infos(), 0).unwrap();
    assert!(primary.contains("scene=lull.bamboo"));
  }

  #[test]
  fn monitor_url_rejects_out_of_range_index() {
    let config = WallpaperConfig::default();
    assert!(monitor_url(&config, &ok_infos(), 5).is_err());
  }
}
