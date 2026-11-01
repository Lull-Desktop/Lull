//! 插件包发现、授权记录与按插件隔离的状态 KV。

use super::digest;
use super::manifest::{PackageManifest, WindowSpec, HOST_API};
use super::official::{self, OfficialPackage};
use crate::content_trust::{
  verify_installed, PackageClaim, PackageKind, SignatureDecision, SignatureInfo, TrustPolicy,
};
use crate::extension::install;
use crate::extension::ExtensionError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const GRANTS_FILE: &str = ".grants.json";
const STATE_DIR: &str = ".state";
const STATE_VERSION: u32 = 1;
const GRANTS_VERSION: u32 = 1;
const MAX_STATE_BYTES: usize = 256 * 1024;
const MAX_VALUE_BYTES: usize = 32 * 1024;
const MAX_KEY_LEN: usize = 64;

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageWindow {
  pub width: f64,
  pub height: f64,
  pub min_width: f64,
  pub min_height: f64,
  pub resizable: bool,
  pub transparent: bool,
  pub chrome: String,
}

impl From<&WindowSpec> for PackageWindow {
  fn from(window: &WindowSpec) -> Self {
    Self {
      width: window.width,
      height: window.height,
      min_width: window.min_width(),
      min_height: window.min_height(),
      resizable: window.resizable,
      transparent: window.transparent,
      chrome: window.chrome.clone(),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: Option<String>,
  pub author: Option<String>,
  pub license: Option<String>,
  /// `ready` / `invalid` / `tampered`
  pub status: String,
  pub error: Option<String>,
  pub requested: Vec<String>,
  pub granted: Vec<String>,
  pub enabled: bool,
  pub running: bool,
  pub verified: bool,
  /// `declared` / `computed` / `none`
  pub integrity: String,
  /// 社区发布者签名状态；与摘要校验是两条独立的链。
  pub signature: SignatureInfo,
  pub tampered: bool,
  pub review_required: bool,
  pub dev: bool,
  /// `user` / `dev` / `bundled`
  pub origin: String,
  pub window: PackageWindow,
  pub lifecycle: String,
  pub network: Vec<String>,
  pub entry_url: String,
  pub host_api: u32,
  /// 托盘 / 扩展中心排序权重；旧包缺省 100。
  pub order: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct GrantRecord {
  #[serde(default)]
  enabled: bool,
  #[serde(default)]
  granted: Vec<String>,
  /// 启用时的 `widget.json` 哈希；缺失表示旧记录，首次启用时补齐。
  #[serde(default)]
  manifest_hash: Option<String>,
  /// 上次协调时清单声明的能力；用于区分「用户撤销」与「新版本新增」。
  #[serde(default)]
  declared: Vec<String>,
  /// `bundled`（随包分发，由启动协调维护）或 `user`（旧记录缺省）。
  #[serde(default)]
  source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GrantsFile {
  #[serde(default = "grants_version")]
  version: u32,
  #[serde(default)]
  widgets: BTreeMap<String, GrantRecord>,
}

impl Default for GrantsFile {
  fn default() -> Self {
    Self {
      version: GRANTS_VERSION,
      widgets: BTreeMap::new(),
    }
  }
}

fn grants_version() -> u32 {
  GRANTS_VERSION
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StateFile {
  #[serde(default = "state_version")]
  version: u32,
  #[serde(default)]
  values: BTreeMap<String, Value>,
}

impl Default for StateFile {
  fn default() -> Self {
    Self {
      version: STATE_VERSION,
      values: BTreeMap::new(),
    }
  }
}

fn state_version() -> u32 {
  STATE_VERSION
}

/// 插件根目录：`LULL_WIDGETS_DIR` 优先（开发/测试），否则 app_data_dir/widgets。
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("LULL_WIDGETS_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("widgets"))
    .map_err(|error| error.to_string())
}

pub fn package_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(root(app)?.join(id))
}

pub fn entry_url(id: &str, entry: &str) -> String {
  #[cfg(windows)]
  let origin = "http://lullwidget.localhost";
  #[cfg(not(windows))]
  let origin = "lullwidget://localhost";
  format!("{origin}/{id}/{entry}")
}

/// 实际注入 iframe 的地址：开发模式挂载且声明了 `.lull-dev.json` 时用 dev server，
/// 否则回落到包内相对入口。dev URL 只在 debug 构建生效。
pub fn effective_entry_url(app: &AppHandle, id: &str, entry: &str) -> String {
  if let Some(url) = crate::extension::dev::entry_url(app, id) {
    return url;
  }
  entry_url(id, entry)
}

pub fn resolve_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if let Some(dir) = crate::extension::dev::resolve(app, id) {
    return Ok(dir);
  }
  if let Some(dir) = official::resolve(app, id) {
    return Ok(dir);
  }
  package_dir(app, id)
}

/// 是否由开发模式挂载（关闭开发模式后不算，即使配置里仍保留挂载记录）。
fn is_dev_mounted(app: &AppHandle, id: &str) -> bool {
  crate::extension::dev::enabled(app) && crate::extension::dev::contains(app, id)
}

/// 当前解析到的是否为官方包；开发包 shadow 时返回 `false`。
pub fn is_official(app: &AppHandle, id: &str) -> bool {
  !is_dev_mounted(app, id) && official::resolve(app, id).is_some()
}

/// 读取清单：正式包要求目录名与 id 一致；开发包目录名可任意，但清单 id 必须匹配。
pub fn load_manifest(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let dir = resolve_dir(app, id)?;
  let manifest = if crate::extension::dev::contains(app, id) {
    PackageManifest::from_dir(&dir)?
  } else {
    PackageManifest::load(&dir, id)?
  };
  if manifest.id != id {
    return Err(format!("清单 id={} 与请求 id={id} 不一致", manifest.id));
  }
  Ok(manifest)
}

pub fn find(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  load_manifest(app, id)
}

/// 打开/启用前复核摘要：有锁且不匹配就阻止加载。
pub fn ensure_package(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let dir = resolve_dir(app, id)?;
  let manifest = load_manifest(app, id)?;
  let dev_package = is_dev_mounted(app, id);
  let official_package = !dev_package && official::resolve(app, id).is_some();
  // 开发包的文件本来就会被反复修改，不参与摘要锁/签名校验。
  if !dev_package {
    match digest::check(&dir, &manifest.id, &manifest.version) {
      Ok(Some(_)) => {}
      Ok(None) if official_package => {
        return Err(format!("官方扩展缺少摘要锁，已阻止加载：{}", dir.display()));
      }
      Ok(None) => {}
      Err(error) => return Err(format!("内容包摘要不匹配，已阻止加载：{error}")),
    }
    // 官方包由安装包承载分发信任，不参与社区发布者签名策略。
    if !official_package {
      if let Ok(computed) = digest::compute(&dir, &manifest.id, &manifest.version) {
        let policy = crate::content_trust::policy::load(app);
        let signature = verify_installed(
          &dir,
          &PackageClaim {
            kind: PackageKind::Widget,
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            digest: computed,
          },
          &policy,
        );
        if signature.decision == SignatureDecision::Block {
          let reason = signature
            .reason
            .unwrap_or_else(|| "发布签名未通过".to_string());
          return Err(format!("发布签名未通过，已阻止加载：{reason}"));
        }
      }
    }
  }
  Ok(manifest)
}

/// 清单在启用后是否发生变化（需要重新确认权限）。
pub fn review_required(app: &AppHandle, id: &str) -> bool {
  if is_official(app, id) {
    return false;
  }
  let Ok(dir) = resolve_dir(app, id) else {
    return false;
  };
  let Ok(grants) = load_grants(app) else {
    return false;
  };
  let Some(record) = grants.widgets.get(id) else {
    return false;
  };
  if !record.enabled {
    return false;
  }
  let Some(expected) = record.manifest_hash.as_deref() else {
    return false;
  };
  digest::manifest_hash(&dir).map_or(true, |actual| actual != expected)
}

/// 打开窗口前的完整检查：包完整 + 清单未漂移。
pub fn ensure_intact(app: &AppHandle, id: &str) -> Result<PackageManifest, String> {
  let manifest = ensure_package(app, id)?;
  if review_required(app, id) {
    return Err("插件清单在启用后发生变化，请重新确认权限".to_string());
  }
  Ok(manifest)
}

pub fn list(app: &AppHandle) -> Vec<PackageInfo> {
  let grants = load_grants(app).unwrap_or_default();
  let policy = crate::content_trust::policy::load(app);
  let mut packages: Vec<PackageInfo> = Vec::new();
  let mut seen: HashSet<String> = HashSet::new();
  let dev_ids: HashSet<String> = if crate::extension::dev::enabled(app) {
    crate::extension::dev::packages(app)
      .into_iter()
      .map(|package| package.id)
      .collect()
  } else {
    HashSet::new()
  };

  // 官方包优先；被开发包 shadow 时只保留开发条目。
  for package in official::packages(app) {
    if dev_ids.contains(&package.id) {
      continue;
    }
    let running = is_running(app, &package.id);
    let mut info = info_from(
      &package.dir,
      &package.manifest,
      grants.widgets.get(&package.id),
      running,
      "bundled",
      effective_entry_url(app, &package.id, &package.manifest.entry),
      &policy,
    );
    if let Some(name) = official_display_name(&package.id) {
      info.name = name;
    }
    if let Some(description) = official_display_description(&package.id) {
      info.description = Some(description);
    }
    seen.insert(package.id);
    packages.push(info);
  }

  if let Ok(root) = root(app) {
    if let Ok(entries) = std::fs::read_dir(&root) {
      for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
          continue;
        }
        let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
          continue;
        };
        if dir_name.starts_with('.') || !path.join("widget.json").is_file() {
          continue;
        }
        if dev_ids.contains(dir_name) {
          continue;
        }
        if seen.contains(dir_name) {
          eprintln!("[official] 忽略用户包 {dir_name}：与官方扩展 id 冲突");
          continue;
        }
        let running = is_running(app, dir_name);
        match PackageManifest::load(&path, dir_name) {
          Ok(manifest) => packages.push(info_from(
            &path,
            &manifest,
            grants.widgets.get(dir_name),
            running,
            "user",
            effective_entry_url(app, dir_name, &manifest.entry),
            &policy,
          )),
          Err(error) => packages.push(invalid_info(dir_name, &error, "user")),
        }
      }
    }
  }

  // 开发包只在开发模式开启时进入列表；关闭后条目消失、窗口已销毁。
  if crate::extension::dev::enabled(app) {
    for package in crate::extension::dev::packages(app) {
      let path = PathBuf::from(&package.path);
      let running = is_running(app, &package.id);
      match PackageManifest::from_dir(&path) {
        Ok(manifest) if manifest.id == package.id => packages.push(info_from(
          &path,
          &manifest,
          grants.widgets.get(&package.id),
          running,
          "dev",
          effective_entry_url(app, &package.id, &manifest.entry),
          &policy,
        )),
        Ok(manifest) => packages.push(invalid_info(
          &package.id,
          &format!("清单 id={} 与挂载 id 不一致", manifest.id),
          "dev",
        )),
        Err(error) => packages.push(invalid_info(&package.id, &error, "dev")),
      }
    }
  }

  packages.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  packages
}

fn official_display_name(id: &str) -> Option<String> {
  let key = match id {
    "noise" => "widget_noise_name",
    "player" => "widget_player_name",
    _ => return None,
  };
  let name = crate::i18n::t(key);
  (!name.is_empty()).then_some(name)
}

fn official_display_description(id: &str) -> Option<String> {
  let key = match id {
    "noise" => "widget_noise_description",
    "player" => "widget_player_description",
    _ => return None,
  };
  let description = crate::i18n::t(key);
  (!description.is_empty()).then_some(description)
}

fn info_from(
  dir: &Path,
  manifest: &PackageManifest,
  grant: Option<&GrantRecord>,
  running: bool,
  origin: &str,
  entry_url: String,
  policy: &TrustPolicy,
) -> PackageInfo {
  let dev = origin == "dev";
  let official = origin == "bundled";
  let enabled_by_grant = grant.is_some_and(|record| record.enabled);
  // 清单在启用后变化：不加载、不建窗，等用户重新确认权限。
  // 官方包的哈希由启动协调维护，不进入 needs-review。
  let review_required = !official
    && enabled_by_grant
    && grant
      .and_then(|record| record.manifest_hash.as_deref())
      .is_some_and(|expected| digest::manifest_hash(dir).map_or(true, |actual| actual != expected));
  let enabled = enabled_by_grant && !review_required;
  let granted = if enabled {
    grant
      .map(|record| record.granted.clone())
      .unwrap_or_default()
  } else {
    Vec::new()
  };
  let (verified, integrity, tampered, integrity_error) = if dev {
    (false, "none".to_string(), false, None)
  } else {
    match digest::check(dir, &manifest.id, &manifest.version) {
      Ok(Some(record)) => (true, record.source, false, None),
      Ok(None) if official => (
        false,
        "none".to_string(),
        false,
        Some("官方扩展缺少摘要锁，请重装应用".to_string()),
      ),
      Ok(None) => (false, "none".to_string(), false, None),
      Err(error) => (false, "none".to_string(), true, Some(error)),
    }
  };
  let status = if tampered {
    "tampered"
  } else if official && integrity == "none" {
    "invalid"
  } else if review_required {
    "needs-review"
  } else {
    "ready"
  };
  let error = if review_required {
    Some("widget.json 在启用后发生变化，请重新确认权限".to_string())
  } else {
    integrity_error
  };
  let signature = if dev || official {
    // 开发包不参与发布签名；官方包由安装包承载分发信任。
    SignatureInfo::unsigned(
      &TrustPolicy::default(),
      if official {
        "official-bundle"
      } else {
        "dev-package"
      },
    )
  } else {
    match digest::compute(dir, &manifest.id, &manifest.version) {
      Ok(computed) => verify_installed(
        dir,
        &PackageClaim {
          kind: PackageKind::Widget,
          id: manifest.id.clone(),
          version: manifest.version.clone(),
          digest: computed,
        },
        policy,
      ),
      Err(_) => SignatureInfo::unsigned(policy, "digest-unavailable"),
    }
  };
  PackageInfo {
    id: manifest.id.clone(),
    name: manifest.name.clone(),
    version: manifest.version.clone(),
    description: manifest.description.clone(),
    author: manifest.author.clone(),
    license: manifest.license.clone(),
    status: status.to_string(),
    error,
    requested: manifest.capabilities.clone(),
    granted,
    enabled,
    running,
    verified,
    integrity,
    signature,
    tampered,
    review_required,
    dev,
    origin: origin.to_string(),
    window: PackageWindow::from(&manifest.window),
    lifecycle: manifest.lifecycle.clone(),
    network: manifest.network.clone(),
    entry_url,
    host_api: manifest.host_api,
    order: manifest.order.unwrap_or(100.0),
  }
}

fn invalid_info(id: &str, error: &str, origin: &str) -> PackageInfo {
  PackageInfo {
    id: id.to_string(),
    name: id.to_string(),
    version: "-".to_string(),
    description: None,
    author: None,
    license: None,
    status: "invalid".to_string(),
    error: Some(error.to_string()),
    requested: Vec::new(),
    granted: Vec::new(),
    enabled: false,
    running: false,
    verified: false,
    integrity: "none".to_string(),
    signature: SignatureInfo::unsigned(&TrustPolicy::default(), "manifest-invalid"),
    tampered: false,
    review_required: false,
    dev: origin == "dev",
    origin: origin.to_string(),
    window: PackageWindow::from(&WindowSpec::default()),
    lifecycle: "background".to_string(),
    network: Vec::new(),
    entry_url: String::new(),
    host_api: HOST_API,
    order: 100.0,
  }
}

fn is_running(app: &AppHandle, id: &str) -> bool {
  app
    .get_webview_window(&format!("{}{}", super::LABEL_PREFIX, id))
    .is_some()
}

fn grants_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root(app)?.join(GRANTS_FILE))
}

fn load_grants(app: &AppHandle) -> Result<GrantsFile, String> {
  let path = grants_path(app)?;
  let Ok(text) = std::fs::read_to_string(path) else {
    return Ok(GrantsFile::default());
  };
  Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn save_grants(app: &AppHandle, grants: &GrantsFile) -> Result<(), String> {
  let path = grants_path(app)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(grants).map_err(|error| error.to_string())?;
  write_atomic(&path, &json)
}

pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
  let manifest = if enabled {
    ensure_package(app, id)?
  } else {
    find(app, id)?
  };
  let manifest_hash = if enabled {
    // 手动放置的包在首次启用时补一把本地锁；开发包与只读目录例外。
    let dir = resolve_dir(app, id)?;
    if !crate::extension::dev::contains(app, id) && digest::read(&dir)?.is_none() {
      let _ = digest::seal(&dir, &manifest.id, &manifest.version, "computed");
    }
    Some(digest::manifest_hash(&dir)?)
  } else {
    None
  };
  let mut grants = load_grants(app)?;
  let source = if is_official(app, id) {
    "bundled"
  } else {
    "user"
  };
  if enabled {
    grants.widgets.insert(
      id.to_string(),
      GrantRecord {
        enabled: true,
        granted: manifest.capabilities.clone(),
        manifest_hash,
        declared: manifest.capabilities.clone(),
        source: Some(source.to_string()),
      },
    );
  } else {
    grants.widgets.insert(
      id.to_string(),
      GrantRecord {
        enabled: false,
        granted: Vec::new(),
        manifest_hash: None,
        declared: manifest.capabilities.clone(),
        source: Some(source.to_string()),
      },
    );
  }
  save_grants(app, &grants)?;
  if !enabled {
    destroy_window(app, id);
  }
  Ok(())
}

/// 逐能力授权；运行中拒绝修改，避免撤销 `widget.chrome` 后窗口无法关闭。
pub fn set_capability(
  app: &AppHandle,
  id: &str,
  capability: &str,
  granted: bool,
) -> Result<(), String> {
  let manifest = find(app, id)?;
  if !manifest.capabilities.iter().any(|item| item == capability) {
    return Err(format!("插件没有声明能力：{capability}"));
  }
  if is_running(app, id) {
    return Err("运行中不能修改权限，请先结束运行".to_string());
  }
  let mut grants = load_grants(app)?;
  let record = grants
    .widgets
    .get_mut(id)
    .ok_or_else(|| "插件未启用".to_string())?;
  if !record.enabled {
    return Err("插件未启用".to_string());
  }
  if granted {
    if !record.granted.iter().any(|item| item == capability) {
      record.granted.push(capability.to_string());
    }
  } else {
    record.granted.retain(|item| item != capability);
  }
  save_grants(app, &grants)
}

pub fn revoke(app: &AppHandle, id: &str) -> Result<(), String> {
  let mut grants = load_grants(app)?;
  grants.widgets.remove(id);
  save_grants(app, &grants)?;
  clear_state(app, id)?;
  destroy_window(app, id);
  Ok(())
}

/// 卸载：销毁窗口、删授权、删状态、删目录。
pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
  if !super::manifest::valid_id(id) {
    return Err("插件 id 非法".to_string());
  }
  // 开发包只取消挂载，不删除用户目录。
  if is_dev_mounted(app, id) {
    revoke(app, id)?;
    return crate::extension::dev::remove(app, id);
  }
  if is_official(app, id) {
    return Err("官方扩展随应用分发，不能卸载；可以停用".to_string());
  }
  let dir = resolve_dir(app, id)?;
  if !dir.is_dir() {
    return Err(format!("没有安装 id={id} 的插件"));
  }
  revoke(app, id)?;

  let root = root(app)?;
  let canonical_root =
    std::fs::canonicalize(&root).map_err(|error| format!("插件目录不可用：{error}"))?;
  let canonical_dir =
    std::fs::canonicalize(&dir).map_err(|error| format!("插件目录不可用：{error}"))?;
  if canonical_dir.parent() != Some(canonical_root.as_path()) {
    return Err("拒绝删除插件目录之外的路径".to_string());
  }
  std::fs::remove_dir_all(&canonical_dir).map_err(|error| format!("卸载失败：{error}"))
}

/// 安装：共享 staging + widget 清单/摘要校验 + 原子落地。
pub fn install_from_staged(
  root: &Path,
  staged: &install::Staged,
) -> Result<PackageInfo, ExtensionError> {
  let manifest = PackageManifest::from_dir(staged.bundle())
    .map_err(|error| ExtensionError::new("manifest.field-invalid", error))?;
  if official::is_reserved(&manifest.id) {
    return Err(ExtensionError::new(
      "manifest.id-reserved",
      format!("{} 是官方保留 id，不能作为用户包安装", manifest.id),
    ));
  }
  if manifest
    .license
    .as_deref()
    .unwrap_or_default()
    .trim()
    .is_empty()
  {
    return Err(ExtensionError::new(
      "manifest.license-missing",
      "widget.json 必须声明 license",
    ));
  }
  if !staged.bundle().join(&manifest.entry).is_file() {
    return Err(ExtensionError::new(
      "manifest.entry-missing",
      format!("entry 指向的文件不存在：{}", manifest.entry),
    ));
  }
  crate::resource::safe_join(staged.bundle(), &manifest.entry)
    .map_err(|error| ExtensionError::new("manifest.entry-unsafe", error))?;

  match digest::check(staged.bundle(), &manifest.id, &manifest.version) {
    Ok(Some(_)) => {}
    Ok(None) => {
      digest::seal(staged.bundle(), &manifest.id, &manifest.version, "computed")
        .map_err(|error| ExtensionError::new("io.error", error))?;
    }
    Err(error) => {
      return Err(ExtensionError::new("integrity.mismatch", error));
    }
  }

  let target = staged.commit(root, &manifest.id)?;
  Ok(info_from(
    &target,
    &manifest,
    None,
    false,
    "user",
    entry_url(&manifest.id, &manifest.entry),
    &TrustPolicy::default(),
  ))
}

/// 启动协调：官方包首次默认启用、升级补授新增能力、保留用户撤销。
pub(crate) fn reconcile_official(
  app: &AppHandle,
  packages: &[OfficialPackage],
) -> Result<(), String> {
  let mut grants = load_grants(app)?;
  let dev_ids: HashSet<String> = if crate::extension::dev::enabled(app) {
    crate::extension::dev::packages(app)
      .into_iter()
      .map(|package| package.id)
      .collect()
  } else {
    HashSet::new()
  };
  apply_official_grants(&mut grants, packages, &dev_ids)?;
  save_grants(app, &grants)
}

fn apply_official_grants(
  grants: &mut GrantsFile,
  packages: &[OfficialPackage],
  dev_ids: &HashSet<String>,
) -> Result<(), String> {
  let official_ids: HashSet<&str> = packages.iter().map(|package| package.id.as_str()).collect();
  // 资源里已消失的官方包只清授权记录，保留状态 KV。
  grants.widgets.retain(|id, record| {
    record.source.as_deref() != Some("bundled") || official_ids.contains(id.as_str())
  });

  for package in packages {
    if dev_ids.contains(&package.id) {
      continue;
    }
    let manifest_hash = digest::manifest_hash(&package.dir)?;
    let declared = package.manifest.capabilities.clone();
    if let Some(record) = grants.widgets.get_mut(&package.id) {
      let previous_declared = if record.declared.is_empty() {
        // 旧记录没有声明快照：把当时已授予的当作旧声明，避免一次性重新授予用户撤销过的能力。
        record.granted.clone()
      } else {
        record.declared.clone()
      };
      let mut granted: Vec<String> = record
        .granted
        .iter()
        .filter(|capability| declared.iter().any(|item| item == *capability))
        .cloned()
        .collect();
      for capability in &declared {
        if !previous_declared.contains(capability) && !granted.contains(capability) {
          granted.push(capability.clone());
        }
      }
      record.granted = granted;
      record.declared = declared;
      record.manifest_hash = Some(manifest_hash);
      record.source = Some("bundled".to_string());
    } else {
      grants.widgets.insert(
        package.id.clone(),
        GrantRecord {
          enabled: true,
          granted: declared.clone(),
          manifest_hash: Some(manifest_hash),
          declared,
          source: Some("bundled".to_string()),
        },
      );
    }
  }
  Ok(())
}

pub fn is_enabled(app: &AppHandle, id: &str) -> bool {
  load_grants(app)
    .ok()
    .and_then(|grants| grants.widgets.get(id).map(|record| record.enabled))
    .unwrap_or(false)
}

pub fn granted(app: &AppHandle, id: &str) -> Vec<String> {
  load_grants(app)
    .ok()
    .and_then(|grants| {
      grants
        .widgets
        .get(id)
        .filter(|record| record.enabled)
        .map(|record| record.granted.clone())
    })
    .unwrap_or_default()
}

pub fn require_grant(app: &AppHandle, id: &str, capability: &str) -> Result<(), String> {
  let grants = load_grants(app)?;
  let record = grants
    .widgets
    .get(id)
    .ok_or_else(|| "插件未启用".to_string())?;
  if !record.enabled {
    return Err("插件未启用".to_string());
  }
  if !record.granted.iter().any(|granted| granted == capability) {
    return Err(format!("插件未获得 {capability} 权限"));
  }
  Ok(())
}

fn destroy_window(app: &AppHandle, id: &str) {
  if let Some(window) = app.get_webview_window(&format!("{}{}", super::LABEL_PREFIX, id)) {
    let _ = window.destroy();
  }
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root(app)?.join(STATE_DIR))
}

fn state_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(state_dir(app)?.join(format!("{id}.json")))
}

fn read_state(app: &AppHandle, id: &str) -> Result<StateFile, String> {
  let path = state_path(app, id)?;
  let Ok(text) = std::fs::read_to_string(path) else {
    return Ok(StateFile::default());
  };
  Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn write_state(app: &AppHandle, id: &str, state: &StateFile) -> Result<(), String> {
  let path = state_path(app, id)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let json = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
  if json.len() > MAX_STATE_BYTES {
    return Err(format!("插件状态超过 {} KiB 上限", MAX_STATE_BYTES / 1024));
  }
  write_atomic(&path, &json)
}

pub fn get_value(app: &AppHandle, id: &str, key: &str) -> Result<Option<Value>, String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  Ok(read_state(app, id)?.values.get(key).cloned())
}

pub fn set_value(app: &AppHandle, id: &str, key: &str, value: Value) -> Result<(), String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let encoded = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
  if encoded.len() > MAX_VALUE_BYTES {
    return Err(format!(
      "单个状态值超过 {} KiB 上限",
      MAX_VALUE_BYTES / 1024
    ));
  }
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  let mut state = read_state(app, id)?;
  state.values.insert(key.to_string(), value);
  write_state(app, id, &state)
}

pub fn remove_value(app: &AppHandle, id: &str, key: &str) -> Result<(), String> {
  require_grant(app, id, "widget.state")?;
  valid_key(key)?;
  let _guard = STATE_LOCK.lock().map_err(|error| error.to_string())?;
  let mut state = read_state(app, id)?;
  state.values.remove(key);
  write_state(app, id, &state)
}

pub fn clear_state(app: &AppHandle, id: &str) -> Result<(), String> {
  let path = state_path(app, id)?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn valid_key(key: &str) -> Result<(), String> {
  if key.is_empty() || key.len() > MAX_KEY_LEN {
    return Err(format!("状态键必须是 1-{MAX_KEY_LEN} 字符"));
  }
  if !key
    .chars()
    .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
  {
    return Err("状态键只允许字母、数字、点、下划线与连字符".to_string());
  }
  Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn state_keys_are_restricted() {
    assert!(valid_key("prefs").is_ok());
    assert!(valid_key("timer.v1").is_ok());
    assert!(valid_key("../x").is_err());
    assert!(valid_key("").is_err());
    assert!(valid_key(&"a".repeat(MAX_KEY_LEN + 1)).is_err());
  }

  #[test]
  fn entry_url_is_package_scoped() {
    let url = entry_url("community-pomodoro", "index.html");
    assert!(url.contains("/community-pomodoro/index.html"));
  }

  #[test]
  fn invalid_info_uses_safe_defaults() {
    let info = invalid_info("broken", "bad manifest", "user");
    assert_eq!(info.status, "invalid");
    assert!(!info.enabled);
    assert!(info.window.width >= 320.0);
  }

  fn temp_root(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-widget-store-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_widget_package(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("assets"))?;
    std::fs::write(
      dir.join("widget.json"),
      r#"{
        "schemaVersion": 2,
        "type": "widget",
        "id": "community-test",
        "name": "测试插件",
        "version": "1.0.0",
        "license": "MIT",
        "builtin": false,
        "hostApi": 1,
        "entry": "index.html",
        "capabilities": ["widget.state"],
        "window": {
          "width": 560,
          "height": 640,
          "resizable": false,
          "transparent": true,
          "chrome": "host"
        }
      }"#,
    )?;
    std::fs::write(dir.join("index.html"), b"<html></html>")?;
    std::fs::write(dir.join("assets/app.css"), b"body{}")?;
    Ok(())
  }

  #[test]
  fn installs_widget_and_seals_integrity() {
    let Some(root) = temp_root("install") else {
      return;
    };
    let source = root.join("source");
    if write_widget_package(&source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let packages = root.join("packages");
    let Ok(staged) = install::stage(&packages, &source) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let installed = install_from_staged(&packages, &staged);
    assert!(
      installed.is_ok(),
      "安装失败：{}",
      installed
        .as_ref()
        .err()
        .map(|error| error.code.clone())
        .unwrap_or_default()
    );
    if let Ok(info) = &installed {
      assert_eq!(info.id, "community-test");
      assert!(info.verified);
      assert_eq!(info.integrity, "computed");
      assert_eq!(info.status, "ready");
    }
    let target = packages.join("community-test");
    assert!(target.join("widget.json").is_file());
    assert!(target.join(super::digest::INTEGRITY_FILE).is_file());

    // 改动包内文件后，运行时扫描必须判 tampered。
    let _ = std::fs::write(target.join("index.html"), b"<html>changed</html>");
    let Ok(manifest) = PackageManifest::load(&target, "community-test") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let info = info_from(
      &target,
      &manifest,
      None,
      false,
      "user",
      entry_url(&manifest.id, &manifest.entry),
      &TrustPolicy::default(),
    );
    assert_eq!(info.status, "tampered");
    assert!(info.error.is_some());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn manifest_drift_requires_review() {
    let Some(root) = temp_root("review") else {
      return;
    };
    let dir = root.join("community-test");
    if write_widget_package(&dir).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let Ok(manifest) = PackageManifest::load(&dir, "community-test") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let Ok(hash) = digest::manifest_hash(&dir) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let grant = GrantRecord {
      enabled: true,
      granted: vec!["widget.state".to_string()],
      manifest_hash: Some(hash),
      declared: vec!["widget.state".to_string()],
      source: Some("user".to_string()),
    };
    let info = info_from(
      &dir,
      &manifest,
      Some(&grant),
      false,
      "user",
      entry_url(&manifest.id, &manifest.entry),
      &TrustPolicy::default(),
    );
    assert_eq!(info.status, "ready");
    assert!(info.enabled);
    assert!(!info.review_required);

    let Ok(text) = std::fs::read_to_string(dir.join("widget.json")) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let changed = text.replace("测试插件", "测试插件（已改动）");
    let _ = std::fs::write(dir.join("widget.json"), changed);
    let Ok(manifest) = PackageManifest::load(&dir, "community-test") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let info = info_from(
      &dir,
      &manifest,
      Some(&grant),
      false,
      "user",
      entry_url(&manifest.id, &manifest.entry),
      &TrustPolicy::default(),
    );
    assert_eq!(info.status, "needs-review");
    assert!(!info.enabled);
    assert!(info.review_required);
    let _ = std::fs::remove_dir_all(&root);
  }

  fn official_package(
    root: &Path,
    id: &str,
    capabilities: &[&str],
  ) -> Option<crate::widget_package::official::OfficialPackage> {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).ok()?;
    let caps = capabilities
      .iter()
      .map(|capability| format!("\"{capability}\""))
      .collect::<Vec<_>>()
      .join(", ");
    std::fs::write(
      dir.join("widget.json"),
      format!(
        r#"{{
          "schemaVersion": 2,
          "type": "widget",
          "id": "{id}",
          "name": "Official {id}",
          "version": "1.0.0",
          "license": "GPL-3.0-or-later",
          "builtin": false,
          "hostApi": 1,
          "entry": "index.html",
          "capabilities": [{caps}],
          "window": {{
            "width": 420,
            "height": 320,
            "minWidth": 360,
            "minHeight": 260,
            "resizable": false,
            "transparent": false,
            "chrome": "host"
          }}
        }}"#
      ),
    )
    .ok()?;
    std::fs::write(dir.join("index.html"), b"<!doctype html>").ok()?;
    let manifest = PackageManifest::load(&dir, id).ok()?;
    Some(crate::widget_package::official::OfficialPackage {
      id: id.to_string(),
      dir,
      manifest,
    })
  }

  #[test]
  fn official_seed_enables_and_grants_declared_capabilities() {
    let Some(root) = temp_root("official-seed") else {
      return;
    };
    let Some(package) = official_package(&root, "echo", &["widget.ui", "widget.theme"]) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut grants = GrantsFile::default();
    let dev_ids = HashSet::new();
    assert!(apply_official_grants(&mut grants, &[package], &dev_ids).is_ok());
    let Some(record) = grants.widgets.get("echo") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert!(record.enabled);
    assert_eq!(record.source.as_deref(), Some("bundled"));
    assert_eq!(
      record.granted,
      vec!["widget.ui".to_string(), "widget.theme".to_string()]
    );
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_upgrade_adds_new_caps_and_keeps_revocations() {
    let Some(root) = temp_root("official-upgrade") else {
      return;
    };
    let Some(package) = official_package(
      &root,
      "echo",
      &["widget.state", "widget.theme", "widget.audio"],
    ) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut grants = GrantsFile::default();
    grants.widgets.insert(
      "echo".to_string(),
      GrantRecord {
        enabled: true,
        granted: vec!["widget.state".to_string()],
        manifest_hash: None,
        declared: vec!["widget.state".to_string(), "widget.theme".to_string()],
        source: Some("bundled".to_string()),
      },
    );
    grants.widgets.insert(
      "gone".to_string(),
      GrantRecord {
        enabled: true,
        granted: Vec::new(),
        manifest_hash: None,
        declared: Vec::new(),
        source: Some("bundled".to_string()),
      },
    );
    let dev_ids = HashSet::new();
    assert!(apply_official_grants(&mut grants, &[package], &dev_ids).is_ok());
    let Some(record) = grants.widgets.get("echo") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert!(record.enabled);
    assert_eq!(
      record.granted,
      vec!["widget.state".to_string(), "widget.audio".to_string()]
    );
    assert!(!grants.widgets.contains_key("gone"));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_reconcile_keeps_disabled_state() {
    let Some(root) = temp_root("official-disabled") else {
      return;
    };
    let Some(package) = official_package(&root, "echo", &["widget.ui"]) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut grants = GrantsFile::default();
    grants.widgets.insert(
      "echo".to_string(),
      GrantRecord {
        enabled: false,
        granted: Vec::new(),
        manifest_hash: None,
        declared: vec!["widget.ui".to_string()],
        source: Some("bundled".to_string()),
      },
    );
    let dev_ids = HashSet::new();
    assert!(apply_official_grants(&mut grants, &[package], &dev_ids).is_ok());
    assert!(grants
      .widgets
      .get("echo")
      .is_some_and(|record| !record.enabled));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_reconcile_skips_dev_shadow() {
    let Some(root) = temp_root("official-dev-shadow") else {
      return;
    };
    let Some(package) = official_package(&root, "echo", &["widget.ui"]) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let mut grants = GrantsFile::default();
    let mut dev_ids = HashSet::new();
    dev_ids.insert("echo".to_string());
    assert!(apply_official_grants(&mut grants, &[package], &dev_ids).is_ok());
    assert!(!grants.widgets.contains_key("echo"));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn official_missing_lock_is_invalid() {
    let Some(root) = temp_root("official-no-lock") else {
      return;
    };
    let dir = root.join("echo");
    if write_widget_package(&dir).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let Ok(text) = std::fs::read_to_string(dir.join("widget.json")) else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let _ = std::fs::write(
      dir.join("widget.json"),
      text.replace("community-test", "echo"),
    );
    let Ok(manifest) = PackageManifest::load(&dir, "echo") else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    let info = info_from(
      &dir,
      &manifest,
      None,
      false,
      "bundled",
      entry_url(&manifest.id, &manifest.entry),
      &TrustPolicy::default(),
    );
    assert_eq!(info.status, "invalid");
    assert!(info
      .error
      .as_deref()
      .is_some_and(|message| message.contains("摘要锁")));
    let _ = std::fs::remove_dir_all(&root);
  }
}
