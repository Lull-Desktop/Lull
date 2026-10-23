//! 界面语言：系统语言探测、偏好持久化与消息查表。
//!
//! 为什么语言偏好归原生层管：托盘菜单在 `setup()` 里创建，早于任何 WebView 加载。
//! 只有 Rust 在启动时就把语言定下来，才能避免「托盘先出中文、界面随后变英文」的跳变。
//!
//! 消息源与前端 Paraglide 共用仓库根部的 `i18n/messages/*.json`（编译期 `include_str!`），
//! 键名拼错时回退到键名本身，并由 `scripts/i18n-check.mjs` 在 CI 里兜底。
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use tauri::{AppHandle, Emitter, Manager};

/// 基准语言：缺译时的回退目标，必须始终存在且完整。
pub const BASE_LOCALE: &str = "zh-CN";
/// 受支持的语言，顺序即设置页展示顺序。
pub const SUPPORTED: [&str; 2] = ["zh-CN", "en-US"];
/// 语言变更广播；所有已开窗口据此就地换语言（不重载文档）。
pub const CHANGED_EVENT: &str = "i18n-locale-changed";
/// 「跟随系统」在命令参数里的表示。
pub const SYSTEM_PREFERENCE: &str = "system";

const FILE_NAME: &str = "preferences.json";
const VERSION: u32 = 1;

/// 编译期嵌入的消息表：与前端同一份源，避免两边各写一套文案。
///
/// 新增语言时这里要同步加一行（数组长度是类型的一部分，编译期强制）。
const SOURCES: [(&str, &str); 2] = [
  (
    "zh-CN",
    include_str!("../../../i18n/messages/zh-CN.json"),
  ),
  (
    "en-US",
    include_str!("../../../i18n/messages/en-US.json"),
  ),
];

/// 语言偏好。`explicit = false` 表示跟随系统，每次启动重新探测。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Preferences {
  pub version: u32,
  pub locale: String,
  pub explicit: bool,
}

impl Preferences {
  fn of(locale: &str, explicit: bool) -> Self {
    Self {
      version: VERSION,
      locale: locale.to_string(),
      explicit,
    }
  }
}

/// 前端拿到的语言状态（`i18n_boot` / `i18n_set_locale` 的返回）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LocaleState {
  pub locale: String,
  pub supported: Vec<String>,
  pub explicit: bool,
}

impl LocaleState {
  fn of(locale: &str, explicit: bool) -> Self {
    Self {
      locale: locale.to_string(),
      supported: SUPPORTED.iter().map(|item| (*item).to_string()).collect(),
      explicit,
    }
  }
}

static CURRENT: OnceLock<RwLock<String>> = OnceLock::new();
static CATALOG: OnceLock<HashMap<&'static str, HashMap<String, String>>> = OnceLock::new();

fn cell() -> &'static RwLock<String> {
  CURRENT.get_or_init(|| RwLock::new(BASE_LOCALE.to_string()))
}

/// 把外部输入收敛到受支持的语言。
///
/// 目前只提供简体中文与英文：所有 `zh` 变体（含繁体）统一落到 `zh-CN`，
/// 繁体用户看到简体，而不是被丢回英文。重新引入繁体时，在这里恢复字形判断
/// （`zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` 必须先于宽泛的 `zh`）。
/// 前端 `normalizeLocale` 是同一套规则。
#[must_use]
pub fn normalize(input: &str) -> Option<String> {
  let text = input.trim();
  if text.is_empty() {
    return None;
  }
  if let Some(hit) = SUPPORTED.iter().find(|item| **item == text) {
    return Some((*hit).to_string());
  }

  let lower = text.to_ascii_lowercase();
  if lower.starts_with("zh") {
    return Some("zh-CN".to_string());
  }
  if lower.starts_with("en") {
    return Some("en-US".to_string());
  }
  None
}

/// 解析生效语言：显式选择优先，其次系统语言，最后回退基准语言。
///
/// 返回 `(locale, explicit)`；`explicit = false` 表示这次是由系统 / 回退决定。
#[must_use]
pub fn resolve_locale(pref: Option<&Preferences>, os: Option<&str>) -> (String, bool) {
  let from_os = || {
    os.and_then(normalize)
      .unwrap_or_else(|| BASE_LOCALE.to_string())
  };

  match pref {
    Some(pref) if pref.explicit => match normalize(&pref.locale) {
      Some(locale) => (locale, true),
      None => (from_os(), false),
    },
    _ => (from_os(), false),
  }
}

fn catalog() -> &'static HashMap<&'static str, HashMap<String, String>> {
  CATALOG.get_or_init(|| {
    SOURCES
      .iter()
      .map(|(locale, raw)| {
        let parsed = serde_json::from_str::<HashMap<String, serde_json::Value>>(raw)
          .unwrap_or_default()
          .into_iter()
          .filter(|(key, _)| !key.starts_with('$'))
          .filter_map(|(key, value)| {
            value
              .as_str()
              .map(|text| (key, text.to_string()))
          })
          .collect::<HashMap<String, String>>();
        (*locale, parsed)
      })
      .collect()
  })
}

/// 当前语言（未初始化时返回基准语言）。
#[must_use]
pub fn current() -> String {
  match cell().read() {
    Ok(guard) => guard.clone(),
    Err(_) => BASE_LOCALE.to_string(),
  }
}

fn set_current(locale: &str) {
  if let Ok(mut guard) = cell().write() {
    *guard = locale.to_string();
  }
}

/// 查表：当前语言 → 基准语言 → 键名本身。
#[must_use]
pub fn t(key: &str) -> String {
  let table = catalog();
  let locale = current();
  table
    .get(locale.as_str())
    .and_then(|messages| messages.get(key))
    .or_else(|| {
      table
        .get(BASE_LOCALE)
        .and_then(|messages| messages.get(key))
    })
    .cloned()
    .unwrap_or_else(|| key.to_string())
}

/// 带 `{name}` 占位符的查表。
#[must_use]
pub fn t_args(key: &str, args: &[(&str, &str)]) -> String {
  let mut text = t(key);
  for (name, value) in args {
    text = text.replace(&format!("{{{name}}}"), value);
  }
  text
}

fn path(app: &AppHandle) -> PathBuf {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join(FILE_NAME))
    .unwrap_or_else(|_| PathBuf::from(FILE_NAME))
}

/// 读取偏好；缺失 / 版本不符 / 损坏都当作「没有偏好」，不阻塞启动。
fn stored(app: &AppHandle) -> Option<Preferences> {
  let text = std::fs::read_to_string(path(app)).ok()?;
  let pref = serde_json::from_str::<Preferences>(&text).ok()?;
  if pref.version == VERSION {
    Some(pref)
  } else {
    eprintln!(
      "[i18n] 语言偏好版本 {} 与当前 {VERSION} 不符，按未设置处理",
      pref.version
    );
    None
  }
}

fn save(app: &AppHandle, pref: &Preferences) -> Result<(), String> {
  let path = path(app);
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_string_pretty(pref).map_err(|error| error.to_string())?;
  std::fs::write(path, json).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn os_locale() -> Option<String> {
  use windows::Win32::Globalization::GetUserDefaultLocaleName;

  // LOCALE_NAME_MAX_LENGTH 为 85，含结尾 NUL。
  let mut buffer = [0u16; 85];
  let written = unsafe { GetUserDefaultLocaleName(&mut buffer) };
  if written <= 1 {
    return None;
  }
  let end = usize::try_from(written - 1).ok()?.min(buffer.len());
  Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(not(windows))]
fn os_locale() -> Option<String> {
  None
}

/// 启动时初始化：解析语言 → 写入内存 → 首启 / 变更时落盘。
pub fn init(app: &AppHandle) {
  let pref = stored(app);
  let detected = os_locale();
  let (locale, explicit) = resolve_locale(pref.as_ref(), detected.as_deref());
  set_current(&locale);

  let desired = Preferences::of(&locale, explicit);
  if pref.as_ref() != Some(&desired) {
    if let Err(error) = save(app, &desired) {
      eprintln!("[i18n] 写入语言偏好失败：{error}");
    }
  }
  println!("[i18n] 当前语言 {locale}（explicit = {explicit}）");
}

/// 语言变更后的联动：广播给所有窗口 + 重建托盘菜单。
fn apply(app: &AppHandle, state: &LocaleState) {
  let _ = app.emit(CHANGED_EVENT, state);
  crate::tray::refresh(app);
}

#[tauri::command]
#[must_use]
pub fn i18n_boot(app: AppHandle) -> LocaleState {
  let pref = stored(&app);
  let (locale, explicit) = resolve_locale(pref.as_ref(), os_locale().as_deref());
  set_current(&locale);
  LocaleState::of(&locale, explicit)
}

/// 切换语言。`locale` 传 `"system"` 表示跟随系统。
#[tauri::command]
pub fn i18n_set_locale(app: AppHandle, locale: String) -> Result<LocaleState, String> {
  if locale == SYSTEM_PREFERENCE {
    let detected = os_locale();
    let (resolved, _) = resolve_locale(None, detected.as_deref());
    let pref = Preferences::of(&resolved, false);
    save(&app, &pref)?;
    set_current(&resolved);
    let state = LocaleState::of(&resolved, false);
    apply(&app, &state);
    return Ok(state);
  }

  let Some(normalized) = normalize(&locale) else {
    return Err(t_args("settings_language_unsupported", &[("locale", &locale)]));
  };

  let pref = Preferences::of(&normalized, true);
  save(&app, &pref)?;
  set_current(&normalized);
  let state = LocaleState::of(&normalized, true);
  apply(&app, &state);
  Ok(state)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn catalog_has_same_keys_in_every_locale() {
    let table = catalog();
    let base = table
      .get(BASE_LOCALE)
      .unwrap_or_else(|| panic!("缺少基准语言 {BASE_LOCALE}"));
    assert!(!base.is_empty(), "基准语言消息为空");

    for (locale, messages) in table {
      assert_eq!(
        messages.len(),
        base.len(),
        "{locale} 的消息数量与基准语言不一致"
      );
      for key in base.keys() {
        assert!(messages.contains_key(key), "{locale} 缺少消息 {key}");
      }
    }
  }

  #[test]
  fn every_key_has_non_empty_text() {
    for (locale, messages) in catalog() {
      for (key, value) in messages {
        assert!(!value.trim().is_empty(), "{locale}:{key} 为空");
      }
    }
  }

  #[test]
  fn placeholder_sets_match_across_locales() {
    fn placeholders(text: &str) -> Vec<&str> {
      let mut found = Vec::new();
      let mut rest = text;
      while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
          break;
        };
        let name = &rest[start + 1..start + len];
        if !name.contains(' ') && !name.contains(',') {
          found.push(name);
        }
        rest = &rest[start + len + 1..];
      }
      found.sort_unstable();
      found
    }

    let table = catalog();
    let base = table
      .get(BASE_LOCALE)
      .unwrap_or_else(|| panic!("缺少基准语言 {BASE_LOCALE}"));
    for (key, text) in base {
      let expected = placeholders(text);
      for (locale, messages) in table {
        if *locale == BASE_LOCALE {
          continue;
        }
        let actual = placeholders(messages.get(key).map_or("", String::as_str));
        assert_eq!(actual, expected, "{locale}:{key} 的占位符与基准语言不一致");
      }
    }
  }

  #[test]
  fn normalize_maps_regions_and_scripts() {
    assert_eq!(normalize("zh-CN").as_deref(), Some("zh-CN"));
    assert_eq!(normalize("zh").as_deref(), Some("zh-CN"));
    assert_eq!(normalize("zh-Hans-CN").as_deref(), Some("zh-CN"));
    // 目前不提供繁体：繁体系统回落到简体，而不是英文。
    assert_eq!(normalize("zh-TW").as_deref(), Some("zh-CN"));
    assert_eq!(normalize("zh-Hant").as_deref(), Some("zh-CN"));
    assert_eq!(normalize("zh-HK").as_deref(), Some("zh-CN"));
    assert_eq!(normalize("en-GB").as_deref(), Some("en-US"));
    assert_eq!(normalize("ja-JP"), None);
    assert_eq!(normalize("  "), None);
  }

  #[test]
  fn resolve_prefers_explicit_then_system_then_base() {
    let explicit = Preferences::of("zh-CN", true);
    assert_eq!(
      resolve_locale(Some(&explicit), Some("en-US")),
      ("zh-CN".to_string(), true)
    );

    let system = Preferences::of("zh-CN", false);
    assert_eq!(
      resolve_locale(Some(&system), Some("en-US")),
      ("en-US".to_string(), false)
    );

    assert_eq!(
      resolve_locale(None, Some("de-DE")),
      (BASE_LOCALE.to_string(), false)
    );
    assert_eq!(resolve_locale(None, None), (BASE_LOCALE.to_string(), false));

    let broken = Preferences::of("ja-JP", true);
    assert_eq!(
      resolve_locale(Some(&broken), Some("en-US")),
      ("en-US".to_string(), false)
    );
  }

  #[test]
  fn t_falls_back_to_key_when_missing() {
    set_current(BASE_LOCALE);
    let text = t("settings_about_title");
    assert!(!text.is_empty());
    assert_ne!(text, "settings_about_title");
    assert_eq!(t("__missing_key__"), "__missing_key__");
  }

  #[test]
  fn t_args_replaces_named_placeholders() {
    set_current("en-US");
    let text = t_args("settings_language_effective", &[("locale", "English")]);
    assert!(text.contains("English"), "实际：{text}");
    assert!(!text.contains("{locale}"));
    set_current(BASE_LOCALE);
  }
}
