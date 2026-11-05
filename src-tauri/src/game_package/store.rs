//! 游戏包目录、授权账本与安装落地。
//!
//! 包在 `games/<gameId>/`（`LULL_GAMES_DIR` 可覆盖）；授权账本 `games/.grants.json`。
//! 存档不在这个根下（见 `game::repository`），卸载包不会删除存档。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::digest;
use super::manifest::{self, GameManifest, MANIFEST_FILE};
use crate::extension::install;

const GRANTS_FILE: &str = ".grants.json";
const GRANTS_VERSION: u32 = 1;

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
    .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct GameControllerInfo {
  pub id: String,
  pub kind: manifest::GameControllerKind,
  pub label: Option<String>,
  pub widget_id: Option<String>,
  pub entry: Option<String>,
  /// Widget：已安装；包内：`entry` 文件存在。
  pub installed: bool,
  /// Widget：授权账本已启用；包内：跟随游戏 enabled。
  pub enabled: bool,
  pub auto_open: bool,
}

#[derive(Debug, Clone)]
pub struct GamePackageInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: Option<String>,
  pub author: Option<String>,
  pub license: Option<String>,
  /// `ready` / `invalid` / `disabled`
  pub status: String,
  pub error: Option<String>,
  pub entry_authority_url: String,
  /// 自带渲染入口；`None` = 只能通过场景绑定显示（旧包）。
  pub entry_replica_url: Option<String>,
  pub enabled: bool,
  pub granted: Vec<String>,
  pub capabilities: Vec<String>,
  pub network: Vec<String>,
  pub state_schema_version: u32,
  /// 清单声明的控制器窗口；Widget 载体的 `installed`/`enabled` 由 `list()` 补齐。
  pub controllers: Vec<GameControllerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantRecord {
  enabled: bool,
  #[serde(default)]
  granted: Vec<String>,
  #[serde(default)]
  manifest_hash: Option<String>,
  #[serde(default)]
  declared: Vec<String>,
  #[serde(default)]
  updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantsFile {
  version: u32,
  #[serde(default)]
  games: BTreeMap<String, GrantRecord>,
}

impl Default for GrantsFile {
  fn default() -> Self {
    Self {
      version: GRANTS_VERSION,
      games: BTreeMap::new(),
    }
  }
}

/// 游戏包根：`LULL_GAMES_DIR` 优先，否则 app_data_dir/games。
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("LULL_GAMES_DIR") {
    return Ok(PathBuf::from(dir));
  }
  app
    .path()
    .app_data_dir()
    .map(|dir| dir.join("games"))
    .map_err(|error| error.to_string())
}

pub fn package_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  Ok(root(app)?.join(id))
}

fn resolve_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !manifest::valid_id(id) {
    return Err(format!("游戏 id 非法：{id}"));
  }
  let dir = package_dir(app, id)?;
  if dir.join(MANIFEST_FILE).is_file() {
    Ok(dir)
  } else {
    Err(format!("没有安装 id={id} 的游戏"))
  }
}

/// 读取并校验清单；目录名必须与清单 id 一致。
pub fn find(app: &AppHandle, id: &str) -> Result<GameManifest, String> {
  let dir = resolve_dir(app, id)?;
  let manifest = GameManifest::load(&dir, id).map_err(|error| error.message)?;
  if let Err(error) = digest::check(&dir, &manifest.id, &manifest.version) {
    return Err(format!("游戏包完整性校验失败：{error}"));
  }
  Ok(manifest)
}

/// 启动前检查：已启用且声明的能力（network 除外）都已授权。
pub fn ensure_runnable(app: &AppHandle, id: &str) -> Result<GameManifest, String> {
  let manifest = find(app, id)?;
  if !is_enabled(app, id) {
    return Err("游戏未启用：请先在设置或扩展中心启用".to_string());
  }
  let granted = granted(app, id);
  for capability in &manifest.capabilities {
    if capability == "game.network" {
      continue;
    }
    if !granted.iter().any(|item| item == capability) {
      return Err(format!("游戏未获得 {capability} 权限"));
    }
  }
  Ok(manifest)
}

fn grants_path(root: &Path) -> PathBuf {
  root.join(GRANTS_FILE)
}

fn load_grants(root: &Path) -> GrantsFile {
  let path = grants_path(root);
  let Ok(text) = std::fs::read_to_string(path) else {
    return GrantsFile::default();
  };
  serde_json::from_str(&text).unwrap_or_default()
}

fn save_grants(root: &Path, grants: &GrantsFile) -> Result<(), String> {
  std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
  let json = serde_json::to_vec_pretty(grants).map_err(|error| error.to_string())?;
  let path = grants_path(root);
  let temp = path.with_extension("tmp");
  std::fs::write(&temp, json).map_err(|error| error.to_string())?;
  if path.exists() {
    std::fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temp, &path).map_err(|error| error.to_string())
}

pub fn is_enabled(app: &AppHandle, id: &str) -> bool {
  let Ok(root) = root(app) else {
    return false;
  };
  let grants = load_grants(&root);
  let Some(record) = grants.games.get(id) else {
    return false;
  };
  if !record.enabled {
    return false;
  }
  // 清单指纹漂移：用户手改包后按未启用处理，要求重新启用。
  let Ok(dir) = package_dir(app, id) else {
    return false;
  };
  let Ok(hash) = digest::manifest_hash(&dir) else {
    return false;
  };
  record
    .manifest_hash
    .as_deref()
    .is_some_and(|expected| expected == hash)
}

pub fn granted(app: &AppHandle, id: &str) -> Vec<String> {
  let Ok(root) = root(app) else {
    return Vec::new();
  };
  let grants = load_grants(&root);
  grants
    .games
    .get(id)
    .filter(|record| record.enabled)
    .map(|record| record.granted.clone())
    .unwrap_or_default()
}

/// 启用 = 一次性授予清单声明的全部能力（与 Widget 的 enable 语义一致）。
pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
  let root = root(app).map_err(|error| error.to_string())?;
  let manifest = if enabled {
    let manifest = find(app, id)?;
    let dir = package_dir(app, id)?;
    let _ = digest::seal(&dir, &manifest.id, &manifest.version, "computed");
    manifest
  } else {
    GameManifest::load(&resolve_dir(app, id)?, id).map_err(|error| error.message)?
  };
  let mut grants = load_grants(&root);
  let manifest_hash = if enabled {
    Some(digest::manifest_hash(&package_dir(app, id)?)?)
  } else {
    None
  };
  grants.games.insert(
    id.to_string(),
    GrantRecord {
      enabled,
      granted: if enabled {
        manifest.capabilities.clone()
      } else {
        Vec::new()
      },
      manifest_hash,
      declared: manifest.capabilities,
      updated_at: now_ms(),
    },
  );
  save_grants(&root, &grants)
}

pub fn set_capability(
  app: &AppHandle,
  id: &str,
  capability: &str,
  value: bool,
  running: bool,
) -> Result<(), String> {
  if running {
    return Err("游戏运行中不能修改权限，请先停止".to_string());
  }
  let manifest = find(app, id)?;
  if !manifest.capabilities.iter().any(|item| item == capability) {
    return Err(format!("游戏没有声明能力：{capability}"));
  }
  let root = root(app).map_err(|error| error.to_string())?;
  let mut grants = load_grants(&root);
  let record = grants
    .games
    .get_mut(id)
    .filter(|record| record.enabled)
    .ok_or_else(|| "游戏未启用".to_string())?;
  let existing = record.granted.iter().any(|item| item == capability);
  if value && !existing {
    record.granted.push(capability.to_string());
  } else if !value {
    record.granted.retain(|item| item != capability);
  }
  record.updated_at = now_ms();
  save_grants(&root, &grants)
}

pub fn revoke(app: &AppHandle, id: &str) -> Result<(), String> {
  let root = root(app).map_err(|error| error.to_string())?;
  let mut grants = load_grants(&root);
  grants.games.remove(id);
  save_grants(&root, &grants)
}

/// 列出已安装游戏；单个包坏掉不影响其它。
#[must_use]
pub fn list(app: &AppHandle) -> Vec<GamePackageInfo> {
  let Ok(root) = root(app) else {
    return Vec::new();
  };
  let grants = load_grants(&root);
  let Ok(entries) = std::fs::read_dir(&root) else {
    return Vec::new();
  };
  let mut items: Vec<GamePackageInfo> = Vec::new();
  for entry in entries.filter_map(Result::ok) {
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    if dir_name.starts_with('.') || !path.join(MANIFEST_FILE).is_file() {
      continue;
    }
    items.push(inspect(&path, dir_name, &grants));
  }
  for item in &mut items {
    for controller in &mut item.controllers {
      if controller.kind != manifest::GameControllerKind::Widget {
        continue;
      }
      let Some(widget_id) = controller.widget_id.as_deref() else {
        continue;
      };
      if let Ok(widget) = crate::widget_package::store::find(app, widget_id) {
        controller.installed = true;
        controller.enabled = crate::widget_package::store::is_enabled(app, widget_id);
        if controller.label.is_none() {
          controller.label = Some(widget.name);
        }
      }
    }
  }
  items.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  items
}

fn inspect(dir: &Path, dir_name: &str, grants: &GrantsFile) -> GamePackageInfo {
  let fallback = GamePackageInfo {
    id: dir_name.to_string(),
    name: dir_name.to_string(),
    version: String::new(),
    description: None,
    author: None,
    license: None,
    status: "invalid".to_string(),
    error: None,
    entry_authority_url: String::new(),
    entry_replica_url: None,
    enabled: false,
    granted: Vec::new(),
    capabilities: Vec::new(),
    network: Vec::new(),
    state_schema_version: 0,
    controllers: Vec::new(),
  };
  let manifest = match GameManifest::load(dir, dir_name) {
    Ok(manifest) => manifest,
    Err(error) => {
      return GamePackageInfo {
        status: "invalid".to_string(),
        error: Some(error.message),
        ..fallback
      };
    }
  };
  if let Err(error) = digest::check(dir, &manifest.id, &manifest.version) {
    return GamePackageInfo {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      license: Some(manifest.license),
      capabilities: manifest.capabilities,
      network: manifest.network,
      state_schema_version: manifest.state.schema_version,
      status: "invalid".to_string(),
      error: Some(error),
      ..fallback
    };
  }
  let record = grants.games.get(&manifest.id);
  let manifest_hash = digest::manifest_hash(dir).ok();
  let enabled = record.is_some_and(|record| {
    record.enabled
      && manifest_hash
        .as_deref()
        .is_some_and(|hash| record.manifest_hash.as_deref() == Some(hash))
  });
  let granted = if enabled {
    record
      .map(|record| record.granted.clone())
      .unwrap_or_default()
  } else {
    Vec::new()
  };
  let controllers = manifest
    .controllers
    .iter()
    .map(|controller| {
      let (installed, controller_enabled) = match controller.kind() {
        manifest::GameControllerKind::Package => {
          let installed = controller
            .entry
            .as_deref()
            .is_some_and(|entry| dir.join(entry).is_file());
          (installed, installed && enabled)
        }
        manifest::GameControllerKind::Widget => (false, false),
      };
      GameControllerInfo {
        id: controller.id.clone(),
        kind: controller.kind(),
        label: controller.label.clone(),
        widget_id: controller.widget_id.clone(),
        entry: controller.entry.clone(),
        installed,
        enabled: controller_enabled,
        auto_open: controller.auto_open,
      }
    })
    .collect();
  GamePackageInfo {
    id: manifest.id.clone(),
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    license: Some(manifest.license),
    status: if enabled { "ready" } else { "disabled" }.to_string(),
    error: if enabled {
      None
    } else if record.is_some_and(|record| record.enabled) {
      Some("清单已变化，请重新启用".to_string())
    } else {
      None
    },
    entry_authority_url: super::protocol::entry_url(&manifest.id, &manifest.entry.authority),
    entry_replica_url: manifest
      .entry
      .replica
      .as_deref()
      .map(|entry| super::protocol::entry_url(&manifest.id, entry)),
    enabled,
    granted,
    capabilities: manifest.capabilities,
    network: manifest.network,
    state_schema_version: manifest.state.schema_version,
    controllers,
  }
}

/// 安装：校验清单/入口/摘要，原子落地到 `<root>/<id>`。
pub fn install_from_staged(root: &Path, staged: &install::Staged) -> Result<GameManifest, String> {
  let manifest = GameManifest::from_dir(staged.bundle()).map_err(|error| error.message)?;
  if !staged.bundle().join(&manifest.entry.authority).is_file() {
    return Err(format!(
      "entry.authority 指向的文件不存在：{}",
      manifest.entry.authority
    ));
  }
  if let Some(replica) = &manifest.entry.replica {
    if !staged.bundle().join(replica).is_file() {
      return Err(format!("entry.replica 指向的文件不存在：{replica}"));
    }
  }
  for controller in &manifest.controllers {
    if let Some(entry) = &controller.entry {
      if !staged.bundle().join(entry).is_file() {
        return Err(format!(
          "controllers.{}.entry 指向的文件不存在：{entry}",
          controller.id
        ));
      }
    }
  }
  match digest::check(staged.bundle(), &manifest.id, &manifest.version) {
    Ok(Some(_)) => {}
    Ok(None) => {
      digest::seal(staged.bundle(), &manifest.id, &manifest.version, "computed")?;
    }
    Err(error) => return Err(format!("游戏包摘要不匹配：{error}")),
  }
  staged
    .commit_replace(root, &manifest.id)
    .map_err(|error| error.to_string())?;
  Ok(manifest)
}

/// 卸载：删授权记录与包目录；**保留** `game-data` 存档。
pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
  if !manifest::valid_id(id) {
    return Err("游戏 id 非法".to_string());
  }
  let root = root(app)?;
  let dir = resolve_dir(app, id)?;
  revoke(app, id)?;
  let canonical_root = std::fs::canonicalize(&root).map_err(|error| error.to_string())?;
  let canonical_dir = std::fs::canonicalize(&dir).map_err(|error| error.to_string())?;
  if canonical_dir.parent() != Some(canonical_root.as_path()) {
    return Err("拒绝删除游戏目录之外的路径".to_string());
  }
  std::fs::remove_dir_all(&canonical_dir).map_err(|error| format!("卸载失败：{error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "lull-games-root-{name}-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp root");
    dir
  }

  fn write_package(root: &Path, id: &str) {
    let dir = root.join(id);
    std::fs::create_dir_all(dir.join("authority")).expect("dir");
    std::fs::create_dir_all(dir.join("replica")).expect("dir");
    std::fs::write(dir.join("authority/index.html"), b"<html></html>").expect("entry");
    std::fs::write(dir.join("replica/index.html"), b"<html></html>").expect("replica");
    std::fs::write(
      dir.join(MANIFEST_FILE),
      format!(
        r#"{{
          "schemaVersion": 1, "type": "game", "id": "{id}", "name": "Demo",
          "version": "1.0.0", "license": "MIT", "hostApi": 1,
          "entry": {{ "authority": "authority/index.html", "replica": "replica/index.html" }},
          "runtime": {{ "authority": "host-tick" }},
          "display": {{ "policy": "shared" }},
          "capabilities": ["game.state.read", "game.state.write", "game.command.receive"],
          "commands": {{ "plant.seed": {{}} }},
          "state": {{ "schemaVersion": 1 }}
        }}"#
      ),
    )
    .expect("manifest");
  }

  #[test]
  fn installs_single_package_that_carries_replica() {
    let zip = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../examples/games/release/community.stability-probe-1.0.3.lull-game.zip");
    // 发布产物由 `pnpm games:samples:pack` 生成；缺失时跳过，不阻塞 CI。
    if !zip.is_file() {
      return;
    }
    let root = temp_root("single-package");
    let staging = temp_root("single-package-staging");
    let staged = install::stage(&staging, &zip).expect("stage game zip");
    let manifest = install_from_staged(&root, &staged).expect("install game zip");
    assert_eq!(manifest.id, "community.stability-probe");
    assert_eq!(
      manifest.entry.replica.as_deref(),
      Some("replica/index.html")
    );
    let info = inspect(
      &root.join("community.stability-probe"),
      "community.stability-probe",
      &GrantsFile::default(),
    );
    assert!(info
      .entry_replica_url
      .as_deref()
      .is_some_and(|url| url.ends_with("/replica/index.html")));
    assert!(root
      .join("community.stability-probe/replica/index.html")
      .is_file());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&staging);
  }

  #[test]
  fn installs_living_world_package_with_authority_and_replica() {
    let zip = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../examples/games/release/community.living-world-1.2.0.lull-game.zip");
    if !zip.is_file() {
      return;
    }
    let root = temp_root("living-world-package");
    let staging = temp_root("living-world-staging");
    let staged = install::stage(&staging, &zip).expect("stage living-world zip");
    let manifest = install_from_staged(&root, &staged).expect("install living-world zip");
    assert_eq!(manifest.id, "community.living-world");
    assert_eq!(manifest.version, "1.2.0");
    assert_eq!(manifest.entry.authority, "authority/index.html");
    assert_eq!(
      manifest.entry.replica.as_deref(),
      Some("replica/index.html")
    );
    assert_eq!(manifest.controllers.len(), 1);
    assert_eq!(manifest.controllers[0].id, "panel");
    assert_eq!(
      manifest.controllers[0].entry.as_deref(),
      Some("controllers/panel/index.html")
    );
    assert!(manifest.controllers[0].widget_id.is_none());
    let info = inspect(
      &root.join("community.living-world"),
      "community.living-world",
      &GrantsFile::default(),
    );
    assert!(info
      .entry_replica_url
      .as_deref()
      .is_some_and(|url| url.ends_with("/replica/index.html")));
    assert_eq!(info.controllers.len(), 1);
    // 包内控制器随包安装：entry 存在即 installed（游戏未启用时 enabled=false）。
    let panel = info
      .controllers
      .iter()
      .find(|controller| controller.id == "panel")
      .expect("panel controller declared");
    assert!(panel.installed);
    assert!(!panel.enabled);
    assert!(root
      .join("community.living-world/authority/main.js")
      .is_file());
    assert!(root
      .join("community.living-world/replica/main.js")
      .is_file());
    assert!(root
      .join("community.living-world/controllers/panel/index.html")
      .is_file());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&staging);
  }

  #[test]
  fn inspect_lists_ready_and_disabled_consistently() {
    let root = temp_root("inspect");
    write_package(&root, "demo.game");
    let grants = GrantsFile::default();
    let info = inspect(&root.join("demo.game"), "demo.game", &grants);
    assert_eq!(info.status, "disabled");
    assert!(info
      .entry_authority_url
      .contains("/demo.game/authority/index.html"));
    assert!(info
      .entry_replica_url
      .as_deref()
      .is_some_and(|url| url.contains("/demo.game/replica/index.html")));
    let mut grants = GrantsFile::default();
    grants.games.insert(
      "demo.game".to_string(),
      GrantRecord {
        enabled: true,
        granted: vec!["game.state.read".into()],
        manifest_hash: Some(digest::manifest_hash(&root.join("demo.game")).expect("hash")),
        declared: Vec::new(),
        updated_at: 0,
      },
    );
    let info = inspect(&root.join("demo.game"), "demo.game", &grants);
    assert_eq!(info.status, "ready");
    assert!(info.enabled);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn hash_drift_disables_game() {
    let root = temp_root("drift");
    write_package(&root, "demo.game");
    let mut grants = GrantsFile::default();
    grants.games.insert(
      "demo.game".to_string(),
      GrantRecord {
        enabled: true,
        granted: vec!["game.state.read".into()],
        manifest_hash: Some("stale".into()),
        declared: Vec::new(),
        updated_at: 0,
      },
    );
    let info = inspect(&root.join("demo.game"), "demo.game", &grants);
    assert_eq!(info.status, "disabled");
    assert_eq!(info.error.as_deref(), Some("清单已变化，请重新启用"));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn install_validates_and_lands_package() {
    let root = temp_root("install");
    let source = temp_root("source");
    write_package(&source, "demo.game");
    let staging = temp_root("staging");
    let staged = install::stage(&staging, &source.join("demo.game")).expect("stage");
    let manifest = install_from_staged(&root, &staged).expect("install");
    assert_eq!(manifest.id, "demo.game");
    assert!(root.join("demo.game/game.json").is_file());
    assert!(root.join("demo.game/.lull-integrity.json").is_file());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&staging);
  }
}
