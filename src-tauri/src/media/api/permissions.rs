//! N5 Widget 媒体权限矩阵。
//!
//! 官方窗口继续使用静态 label 矩阵；`widget-*` 必须带 Rust 下发的 bridge token，
//! 再按 `.grants.json` 的 8 个 Noise capability 逐方法校验。

use super::errors::MediaError;

pub const LIBRARY_READ: &str = "media.noise.library.read";
pub const SESSION_READ: &str = "media.noise.session.read";
pub const SESSION_CONTROL: &str = "media.noise.session.control";
pub const TRACKS_READ: &str = "media.noise.tracks.read";
pub const TRACKS_WRITE: &str = "media.noise.tracks.write";
pub const VOLUME_WRITE: &str = "media.noise.volume.write";
pub const PRESETS_READ: &str = "media.noise.presets.read";
pub const PRESETS_WRITE: &str = "media.noise.presets.write";

#[allow(dead_code)]
pub const NOISE_CAPABILITIES: &[&str] = &[
  LIBRARY_READ,
  SESSION_READ,
  SESSION_CONTROL,
  TRACKS_READ,
  TRACKS_WRITE,
  VOLUME_WRITE,
  PRESETS_READ,
  PRESETS_WRITE,
];

/// Widget 可调用方法 → capability。`None` 表示 Widget 不允许该方法。
#[must_use]
pub fn widget_capability(namespace: &str, method: &str) -> Option<&'static str> {
  if namespace != "noise" {
    return None;
  }
  Some(match method {
    "getState" | "getSession" | "getSounds" => SESSION_READ,
    "createSession"
    | "playSession"
    | "pauseSession"
    | "stopSession"
    | "setSleepTimer"
    | "setSessionSleepTimer"
    | "activate"
    | "reset" => SESSION_CONTROL,
    "setSessionVolume" | "setSessionMuted" | "setMaster" | "setMuted" | "setTrackVolume" => {
      VOLUME_WRITE
    }
    "addTrack" | "removeTrack" | "setTrackEnabled" | "setTrackLoop" | "reorderTracks"
    | "setLayer" => TRACKS_WRITE,
    "listAssets" | "getAsset" | "getCategories" | "getTags" | "setAssetFavorite" => LIBRARY_READ,
    "listPresets" | "getPreset" => PRESETS_READ,
    "savePreset" | "updatePreset" | "deletePreset" | "loadPreset" | "mapPresetTrack"
    | "setPresetFavorite" => PRESETS_WRITE,
    // 文件导入/导出、Asset 编辑/删除只属于设置窗。
    _ => return None,
  })
}

/// 官方窗口的 Noise 方法权限；资产写操作仍由 `noise::library` 自己限制到 settings。
pub fn official_noise_allowed(label: &str, method: &str) -> Result<(), MediaError> {
  let allowed = match label {
    "settings" => true,
    "noise" => !matches!(
      method,
      "importAssets"
        | "importFolder"
        | "updateAsset"
        | "removeAsset"
        | "revalidateAssets"
        | "importPreset"
        | "exportPreset"
    ),
    "library" => matches!(
      method,
      "listAssets" | "getAsset" | "getCategories" | "getTags" | "setAssetFavorite" | "getSounds"
    ),
    _ => false,
  };
  if allowed {
    Ok(())
  } else {
    Err(MediaError::new(
      "capability.denied",
      "当前窗口没有该 Noise 权限",
    ))
  }
}

/// Widget 可订阅的默认 topic（不含 player/queue/output）。
pub const WIDGET_TOPICS: &[&str] = &[
  "noise.state",
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.track.state-changed",
  "noise.volume.changed",
  "noise.library.changed",
  "noise.preset.created",
  "noise.preset.updated",
  "noise.preset.deleted",
  "noise.level",
];

pub const PLAYER_TOPICS: &[&str] = &[
  "player.state",
  "player.progress",
  "player.level",
  "queue.changed",
  "output.changed",
];

pub const NOISE_WINDOW_TOPICS: &[&str] = &[
  "noise.state",
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.track.state-changed",
  "noise.volume.changed",
  "noise.library.changed",
  "noise.preset.created",
  "noise.preset.updated",
  "noise.preset.deleted",
  "noise.level",
  "output.changed",
];

#[must_use]
pub fn official_topics(label: &str) -> &'static [&'static str] {
  match label {
    "noise" => NOISE_WINDOW_TOPICS,
    "player" | "library" => PLAYER_TOPICS,
    _ => &[],
  }
}

#[must_use]
pub fn widget_topic_capability(topic: &str) -> Option<&'static str> {
  match topic {
    "noise.state"
    | "noise.session.changed"
    | "noise.session.state-changed"
    | "noise.volume.changed"
    | "noise.level" => Some(SESSION_READ),
    "noise.track.added"
    | "noise.track.removed"
    | "noise.track.updated"
    | "noise.track.state-changed" => Some(TRACKS_READ),
    "noise.library.changed" => Some(LIBRARY_READ),
    "noise.preset.created" | "noise.preset.updated" | "noise.preset.deleted" => Some(PRESETS_READ),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn widget_methods_are_mapped_to_eight_capabilities() {
    assert_eq!(widget_capability("noise", "getSession"), Some(SESSION_READ));
    assert_eq!(
      widget_capability("noise", "playSession"),
      Some(SESSION_CONTROL)
    );
    assert_eq!(
      widget_capability("noise", "setSessionVolume"),
      Some(VOLUME_WRITE)
    );
    assert_eq!(widget_capability("noise", "addTrack"), Some(TRACKS_WRITE));
    assert_eq!(
      widget_capability("noise", "listPresets"),
      Some(PRESETS_READ)
    );
    assert_eq!(
      widget_capability("noise", "savePreset"),
      Some(PRESETS_WRITE)
    );
    assert_eq!(widget_capability("noise", "listAssets"), Some(LIBRARY_READ));
    assert_eq!(widget_capability("noise", "importAssets"), None);
    assert_eq!(widget_capability("player", "play"), None);
    assert_eq!(NOISE_CAPABILITIES.len(), 8);
  }

  #[test]
  fn widget_topics_require_read_capability() {
    assert_eq!(
      widget_topic_capability("noise.session.changed"),
      Some(SESSION_READ)
    );
    assert_eq!(
      widget_topic_capability("noise.track.added"),
      Some(TRACKS_READ)
    );
    assert_eq!(
      widget_topic_capability("noise.preset.created"),
      Some(PRESETS_READ)
    );
    assert_eq!(widget_topic_capability("player.state"), None);
  }

  #[test]
  fn official_noise_matrix_keeps_player_out() {
    assert!(official_noise_allowed("settings", "importAssets").is_ok());
    assert!(official_noise_allowed("noise", "playSession").is_ok());
    assert!(official_noise_allowed("noise", "importAssets").is_err());
    assert!(official_noise_allowed("library", "listAssets").is_ok());
    assert!(official_noise_allowed("library", "playSession").is_err());
    assert!(official_noise_allowed("player", "getState").is_err());
  }
}
