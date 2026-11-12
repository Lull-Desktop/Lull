//! 壁纸 URL 协议：把显示模式、场景与几何编码进前端 hash。
//!
//! 该协议是 Rust 与 WebView 之间唯一的画面契约；参数必须是纯函数可测的，
//! 不能依赖窗口或原生状态。

use std::collections::BTreeMap;

use super::topology::{virtual_bounds_from, MonitorInfo};
use crate::config::{DisplayMode, WallpaperConfig};

fn encode_uri_component(input: &str) -> String {
  const HEX: &[u8; 16] = b"0123456789ABCDEF";
  // 场景参数可以携带较大的文本（例如着色器源码）；逐字节 `format!` 会为每个
  // 被编码字节分配一个 String，这里改成查表 push，输出保持与旧实现逐字节一致。
  let mut out = String::with_capacity(input.len());
  for &byte in input.as_bytes() {
    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
      out.push(byte as char);
    } else {
      out.push('%');
      out.push(HEX[(byte >> 4) as usize] as char);
      out.push(HEX[(byte & 0x0f) as usize] as char);
    }
  }
  out
}

/// 壁纸窗参数哈希。canvas/view 为物理像素桌面坐标，可为负。
pub(crate) fn wallpaper_hash(
  mode: DisplayMode,
  sync: bool,
  scene: &str,
  game: Option<&str>,
  canvas: (i32, i32, i32, i32),
  view: (i32, i32, i32, i32),
  params: &BTreeMap<String, String>,
) -> String {
  let mode = match mode {
    DisplayMode::Mirror => "mirror",
    DisplayMode::Independent => "independent",
    DisplayMode::Span => "span",
  };
  let mut hash = format!(
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
  );
  // `game` 与 `scene` 是两个独立参数：前端只在 game 非空时走游戏 replica 宿主，
  // 清空游戏后直接用同一份 hash 回退到 scene，不需要重载页面。
  if let Some(game) = game {
    hash.push_str("&game=");
    hash.push_str(&encode_uri_component(game));
  }
  if !params.is_empty() {
    if let Ok(json) = serde_json::to_string(params) {
      hash.push_str("&params=");
      hash.push_str(&encode_uri_component(&json));
    }
  }
  hash
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
  // 唯一事实源：媒体生命周期判断“这屏还在不在视频”也用 effective_scene。
  let scene = config.effective_scene(&monitor.device);
  let game = config.effective_game(&monitor.device);
  // 参数与场景同源解析：independent 下每屏覆盖优先，两屏同场景也各自独立。
  let params = config.effective_params(&monitor.device);
  Ok(format!(
    "/{}",
    wallpaper_hash(
      config.display.mode,
      config.display.sync,
      &scene,
      game.as_deref(),
      canvas,
      (monitor.x, monitor.y, monitor.w, monitor.h),
      &params,
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
      None,
      (-2560, 0, 4480, 1440),
      (0, 0, 1920, 1080),
      &BTreeMap::new(),
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
      None,
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
      &BTreeMap::new(),
    );
    assert_eq!(
      hash,
      "#mode=mirror&sync=0&scene=lull.aurora&canvas=0,0,1920,1080&view=0,0,1920,1080"
    );
    let independent = wallpaper_hash(
      DisplayMode::Independent,
      true,
      "lull.bamboo",
      None,
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
      &BTreeMap::new(),
    );
    assert!(independent.starts_with("#mode=independent&sync=1&scene=lull.bamboo&"));
  }

  #[test]
  fn uri_component_encoding_matches_js_semantics() {
    assert_eq!(encode_uri_component("a b\"c\nd"), "a%20b%22c%0Ad");
    assert_eq!(encode_uri_component("-_.~AZ09"), "-_.~AZ09");
    // 非 ASCII 按 UTF-8 逐字节百分号编码。
    assert_eq!(encode_uri_component("着色"), "%E7%9D%80%E8%89%B2");
  }

  /// 着色器源码是常规参数（128 KiB 上限）；这里确认编码后的哈希仍远低于
  /// Chromium 的 URL 上限（约 2 MB），且走的是同一条纯函数链路。
  #[test]
  fn wallpaper_hash_keeps_large_text_params_within_url_budget() {
    let mut params = BTreeMap::new();
    params.insert("source".to_string(), "x".repeat(128 * 1024));
    let hash = wallpaper_hash(
      DisplayMode::Mirror,
      true,
      "lull.shadertoy-wallpaper",
      None,
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
      &params,
    );
    assert!(hash.contains("scene=lull.shadertoy-wallpaper"));
    assert!(hash.len() > 128 * 1024);
    assert!(hash.len() < 2 * 1024 * 1024);
  }

  #[test]
  fn wallpaper_hash_encodes_scene_params_only_when_non_empty() {
    let mut params = BTreeMap::new();
    params.insert("density".to_string(), "0.6".to_string());
    params.insert("tone".to_string(), "warm".to_string());
    let hash = wallpaper_hash(
      DisplayMode::Mirror,
      true,
      "lull.bamboo",
      None,
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
      &params,
    );
    assert!(hash.ends_with("&params=%7B%22density%22%3A%220.6%22%2C%22tone%22%3A%22warm%22%7D"));
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
  fn wallpaper_hash_carries_game_alongside_scene() {
    let hash = wallpaper_hash(
      DisplayMode::Mirror,
      true,
      "lull.bamboo",
      Some("community.stability-probe"),
      (0, 0, 1920, 1080),
      (0, 0, 1920, 1080),
      &BTreeMap::new(),
    );
    assert!(hash.contains("scene=lull.bamboo"));
    assert!(hash.contains("&game=community.stability-probe"));
    assert!(hash.contains("mode=mirror"));
  }

  #[test]
  fn monitor_url_independent_prefers_monitor_game() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.display.scene = "lull.aurora".into();
    config.set_monitor_scene("\\\\.\\DISPLAY2", Some("lull.video".into()));
    config.set_monitor_game("\\\\.\\DISPLAY2", Some("community.local".into()));
    config.display.set_game(Some("community.global".into()));
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(url.contains("game=community.local"));
    assert!(url.contains("scene=lull.video"));
  }

  #[test]
  fn monitor_url_independent_scene_override_suppresses_global_game() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.set_monitor_scene("\\\\.\\DISPLAY2", Some("lull.video".into()));
    config.display.set_game(Some("community.global".into()));
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(!url.contains("game="));
    assert!(url.contains("scene=lull.video"));
  }

  #[test]
  fn monitor_url_mirror_ignores_monitor_game() {
    let mut config = WallpaperConfig::default();
    config.set_monitor_game("\\\\.\\DISPLAY2", Some("community.local".into()));
    config.display.set_game(Some("community.global".into()));
    let url = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(url.contains("game=community.global"));
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
  fn monitor_url_independent_same_scene_uses_per_monitor_params() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.8".to_string())]),
    );
    // 两屏同场景：各写各的参数覆盖，URL 必须不同。
    config.set_monitor_scene_params(
      "\\\\.\\DISPLAY1",
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.2".to_string())]),
    );
    config.set_monitor_scene_params(
      "\\\\.\\DISPLAY2",
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.5".to_string())]),
    );
    let primary = monitor_url(&config, &ok_infos(), 0).unwrap();
    let secondary = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(primary.contains("params=%7B%22mist%22%3A%220.2%22%7D"));
    assert!(secondary.contains("params=%7B%22mist%22%3A%220.5%22%7D"));
    assert_ne!(primary, secondary);
  }

  #[test]
  fn monitor_url_independent_params_fall_back_to_global_without_override() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.8".to_string())]),
    );
    config.set_monitor_scene_params(
      "\\\\.\\DISPLAY1",
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.2".to_string())]),
    );
    let secondary = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(secondary.contains("params=%7B%22mist%22%3A%220.8%22%7D"));
  }

  #[test]
  fn monitor_url_independent_empty_override_omits_params() {
    let mut config = WallpaperConfig::default();
    config.display.mode = DisplayMode::Independent;
    config.display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.8".to_string())]),
    );
    // 空覆盖 = 显式 Manifest 默认值：哈希不带 params，而不是回退全局。
    config.set_monitor_scene_params("\\\\.\\DISPLAY2", "lull.bamboo", BTreeMap::new());
    let secondary = monitor_url(&config, &ok_infos(), 1).unwrap();
    assert!(!secondary.contains("params="));
    let primary = monitor_url(&config, &ok_infos(), 0).unwrap();
    assert!(primary.contains("params=%7B%22mist%22%3A%220.8%22%7D"));
  }

  #[test]
  fn monitor_url_mirror_ignores_per_monitor_params() {
    let mut config = WallpaperConfig::default();
    config.display.set_scene_params(
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.8".to_string())]),
    );
    config.set_monitor_scene_params(
      "\\\\.\\DISPLAY1",
      "lull.bamboo",
      BTreeMap::from([("mist".to_string(), "0.2".to_string())]),
    );
    let primary = monitor_url(&config, &ok_infos(), 0).unwrap();
    assert!(primary.contains("mode=mirror"));
    assert!(primary.contains("params=%7B%22mist%22%3A%220.8%22%7D"));
  }

  #[test]
  fn monitor_url_rejects_out_of_range_index() {
    let config = WallpaperConfig::default();
    assert!(monitor_url(&config, &ok_infos(), 5).is_err());
  }
}
