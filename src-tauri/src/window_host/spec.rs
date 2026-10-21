//! 内置窗口清单：窗口工厂的静态描述。
//!
//! 前端 `src/widgets/registry.ts` 是设置页的元数据来源；本文件是窗口创建参数的
//! 唯一权威。新增/修改工具窗时必须同时更新两处，并由两侧测试守护。
//!
//! 首版只允许官方代码注册窗口：第三方内容包不能直接创建系统窗口。

/// 一个窗口的静态描述。任务栏/最小化由全局偏好决定，不在这里重复。
pub struct WidgetSpec {
  /// 稳定标识，也是 `widget_open` 的参数值与窗口复用键。
  pub kind: &'static str,
  /// Tauri 窗口 label（capability 里按它授权）。
  pub label: &'static str,
  /// 前端路由（静态导出后的根路径，不带前导斜杠）。
  pub url: &'static str,
  pub title: &'static str,
  /// 初始内宽；高度只是贴合前的占位值，真正的窗口高度由前端按内容计算。
  pub width: f64,
  pub height: f64,
  pub min_width: f64,
  /// 最小内高；液态番茄钟的固定玻璃舱需要完整高度，其余窗口允许上下压缩。
  pub min_height: f64,
  /// 是否允许用户拖拽边缘缩放 / 最大化。沉浸式浮窗固定为 false。
  pub resizable: bool,
  /// 是否为透明 WebView：页面不铺底色，桌面内容从玻璃件之间透出。
  pub transparent: bool,
  /// Widget SDK 版本（与前端清单对齐）。
  pub version: &'static str,
  /// 首期内置工具声明的能力；第三方工具暂不获得 window/native 能力。
  pub capabilities: &'static [&'static str],
}

pub static SETTINGS: WidgetSpec = WidgetSpec {
  kind: "settings",
  label: "settings",
  url: "setting",
  title: "Lull 设置",
  width: 768.0,
  height: 600.0,
  min_width: 640.0,
  min_height: 320.0,
  resizable: true,
  transparent: false,
  version: "1.0.0",
  capabilities: &["widget.ui", "widget.window"],
};

pub static PLAYER: WidgetSpec = WidgetSpec {
  kind: "player",
  label: "player",
  url: "player",
  title: "Lull 播放器",
  // 液态黑胶浮窗：展开曲库 880×552，收起后前端把宽度收到 530。
  width: 880.0,
  height: 552.0,
  min_width: 500.0,
  min_height: 520.0,
  resizable: false,
  transparent: true,
  version: "1.0.0",
  capabilities: &[
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.media",
  ],
};

pub static POMODORO: WidgetSpec = WidgetSpec {
  kind: "pomodoro",
  label: "pomodoro",
  url: "pomodoro",
  title: "Lull 番茄钟",
  width: 600.0,
  height: 690.0,
  min_width: 560.0,
  min_height: 640.0,
  resizable: false,
  transparent: true,
  version: "1.0.0",
  capabilities: &["widget.ui", "widget.theme", "widget.state", "widget.audio"],
};

pub static NOISE: WidgetSpec = WidgetSpec {
  kind: "noise",
  label: "noise",
  url: "noise",
  title: "Lull 白噪音",
  width: 600.0,
  height: 420.0,
  min_width: 560.0,
  min_height: 320.0,
  resizable: false,
  transparent: true,
  version: "1.0.0",
  capabilities: &["widget.ui", "widget.theme", "widget.state", "widget.audio"],
};

pub static ALL_WIDGETS: [&WidgetSpec; 4] = [&SETTINGS, &PLAYER, &POMODORO, &NOISE];

/// 按 `kind` 找窗口描述（`widget_open` 命令用）。
pub fn find(kind: &str) -> Option<&'static WidgetSpec> {
  ALL_WIDGETS.iter().copied().find(|spec| spec.kind == kind)
}

/// 该 label 是否由本模块管理（用于「关闭即隐藏」与全局偏好的应用范围）。
pub fn is_managed(label: &str) -> bool {
  ALL_WIDGETS.iter().any(|spec| spec.label == label)
}

#[cfg(test)]
mod tests {
  use super::*;

  const CAPABILITIES: [&str; 7] = [
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.media",
    "widget.window",
    "widget.native",
  ];

  #[test]
  fn specs_have_unique_labels_and_urls() {
    let mut labels: Vec<_> = ALL_WIDGETS.iter().map(|spec| spec.label).collect();
    labels.sort_unstable();
    labels.dedup();
    assert_eq!(labels.len(), ALL_WIDGETS.len());

    let mut urls: Vec<_> = ALL_WIDGETS.iter().map(|spec| spec.url).collect();
    urls.sort_unstable();
    urls.dedup();
    assert_eq!(urls.len(), ALL_WIDGETS.len());
  }

  #[test]
  fn find_matches_kind_and_label_management() {
    assert_eq!(find("player").map(|spec| spec.label), Some("player"));
    assert!(find("nope").is_none());
    assert!(is_managed("settings"));
    assert!(is_managed("noise"));
    assert!(!is_managed("main"));
  }

  #[test]
  fn immersive_windows_are_fixed_size() {
    assert!(!PLAYER.resizable);
    assert!(!POMODORO.resizable);
    assert!(!NOISE.resizable);
    assert!(SETTINGS.resizable);
  }

  #[test]
  fn immersive_windows_are_transparent() {
    assert!(PLAYER.transparent);
    assert!(POMODORO.transparent);
    assert!(NOISE.transparent);
    assert!(!SETTINGS.transparent);
  }

  #[test]
  fn all_titles_carry_the_lull_brand() {
    for spec in ALL_WIDGETS {
      assert!(spec.title.starts_with("Lull "), "{}", spec.title);
      assert_eq!(spec.version, "1.0.0");
    }
  }

  #[test]
  fn declared_capabilities_are_known_and_non_empty() {
    for spec in ALL_WIDGETS {
      assert!(!spec.capabilities.is_empty());
      for capability in spec.capabilities {
        assert!(CAPABILITIES.contains(capability), "{capability}");
      }
    }
  }
}
