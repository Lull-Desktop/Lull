//! 扩展安装管线：与包类型无关的解压、限流、staging、原子落地。
//!
//! scene 与 widget 共用这一层；各自只负责“包根里有什么清单、清单是否合法、
//! 摘要怎么算、最终落到哪个目录”。任何一步失败都只清 staging，不碰已安装内容。

use super::error::ExtensionError;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 单包文件数上限。
pub const MAX_FILES: usize = 512;
/// 单文件上限。
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 整包解压后上限。
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

const STAGING_PREFIX: &str = ".staging-";
const MANIFESTS: [&str; 2] = ["catalog.json", "widget.json"];

/// 已经解压/复制到暂存区、并定位到包根的安装候选。
///
/// `Drop` 负责清掉整个暂存目录；`commit` 把包根 rename 走之后，暂存目录
/// 通常只剩空壳，删除失败会被忽略。
pub struct Staged {
  staging: PathBuf,
  bundle: PathBuf,
}

impl Staged {
  #[must_use]
  pub fn bundle(&self) -> &Path {
    &self.bundle
  }

  /// 把包根原子移动到 `<root>/<id>`；目标已存在时拒绝。
  pub fn commit(&self, root: &Path, id: &str) -> Result<PathBuf, ExtensionError> {
    if !safe_component(id) {
      return Err(ExtensionError::new(
        "manifest.id-invalid",
        format!("id 不能作为目录名：{id}"),
      ));
    }
    std::fs::create_dir_all(root)
      .map_err(|error| ExtensionError::new("io.error", format!("创建安装目录失败：{error}")))?;
    let target = root.join(id);
    if target.exists() {
      return Err(ExtensionError::new(
        "manifest.id-conflict",
        format!("已安装 id={id} 的扩展，请先卸载再安装"),
      ));
    }
    std::fs::rename(&self.bundle, &target).map_err(|error| {
      ExtensionError::new("io.error", format!("安装失败：{error}"))
        .with_detail(self.bundle.display().to_string())
    })?;
    Ok(target)
  }

  /// 覆盖安装：目标已存在时先把旧目录改名为点号备份，再落新包。
  ///
  /// 仅用于支持本地更新的包类型（当前是 scene）；widget 仍走 `commit`，
  /// 因为覆盖正在运行/已授权的插件需要额外的授权与状态迁移设计。
  pub fn commit_replace(&self, root: &Path, id: &str) -> Result<PathBuf, ExtensionError> {
    if !safe_component(id) {
      return Err(ExtensionError::new(
        "manifest.id-invalid",
        format!("id 不能作为目录名：{id}"),
      ));
    }
    std::fs::create_dir_all(root)
      .map_err(|error| ExtensionError::new("io.error", format!("创建安装目录失败：{error}")))?;
    let target = root.join(id);
    if !target.exists() {
      return self.commit(root, id);
    }

    let backup = root.join(format!(".replaced-{id}-{}", unique_suffix()));
    std::fs::rename(&target, &backup)
      .map_err(|error| ExtensionError::new("io.error", format!("备份旧版本失败：{error}")))?;
    match std::fs::rename(&self.bundle, &target) {
      Ok(()) => {
        // 备份删除失败只会留下点号目录，扫描会忽略，不影响新版本。
        let _ = std::fs::remove_dir_all(&backup);
        Ok(target)
      }
      Err(error) => {
        let _ = std::fs::rename(&backup, &target);
        Err(
          ExtensionError::new("io.error", format!("覆盖安装失败：{error}"))
            .with_detail(self.bundle.display().to_string()),
        )
      }
    }
  }
}

impl Drop for Staged {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.staging);
  }
}

/// 在 `root` 下建 `.staging-*`，把 `source`（目录或 zip）展开进去，并定位包根。
pub fn stage(root: &Path, source: &Path) -> Result<Staged, ExtensionError> {
  std::fs::create_dir_all(root)
    .map_err(|error| ExtensionError::new("io.error", format!("创建安装目录失败：{error}")))?;
  let staging = root.join(format!("{STAGING_PREFIX}{}", unique_suffix()));
  std::fs::create_dir_all(&staging)
    .map_err(|error| ExtensionError::new("io.error", format!("创建安装暂存目录失败：{error}")))?;

  match stage_into(&staging, source) {
    Ok(bundle) => Ok(Staged { staging, bundle }),
    Err(error) => {
      let _ = std::fs::remove_dir_all(&staging);
      Err(error)
    }
  }
}

fn stage_into(staging: &Path, source: &Path) -> Result<PathBuf, ExtensionError> {
  let metadata = std::fs::metadata(source).map_err(|error| {
    ExtensionError::new(
      "package.not-found",
      format!("找不到扩展包 {}：{error}", source.display()),
    )
  })?;

  if metadata.is_dir() {
    copy_tree(source, &staging.join("bundle"))?;
  } else if is_zip(source) {
    extract_zip(source, staging)?;
  } else {
    return Err(ExtensionError::new(
      "package.unsupported",
      "只支持文件夹或 .zip 扩展包",
    ));
  }

  locate_bundle(staging)
}

/// 允许 zip 外层套一层目录；同时拒绝“两种根清单都出现”的歧义包。
fn locate_bundle(staging: &Path) -> Result<PathBuf, ExtensionError> {
  let found = manifests_at(staging);
  if found.len() > 1 {
    return Err(ExtensionError::new(
      "package.ambiguous",
      "扩展包同时包含 catalog.json 与 widget.json，无法判断类型",
    ));
  }
  if found.len() == 1 {
    return Ok(staging.to_path_buf());
  }

  let mut dirs: Vec<PathBuf> = Vec::new();
  if let Ok(entries) = std::fs::read_dir(staging) {
    for entry in entries.filter_map(Result::ok) {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      if name.starts_with('.') {
        continue;
      }
      if entry.path().is_dir() {
        dirs.push(entry.path());
      }
    }
  }
  if dirs.len() == 1 {
    if let Some(candidate) = dirs.pop() {
      let found = manifests_at(&candidate);
      if found.len() > 1 {
        return Err(ExtensionError::new(
          "package.ambiguous",
          "扩展包同时包含 catalog.json 与 widget.json，无法判断类型",
        ));
      }
      if found.len() == 1 {
        return Ok(candidate);
      }
    }
  }
  Err(ExtensionError::new(
    "package.manifest-missing",
    "扩展包里没有找到 catalog.json 或 widget.json",
  ))
}

fn manifests_at(dir: &Path) -> Vec<&'static str> {
  MANIFESTS
    .iter()
    .copied()
    .filter(|manifest| dir.join(manifest).is_file())
    .collect()
}

/// 复制目录（拒绝符号链接，带体积与数量上限）。
fn copy_tree(source: &Path, target: &Path) -> Result<(), ExtensionError> {
  let mut budget = Budget::default();
  copy_dir(source, target, &mut budget)
}

fn copy_dir(source: &Path, target: &Path, budget: &mut Budget) -> Result<(), ExtensionError> {
  std::fs::create_dir_all(target)
    .map_err(|error| ExtensionError::new("io.error", format!("创建目录失败：{error}")))?;
  let entries = std::fs::read_dir(source).map_err(|error| {
    ExtensionError::new(
      "io.error",
      format!("读取 {} 失败：{error}", source.display()),
    )
  })?;
  for entry in entries {
    let entry =
      entry.map_err(|error| ExtensionError::new("io.error", format!("读取目录项失败：{error}")))?;
    let path = entry.path();
    let file_type = entry
      .file_type()
      .map_err(|error| ExtensionError::new("io.error", format!("读取文件类型失败：{error}")))?;
    if file_type.is_symlink() {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        format!("扩展包不允许符号链接：{}", path.display()),
      ));
    }
    let Some(name) = path.file_name() else {
      continue;
    };
    let destination = target.join(name);
    if file_type.is_dir() {
      copy_dir(&path, &destination, budget)?;
      continue;
    }
    if !file_type.is_file() {
      continue;
    }
    let size = entry
      .metadata()
      .map_err(|error| ExtensionError::new("io.error", format!("读取文件大小失败：{error}")))?
      .len();
    if size > MAX_FILE_BYTES {
      return Err(ExtensionError::new(
        "package.too-large",
        format!(
          "单个文件超过 {} MiB：{}",
          MAX_FILE_BYTES / (1024 * 1024),
          path.display()
        ),
      ));
    }
    budget.take(size)?;
    std::fs::copy(&path, &destination).map_err(|error| {
      ExtensionError::new("io.error", format!("复制 {} 失败：{error}", path.display()))
    })?;
  }
  Ok(())
}

/// 解压 zip 到暂存目录（拒绝 `..`、反斜杠、符号链接，带体积上限）。
fn extract_zip(source: &Path, staging: &Path) -> Result<(), ExtensionError> {
  let file = std::fs::File::open(source).map_err(|error| {
    ExtensionError::new(
      "package.not-found",
      format!("打开 {} 失败：{error}", source.display()),
    )
  })?;
  let mut archive = zip::ZipArchive::new(file).map_err(|error| {
    ExtensionError::new("package.unsupported", format!("解析 zip 失败：{error}"))
  })?;
  let mut budget = Budget::default();

  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|error| {
      ExtensionError::new("package.unsupported", format!("读取 zip 条目失败：{error}"))
    })?;
    if entry.name().contains('\\') {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        "zip 内含反斜杠路径，已拒绝",
      ));
    }
    if entry
      .unix_mode()
      .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
    {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        "zip 内含符号链接，已拒绝",
      ));
    }
    let Some(relative) = entry.enclosed_name() else {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        format!("zip 内含不安全路径：{}", entry.name()),
      ));
    };
    if relative
      .components()
      .any(|component| !matches!(component, Component::Normal(_)))
    {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        format!("zip 内含不安全路径：{}", entry.name()),
      ));
    }

    let destination = staging.join(&relative);
    if entry.is_dir() {
      std::fs::create_dir_all(&destination)
        .map_err(|error| ExtensionError::new("io.error", format!("创建目录失败：{error}")))?;
      continue;
    }
    if let Some(parent) = destination.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|error| ExtensionError::new("io.error", format!("创建目录失败：{error}")))?;
    }
    let size = entry.size();
    if size > MAX_FILE_BYTES {
      return Err(ExtensionError::new(
        "package.too-large",
        format!(
          "zip 内单个文件超过 {} MiB：{}",
          MAX_FILE_BYTES / (1024 * 1024),
          entry.name()
        ),
      ));
    }
    budget.take(size)?;

    let mut output = std::fs::File::create(&destination).map_err(|error| {
      ExtensionError::new(
        "io.error",
        format!("写入 {} 失败：{error}", destination.display()),
      )
    })?;
    // 再兜一层：按上限截断读取，避免 zip 头谎报大小。
    let copied =
      std::io::copy(&mut (&mut entry).take(MAX_FILE_BYTES + 1), &mut output).map_err(|error| {
        ExtensionError::new("io.error", format!("解压 {} 失败：{error}", entry.name()))
      })?;
    if copied > MAX_FILE_BYTES {
      return Err(ExtensionError::new(
        "package.too-large",
        format!(
          "zip 内单个文件超过 {} MiB：{}",
          MAX_FILE_BYTES / (1024 * 1024),
          entry.name()
        ),
      ));
    }
  }
  Ok(())
}

/// 安装预算：文件数 + 累计字节。
#[derive(Default)]
struct Budget {
  files: usize,
  bytes: u64,
}

impl Budget {
  fn take(&mut self, size: u64) -> Result<(), ExtensionError> {
    self.files = self.files.saturating_add(1);
    self.bytes = self.bytes.saturating_add(size);
    if self.files > MAX_FILES {
      return Err(ExtensionError::new(
        "package.too-large",
        format!("扩展包文件数超过上限 {MAX_FILES}"),
      ));
    }
    if self.bytes > MAX_TOTAL_BYTES {
      return Err(ExtensionError::new(
        "package.too-large",
        format!("扩展包解压后超过 {} MiB", MAX_TOTAL_BYTES / (1024 * 1024)),
      ));
    }
    Ok(())
  }
}

fn safe_component(id: &str) -> bool {
  !id.is_empty()
    && id != "."
    && id != ".."
    && !id.contains('/')
    && !id.contains('\\')
    && !id.contains('\0')
}

fn is_zip(path: &Path) -> bool {
  path
    .extension()
    .and_then(|extension| extension.to_str())
    .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn unique_suffix() -> String {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|value| value.as_nanos())
    .unwrap_or_default();
  format!("{nanos:x}-{}", std::process::id())
}

/// 预览用统计：文件数与总字节，只算会被服务/摘要的普通文件。
pub fn stats(dir: &Path) -> Result<(usize, u64), ExtensionError> {
  let mut files = 0_usize;
  let mut bytes = 0_u64;
  stats_inner(dir, &mut files, &mut bytes)?;
  Ok((files, bytes))
}

fn stats_inner(dir: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), ExtensionError> {
  let entries = std::fs::read_dir(dir).map_err(|error| {
    ExtensionError::new("io.error", format!("读取 {} 失败：{error}", dir.display()))
  })?;
  for entry in entries {
    let entry =
      entry.map_err(|error| ExtensionError::new("io.error", format!("读取目录项失败：{error}")))?;
    let name = entry.file_name();
    if name.to_string_lossy().starts_with('.') {
      continue;
    }
    let path = entry.path();
    let file_type = entry
      .file_type()
      .map_err(|error| ExtensionError::new("io.error", format!("读取文件类型失败：{error}")))?;
    if file_type.is_symlink() {
      return Err(ExtensionError::new(
        "package.unsafe-entry",
        format!("扩展包不允许符号链接：{}", path.display()),
      ));
    }
    if file_type.is_dir() {
      stats_inner(&path, files, bytes)?;
    } else if file_type.is_file() {
      let size = entry
        .metadata()
        .map_err(|error| ExtensionError::new("io.error", format!("读取文件大小失败：{error}")))?
        .len();
      *files = (*files).saturating_add(1);
      *bytes = (*bytes).saturating_add(size);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(tag: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
      "lull-install-{tag}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
  }

  fn write_package(dir: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(dir.join("assets"))?;
    std::fs::write(dir.join("widget.json"), b"{}")?;
    std::fs::write(dir.join("index.html"), b"<html></html>")?;
    std::fs::write(dir.join("assets/app.css"), b"body{}")?;
    Ok(())
  }

  #[test]
  fn stages_folder_and_commits_bundle() {
    let Some(root) = temp_root("folder") else {
      return;
    };
    let source = root.join("source");
    if write_package(&source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let package_root = root.join("packages");
    let staged = stage(&package_root, &source);
    let Ok(staged) = staged else {
      let _ = std::fs::remove_dir_all(&root);
      return;
    };
    assert!(staged.bundle().join("widget.json").is_file());
    let target = staged.commit(&package_root, "community.test");
    assert!(target.is_ok(), "commit 失败：{target:?}");
    assert!(package_root.join("community.test/assets/app.css").is_file());
    drop(staged);
    let leftovers = std::fs::read_dir(&package_root)
      .into_iter()
      .flatten()
      .filter_map(Result::ok)
      .filter(|entry| {
        entry
          .file_name()
          .to_string_lossy()
          .starts_with(STAGING_PREFIX)
      })
      .count();
    assert_eq!(leftovers, 0, "暂存目录没有清理");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn reads_packed_sample_and_verifies_declared_digest() {
    let Some(root) = temp_root("packed") else {
      return;
    };
    // 这些 zip 由 `pnpm widgets:samples:pack` 生成，属于本地测试产物；
    // 缺失时跳过，不阻塞 CI。
    let samples = [
      (
        "../artifacts/community-pomodoro-1.0.0.lull-widget.zip",
        true,
      ),
      (
        "../artifacts/community-pomodoro-1.0.0-tampered.lull-widget.zip",
        false,
      ),
    ];
    for (relative, expected_ok) in samples {
      let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
      if !path.is_file() {
        continue;
      }
      let staged = stage(&root.join("staging"), &path);
      assert!(
        staged.is_ok(),
        "{relative}: 解压失败 {}",
        staged
          .as_ref()
          .err()
          .map(|error| error.code.clone())
          .unwrap_or_default()
      );
      let Ok(staged) = staged else {
        continue;
      };
      let manifest = crate::widget_package::manifest::PackageManifest::from_dir(staged.bundle());
      assert!(
        manifest.is_ok(),
        "{relative}: 清单校验失败 {}",
        manifest
          .as_ref()
          .err()
          .cloned()
          .unwrap_or_default()
      );
      let Ok(manifest) = manifest else {
        continue;
      };
      let check =
        crate::widget_package::digest::check(staged.bundle(), &manifest.id, &manifest.version);
      assert_eq!(check.is_ok(), expected_ok, "{relative}");

      let target_root = root.join(if expected_ok {
        "packages-ok"
      } else {
        "packages-tampered"
      });
      let installed = crate::widget_package::store::install_from_staged(&target_root, &staged);
      if expected_ok {
        assert!(
          installed.is_ok(),
          "{relative}: 安装失败 {}",
          installed
            .as_ref()
            .err()
            .map(|error| error.code.clone())
            .unwrap_or_default()
        );
        assert!(target_root.join(&manifest.id).is_dir());
      } else {
        assert_eq!(
          installed.err().map(|error| error.code),
          Some("integrity.mismatch".to_string())
        );
        assert!(!target_root.join(&manifest.id).exists());
      }
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn locates_single_wrapper_directory() {
    let Some(root) = temp_root("wrapper") else {
      return;
    };
    let inner = root.join("my-widget");
    if write_package(&inner).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    assert_eq!(locate_bundle(&root).ok(), Some(inner));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn rejects_missing_manifest_and_conflicting_target() {
    let Some(root) = temp_root("reject") else {
      return;
    };
    let source = root.join("empty");
    if std::fs::create_dir_all(&source).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let error = stage(&root.join("packages"), &source).err();
    assert_eq!(
      error.map(|item| item.code).as_deref(),
      Some("package.manifest-missing")
    );

    let good = root.join("good");
    if write_package(&good).is_err() {
      let _ = std::fs::remove_dir_all(&root);
      return;
    }
    let package_root = root.join("packages");
    if let Ok(staged) = stage(&package_root, &good) {
      let first = staged.commit(&package_root, "community.test");
      assert!(first.is_ok());
      let second = staged.commit(&package_root, "community.test");
      assert_eq!(
        second.err().map(|item| item.code).as_deref(),
        Some("manifest.id-conflict")
      );
    }
    let _ = std::fs::remove_dir_all(&root);
  }
}
