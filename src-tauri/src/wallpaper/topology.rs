//! 显示器拓扑：解析原生枚举结果、计算虚拟桌面几何、筛出需要建窗的目标。
//!
//! 原生枚举下标就是 attach 的 `monitor_index`。任何解析失败都必须保留占位，
//! 不能让后续显示器的下标前移。

use super::ffi::{self, NativeHost};
use crate::config::WallpaperConfig;

/// 一台显示器的 native 侧信息（`lull_native_monitor_info` 的解析结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MonitorInfo {
  pub(crate) device: String,
  pub(crate) x: i32,
  pub(crate) y: i32,
  pub(crate) w: i32,
  pub(crate) h: i32,
  pub(crate) dpi: u32,
  pub(crate) primary: bool,
}

/// 解析 native 单行 k=v 输出：
/// `device=\\.\DISPLAY1 x=0 y=0 w=1920 h=1080 dpi=96 primary=1`。
fn parse_monitor_info(line: &str) -> Result<MonitorInfo, String> {
  let fields: std::collections::HashMap<&str, &str> = line
    .split_whitespace()
    .filter_map(|token| token.split_once('='))
    .collect();
  let num_i32 = |key: &str| -> Result<i32, String> {
    fields
      .get(key)
      .ok_or_else(|| format!("缺少字段 {key}"))?
      .parse()
      .map_err(|error| format!("{key} 解析失败: {error}"))
  };
  let device = fields
    .get("device")
    .ok_or_else(|| "缺少字段 device".to_string())?;
  let dpi = fields
    .get("dpi")
    .ok_or_else(|| "缺少字段 dpi".to_string())?
    .parse::<u32>()
    .map_err(|error| format!("dpi 解析失败: {error}"))?;
  let primary = match fields.get("primary") {
    Some(&"1") => true,
    Some(&"0") => false,
    _ => return Err("primary 缺失或非法".to_string()),
  };
  Ok(MonitorInfo {
    device: (*device).to_string(),
    x: num_i32("x")?,
    y: num_i32("y")?,
    w: num_i32("w")?,
    h: num_i32("h")?,
    dpi,
    primary,
  })
}

/// 虚拟桌面包围盒（x, y, w, h）：全部显示器矩形并集（物理桌面坐标，原点可为负）。
pub(crate) fn virtual_bounds(infos: &[MonitorInfo]) -> Option<(i32, i32, i32, i32)> {
  let mut iter = infos.iter();
  let first = iter.next()?;
  let mut left = first.x;
  let mut top = first.y;
  let mut right = first.x + first.w;
  let mut bottom = first.y + first.h;
  for monitor in iter {
    left = left.min(monitor.x);
    top = top.min(monitor.y);
    right = right.max(monitor.x + monitor.w);
    bottom = bottom.max(monitor.y + monitor.h);
  }
  Some((left, top, right - left, bottom - top))
}

pub(crate) fn virtual_bounds_from(
  infos: &[Result<MonitorInfo, String>],
) -> Option<(i32, i32, i32, i32)> {
  let valid: Vec<MonitorInfo> = infos
    .iter()
    .filter_map(|result| result.as_ref().ok().cloned())
    .collect();
  virtual_bounds(&valid)
}

/// native 枚举的当前显示器列表；下标 = attach 的 monitor_index 序。
/// 单项解析失败返回 Err —— **保留位置**，不能让下标错位。
pub(crate) fn monitor_infos(host: &NativeHost) -> Vec<Result<MonitorInfo, String>> {
  let count = unsafe { (host.monitor_count)() }.max(0);
  (0..count)
    .map(|index| {
      let mut buf = [0u8; 256];
      let rc = unsafe { (host.monitor_info)(index, buf.as_mut_ptr(), buf.len() as i32) };
      if rc != 0 {
        return Err(format!("monitor_info({index}) rc={rc}"));
      }
      let n = buf.iter().position(|&byte| byte == 0).unwrap_or(buf.len());
      parse_monitor_info(&String::from_utf8_lossy(&buf[..n]))
    })
    .collect()
}

/// 按配置筛出要建窗的显示器：(native 枚举序 index, 设备名, 物理宽高)。
/// 枚举失败的项记日志并跳过，但保留成功项的原始下标。
pub(crate) fn enabled_display_targets(
  config: &WallpaperConfig,
  infos: &[Result<MonitorInfo, String>],
) -> Vec<(usize, String, (u32, u32))> {
  infos
    .iter()
    .enumerate()
    .filter_map(|(index, result)| match result {
      Ok(monitor) if config.monitor_enabled(&monitor.device) => Some((
        index,
        monitor.device.clone(),
        (
          u32::try_from(monitor.w).unwrap_or(1920),
          u32::try_from(monitor.h).unwrap_or(1080),
        ),
      )),
      Ok(_) => None,
      Err(error) => {
        ffi::wlog(&format!("显示器 {index} 枚举失败: {error}"));
        None
      }
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn info(device: &str, x: i32, y: i32, w: i32, h: i32, dpi: u32, primary: bool) -> MonitorInfo {
    MonitorInfo {
      device: device.into(),
      x,
      y,
      w,
      h,
      dpi,
      primary,
    }
  }

  fn ok_infos() -> Vec<Result<MonitorInfo, String>> {
    vec![
      Ok(info("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 96, true)),
      Ok(info("\\\\.\\DISPLAY2", -2560, 0, 2560, 1440, 120, false)),
    ]
  }

  #[test]
  fn parses_full_monitor_info_line() {
    let line = "device=\\\\.\\DISPLAY1 x=0 y=-360 w=1920 h=1080 dpi=96 primary=1";
    let parsed = parse_monitor_info(line).unwrap();
    assert_eq!(
      parsed,
      info("\\\\.\\DISPLAY1", 0, -360, 1920, 1080, 96, true)
    );
  }

  #[test]
  fn primary_zero_parses_false() {
    let line = "device=\\\\.\\DISPLAY2 x=1920 y=0 w=2560 h=1440 dpi=120 primary=0";
    let parsed = parse_monitor_info(line).unwrap();
    assert!(!parsed.primary);
    assert_eq!(parsed.dpi, 120);
  }

  #[test]
  fn rejects_line_with_missing_field() {
    let line = "device=\\\\.\\DISPLAY1 x=0 y=0 h=1080 dpi=96 primary=1"; // 缺 w
    assert!(parse_monitor_info(line).is_err());
  }

  #[test]
  fn rejects_line_with_bad_number() {
    let line = "device=\\\\.\\DISPLAY1 x=0 y=0 w=abc h=1080 dpi=96 primary=1";
    assert!(parse_monitor_info(line).is_err());
  }

  #[test]
  fn virtual_bounds_unions_real_shaped_monitors() {
    let infos = vec![
      info("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 96, true),
      info("\\\\.\\DISPLAY2", -2560, 0, 2560, 1440, 120, false),
    ];
    assert_eq!(virtual_bounds(&infos), Some((-2560, 0, 4480, 1440)));
    assert_eq!(virtual_bounds(&infos[..1]), Some((0, 0, 1920, 1080)));
    assert_eq!(virtual_bounds(&[]), None);
  }

  #[test]
  fn enabled_targets_default_to_all_monitors() {
    let config = WallpaperConfig::default();
    let targets = enabled_display_targets(&config, &ok_infos());
    assert_eq!(targets.len(), 2);
    assert_eq!(
      (targets[0].0, targets[0].1.as_str()),
      (0, "\\\\.\\DISPLAY1")
    );
    assert_eq!(
      (targets[1].0, targets[1].1.as_str()),
      (1, "\\\\.\\DISPLAY2")
    );
    assert_eq!(targets[1].2, (2560, 1440));
  }

  #[test]
  fn enabled_targets_skip_disabled_and_failed_but_keep_native_index() {
    let mut config = WallpaperConfig::default();
    config.set_monitor_enabled("\\\\.\\DISPLAY1", false);
    let mut infos = ok_infos();
    infos.insert(0, Err("枚举失败".into()));

    let targets = enabled_display_targets(&config, &infos);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].0, 2, "失败的枚举项必须继续占位，index 不能前移");
    assert_eq!(targets[0].1, "\\\\.\\DISPLAY2");
    assert_eq!(targets[0].2, (2560, 1440));
  }
}
