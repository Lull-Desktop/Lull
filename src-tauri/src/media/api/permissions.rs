//! N5/N7 Widget 媒体权限矩阵。
//!
//! 官方窗口继续使用静态 label 矩阵；`widget-*` 必须带 Rust 下发的 bridge token，
//! 再按 `.grants.json` 的 capability 逐方法校验。玩家/队列/曲库能力与 Noise 能力
//! 同为公开能力，官方扩展只是默认授权的使用方。

use super::errors::MediaError;

pub const NOISE_LIBRARY_READ: &str = "media.noise.library.read";
pub const SESSION_READ: &str = "media.noise.session.read";
pub const SESSION_CONTROL: &str = "media.noise.session.control";
pub const TRACKS_READ: &str = "media.noise.tracks.read";
pub const TRACKS_WRITE: &str = "media.noise.tracks.write";
pub const VOLUME_WRITE: &str = "media.noise.volume.write";
pub const PRESETS_READ: &str = "media.noise.presets.read";
pub const PRESETS_WRITE: &str = "media.noise.presets.write";

pub const PLAYER_READ: &str = "media.player.read";
pub const PLAYER_CONTROL: &str = "media.player.control";
pub const PLAYER_VOLUME_WRITE: &str = "media.player.volume.write";
pub const QUEUE_READ: &str = "media.queue.read";
pub const QUEUE_WRITE: &str = "media.queue.write";
pub const MEDIA_LIBRARY_READ: &str = "media.library.read";
pub const MEDIA_LIBRARY_DIRECTORY_READ: &str = "media.library.directory.read";
pub const MEDIA_LIBRARY_FAVORITES_WRITE: &str = "media.library.favorites.write";
pub const MEDIA_LIBRARY_SOURCES_WRITE: &str = "media.library.sources.write";

#[allow(dead_code)]
pub const NOISE_CAPABILITIES: &[&str] = &[
  NOISE_LIBRARY_READ,
  SESSION_READ,
  SESSION_CONTROL,
  TRACKS_READ,
  TRACKS_WRITE,
  VOLUME_WRITE,
  PRESETS_READ,
  PRESETS_WRITE,
];

/// 至少拿到一项读能力才允许 `media.connect`，避免只有控制权的包拿到快照。
pub const WIDGET_READ_CAPABILITIES: &[&str] = &[
  NOISE_LIBRARY_READ,
  SESSION_READ,
  TRACKS_READ,
  PRESETS_READ,
  PLAYER_READ,
  QUEUE_READ,
  MEDIA_LIBRARY_READ,
  MEDIA_LIBRARY_DIRECTORY_READ,
];

/// Widget 可调用方法 → capability。`None` 表示 Widget 不允许该方法。
#[must_use]
pub fn widget_capability(namespace: &str, method: &str) -> Option<&'static str> {
  match namespace {
    "noise" => Some(match method {
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
      "listAssets" | "getAsset" | "getCategories" | "getTags" | "setAssetFavorite" => {
        NOISE_LIBRARY_READ
      }
      "listPresets" | "getPreset" => PRESETS_READ,
      "savePreset" | "updatePreset" | "deletePreset" | "loadPreset" | "mapPresetTrack"
      | "setPresetFavorite" => PRESETS_WRITE,
      // 文件导入/导出、Asset 编辑/删除只属于设置窗。
      _ => return None,
    }),
    "player" => Some(match method {
      "getState" | "getSmartShuffleConfig" | "listShuffleProfiles" | "getShuffleProfile" => {
        PLAYER_READ
      }
      "play"
      | "pause"
      | "resume"
      | "stop"
      | "seek"
      | "next"
      | "previous"
      | "setMode"
      | "setAdvanceList"
      | "setSmartShuffleConfig"
      | "saveShuffleProfile"
      | "deleteShuffleProfile"
      | "activateShuffleProfile" => PLAYER_CONTROL,
      "setVolume" | "setMuted" => PLAYER_VOLUME_WRITE,
      _ => return None,
    }),
    "queue" => match method {
      "get" => Some(QUEUE_READ),
      "add" | "remove" | "clear" | "move" | "playAt" => Some(QUEUE_WRITE),
      _ => None,
    },
    "library" => match method {
      "listTracks" | "getTrack" | "getCoverUrl" | "listArtists" | "listAlbums" => {
        Some(MEDIA_LIBRARY_READ)
      }
      "listDirectory" => Some(MEDIA_LIBRARY_DIRECTORY_READ),
      "addSource" | "startScan" => Some(MEDIA_LIBRARY_SOURCES_WRITE),
      _ => None,
    },
    // 目录管理仍只给 host；Widget 只保留通过系统选择器添加目录/单曲的能力。
    "folders" => match method {
      "add" | "scan" | "addSingles" => Some(MEDIA_LIBRARY_SOURCES_WRITE),
      _ => None,
    },
    "favorites" => match method {
      "list" => Some(MEDIA_LIBRARY_READ),
      "set" => Some(MEDIA_LIBRARY_FAVORITES_WRITE),
      _ => None,
    },
    _ => None,
  }
}

/// 官方窗口的 Noise 方法权限；资产写操作仍由 `noise::library` 自己限制到 settings。
pub fn official_noise_allowed(label: &str, method: &str) -> Result<(), MediaError> {
  let allowed = match label {
    "settings" | "noise-library" => true,
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
      "当前窗口没有该音境权限",
    ))
  }
}

/// Widget 的 Noise topic 集合（原有 8 能力）。
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

/// Widget 的播放/队列/曲库 topic；`library.changed` 目前仍由资料库全局广播。
pub const PLAYER_WIDGET_TOPICS: &[&str] = &[
  "player.state",
  "player.progress",
  "player.level",
  "queue.changed",
  "library.changed",
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
    "noise" | "noise-library" => NOISE_WINDOW_TOPICS,
    "player" | "library" => PLAYER_TOPICS,
    _ => &[],
  }
}

/// 按已授权能力计算 Widget 可订阅的 topic 并集；连接与默认集合都用它。
#[must_use]
pub fn widget_topics_for(granted: &[String]) -> Vec<&'static str> {
  WIDGET_TOPICS
    .iter()
    .chain(PLAYER_WIDGET_TOPICS)
    .copied()
    .filter(|topic| {
      widget_topic_capability(topic)
        .is_some_and(|capability| granted.iter().any(|item| item == capability))
    })
    .collect()
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
    "noise.library.changed" => Some(NOISE_LIBRARY_READ),
    "noise.preset.created" | "noise.preset.updated" | "noise.preset.deleted" => Some(PRESETS_READ),
    "player.state" | "player.progress" | "player.level" => Some(PLAYER_READ),
    "queue.changed" => Some(QUEUE_READ),
    "library.changed" => Some(MEDIA_LIBRARY_READ),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn granted(capabilities: &[&str]) -> Vec<String> {
    capabilities
      .iter()
      .map(|item| (*item).to_string())
      .collect()
  }

  #[test]
  fn widget_noise_methods_are_mapped_to_eight_capabilities() {
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
    assert_eq!(
      widget_capability("noise", "listAssets"),
      Some(NOISE_LIBRARY_READ)
    );
    assert_eq!(widget_capability("noise", "importAssets"), None);
    assert_eq!(NOISE_CAPABILITIES.len(), 8);
  }

  #[test]
  fn widget_player_queue_library_methods_are_mapped() {
    assert_eq!(widget_capability("player", "getState"), Some(PLAYER_READ));
    assert_eq!(
      widget_capability("player", "getSmartShuffleConfig"),
      Some(PLAYER_READ)
    );
    assert_eq!(
      widget_capability("player", "listShuffleProfiles"),
      Some(PLAYER_READ)
    );
    assert_eq!(
      widget_capability("player", "getShuffleProfile"),
      Some(PLAYER_READ)
    );
    assert_eq!(widget_capability("player", "play"), Some(PLAYER_CONTROL));
    assert_eq!(
      widget_capability("player", "saveShuffleProfile"),
      Some(PLAYER_CONTROL)
    );
    assert_eq!(
      widget_capability("player", "activateShuffleProfile"),
      Some(PLAYER_CONTROL)
    );
    assert_eq!(
      widget_capability("player", "deleteShuffleProfile"),
      Some(PLAYER_CONTROL)
    );
    assert_eq!(
      widget_capability("player", "setSmartShuffleConfig"),
      Some(PLAYER_CONTROL)
    );
    assert_eq!(
      widget_capability("player", "setAdvanceList"),
      Some(PLAYER_CONTROL)
    );
    assert_eq!(
      widget_capability("player", "setVolume"),
      Some(PLAYER_VOLUME_WRITE)
    );
    assert_eq!(widget_capability("player", "addSource"), None);
    assert_eq!(widget_capability("queue", "get"), Some(QUEUE_READ));
    assert_eq!(widget_capability("queue", "add"), Some(QUEUE_WRITE));
    assert_eq!(widget_capability("queue", "remove"), Some(QUEUE_WRITE));
    assert_eq!(widget_capability("queue", "playAt"), Some(QUEUE_WRITE));
    assert_eq!(
      widget_capability("library", "getCoverUrl"),
      Some(MEDIA_LIBRARY_READ)
    );
    assert_eq!(
      widget_capability("library", "listDirectory"),
      Some(MEDIA_LIBRARY_DIRECTORY_READ)
    );
    assert_eq!(
      widget_capability("library", "addSource"),
      Some(MEDIA_LIBRARY_SOURCES_WRITE)
    );
    assert_eq!(
      widget_capability("favorites", "list"),
      Some(MEDIA_LIBRARY_READ)
    );
    assert_eq!(
      widget_capability("favorites", "set"),
      Some(MEDIA_LIBRARY_FAVORITES_WRITE)
    );
    assert_eq!(widget_capability("library", "removeSource"), None);
    assert_eq!(
      widget_capability("folders", "add"),
      Some(MEDIA_LIBRARY_SOURCES_WRITE)
    );
    assert_eq!(
      widget_capability("folders", "scan"),
      Some(MEDIA_LIBRARY_SOURCES_WRITE)
    );
    assert_eq!(
      widget_capability("folders", "addSingles"),
      Some(MEDIA_LIBRARY_SOURCES_WRITE)
    );
    assert_eq!(widget_capability("folders", "list"), None);
    assert_eq!(widget_capability("folders", "remove"), None);
    assert_eq!(widget_capability("folders", "removeTrack"), None);
  }

  #[test]
  fn widget_topics_require_matching_read_capability() {
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
    assert_eq!(widget_topic_capability("player.state"), Some(PLAYER_READ));
    assert_eq!(widget_topic_capability("queue.changed"), Some(QUEUE_READ));
    assert_eq!(
      widget_topic_capability("library.changed"),
      Some(MEDIA_LIBRARY_READ)
    );
  }

  #[test]
  fn widget_topics_are_the_union_of_granted_read_caps() {
    let topics = widget_topics_for(&granted(&[PLAYER_READ, QUEUE_READ]));
    assert!(topics.contains(&"player.state"));
    assert!(topics.contains(&"queue.changed"));
    assert!(!topics.contains(&"noise.state"));

    let noise = widget_topics_for(&granted(&[SESSION_READ]));
    assert_eq!(noise.len(), 5);
    assert!(noise.contains(&"noise.session.changed"));
    assert!(!noise.contains(&"noise.track.added"));
  }

  #[test]
  fn official_noise_matrix_keeps_player_out() {
    assert!(official_noise_allowed("settings", "importAssets").is_ok());
    assert!(official_noise_allowed("noise-library", "importAssets").is_ok());
    assert!(official_noise_allowed("noise-library", "importPreset").is_ok());
    assert!(official_noise_allowed("noise", "playSession").is_ok());
    assert!(official_noise_allowed("noise", "importAssets").is_err());
    assert!(official_noise_allowed("library", "listAssets").is_ok());
    assert!(official_noise_allowed("library", "playSession").is_err());
    assert!(official_noise_allowed("player", "getState").is_err());
  }

  #[test]
  fn noise_library_window_subscribes_to_noise_topics() {
    let topics = official_topics("noise-library");
    assert!(topics.contains(&"noise.session.changed"));
    assert!(topics.contains(&"noise.level"));
    assert!(!topics.contains(&"player.state"));
    assert!(official_topics("backdrop").is_empty());
  }
}
