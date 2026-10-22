//! 窗口清单：窗口工厂的静态描述。
//!
//! 唯一事实源是仓库根目录的 `src/widgets/manifests/*.json`：`build.rs` 在构建期
//! 校验并生成 `$OUT_DIR/widget_specs.rs`，本文件只保留结构与查询函数。
//! TS 侧（`src/widgets/registry.ts`）读取同一批 JSON，不再手抄第二份尺寸。
//!
//! 首版只允许官方代码注册窗口：第三方内容包不能直接创建系统窗口。

/// 宿主 API 版本：注入到前端上下文的 `hostApi`，升级字段语义时递增。
pub const WIDGET_HOST_API: u32 = 1;

/// 一个窗口的静态描述。任务栏/最小化由全局偏好决定，不在这里重复。
pub struct WidgetSpec {
  /// 稳定标识，也是 `widget_open` 的参数值与窗口复用键。
  pub kind: &'static str,
  /// Tauri 窗口 label（capability 里按它授权）。
  pub label: &'static str,
  /// 前端路由（静态导出后的根路径，不带前导斜杠）。
  pub url: &'static str,
  pub title: &'static str,
  /// 设置页 / 托盘里的展示名（与 TS 清单的 `name` 一致）。
  pub name: &'static str,
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

include!(concat!(env!("OUT_DIR"), "/widget_specs.rs"));

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
  use serde_json::Value;

  const CAPABILITIES: [&str; 8] = [
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.media",
    "widget.chrome",
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

    let mut kinds: Vec<_> = ALL_WIDGETS.iter().map(|spec| spec.kind).collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds.len(), ALL_WIDGETS.len());
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
      assert!(!spec.name.is_empty(), "{}", spec.kind);
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

  #[test]
  fn tool_windows_declare_chrome_and_shell_keeps_window() {
    for spec in [&PLAYER, &POMODORO, &NOISE] {
      assert!(
        spec.capabilities.contains(&"widget.chrome"),
        "{} 缺少 chrome 能力",
        spec.kind
      );
      assert!(!spec.capabilities.contains(&"widget.window"));
    }
    assert!(SETTINGS.capabilities.contains(&"widget.window"));
  }

  /// 生成的静态描述必须与 JSON 清单逐字段一致：
  /// 防止 build.rs 漏字段、排序或解析错误，也防止有人绕过清单直接改生成文件。
  #[test]
  fn generated_specs_match_manifests() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/widgets/manifests");
    let entries = std::fs::read_dir(&dir).ok();
    assert!(entries.is_some(), "读取清单目录失败: {}", dir.display());
    let Some(entries) = entries else { return };

    let mut count = 0_usize;
    for entry in entries.filter_map(Result::ok) {
      let path = entry.path();
      if !path
        .extension()
        .is_some_and(|extension| extension == "json")
      {
        continue;
      }
      count += 1;
      let text = std::fs::read_to_string(&path).unwrap_or_default();
      assert!(!text.is_empty(), "清单为空: {}", path.display());
      let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
      let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
      let spec = find(id);
      assert!(spec.is_some(), "清单 {id} 没有对应的 WidgetSpec");
      let Some(spec) = spec else { continue };

      assert_eq!(
        spec.name,
        value
          .get("name")
          .and_then(Value::as_str)
          .unwrap_or_default(),
        "{id}.name 不一致"
      );
      assert_eq!(
        spec.version,
        value
          .get("version")
          .and_then(Value::as_str)
          .unwrap_or_default(),
        "{id}.version 不一致"
      );

      let capabilities: Vec<&str> = value
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
      assert_eq!(
        spec.capabilities,
        capabilities.as_slice(),
        "{id} 能力不一致"
      );

      let window = value.get("window").cloned().unwrap_or(Value::Null);
      assert_eq!(
        spec.label,
        window
          .get("label")
          .and_then(Value::as_str)
          .unwrap_or_default(),
        "{id}.window.label 不一致"
      );
      assert_eq!(
        spec.url,
        window
          .get("route")
          .and_then(Value::as_str)
          .unwrap_or_default(),
        "{id}.window.route 不一致"
      );
      assert_eq!(
        spec.title,
        window
          .get("title")
          .and_then(Value::as_str)
          .unwrap_or_default(),
        "{id}.window.title 不一致"
      );
      for (current, expected, field) in [
        (
          spec.width,
          window
            .get("width")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
          "width",
        ),
        (
          spec.height,
          window
            .get("height")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
          "height",
        ),
        (
          spec.min_width,
          window
            .get("minWidth")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
          "minWidth",
        ),
        (
          spec.min_height,
          window
            .get("minHeight")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
          "minHeight",
        ),
      ] {
        assert!(
          (current - expected).abs() < f64::EPSILON,
          "{id}.window.{field} 不一致: {current} != {expected}"
        );
      }
      assert_eq!(
        spec.resizable,
        window
          .get("resizable")
          .and_then(Value::as_bool)
          .unwrap_or_default(),
        "{id}.window.resizable 不一致"
      );
      assert_eq!(
        spec.transparent,
        window
          .get("transparent")
          .and_then(Value::as_bool)
          .unwrap_or_default(),
        "{id}.window.transparent 不一致"
      );
    }

    assert_eq!(count, ALL_WIDGETS.len(), "清单数量与生成的窗口数量不一致");
  }
}
