//! 宿主提供的功能槽位（Slot）静态定义。
//!
//! Slot 是宿主概念：第三方只能通过 `widget.json` 的 `provides` 声明自己提供某个 Slot，
//! 不能创建 Slot。新增 Slot 必须随宿主版本发布，并补齐对应的服务与能力。

use crate::widget_package::manifest::ProviderDecl;

/// 当前 Slot 契约版本；`provides[].version` 必须与它兼容。
pub const SLOT_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
pub struct SlotDef {
  pub id: &'static str,
  pub name_key: &'static str,
  pub description_key: &'static str,
  /// 展示分类；不是独立实体，避免和 Slot 漂移。
  pub category: &'static str,
  /// 默认 Provider；官方包升级后也保持这个 id。
  pub default_provider: &'static str,
  /// 缺少任一必需能力时不允许安装 / 选择。
  pub required: &'static [&'static str],
  /// 缺少时只提示，不阻断。
  pub recommended: &'static [&'static str],
}

pub const SLOTS: &[SlotDef] = &[
  SlotDef {
    id: "music-player",
    name_key: "slot_music_player_name",
    description_key: "slot_music_player_description",
    category: "audio",
    default_provider: "player",
    required: &["widget.media", "media.player.read", "media.player.control"],
    recommended: &[
      "media.player.volume.write",
      "media.queue.read",
      "media.queue.write",
      "media.library.read",
      "media.library.directory.read",
      "media.library.favorites.write",
    ],
  },
  SlotDef {
    id: "noise-controller",
    name_key: "slot_noise_controller_name",
    description_key: "slot_noise_controller_description",
    category: "audio",
    default_provider: "noise",
    required: &[
      "widget.media",
      "media.noise.session.read",
      "media.noise.session.control",
    ],
    recommended: &[
      "media.noise.tracks.read",
      "media.noise.tracks.write",
      "media.noise.volume.write",
      "media.noise.presets.read",
      "media.noise.presets.write",
      "media.noise.library.read",
    ],
  },
];

#[must_use]
pub fn find(slot: &str) -> Option<&'static SlotDef> {
  SLOTS.iter().find(|candidate| candidate.id == slot)
}

#[must_use]
pub fn slot_for_provides(provides: &[ProviderDecl]) -> Option<&'static SlotDef> {
  provides.iter().find_map(|provider| find(&provider.slot))
}

#[must_use]
pub fn is_known(slot: &str) -> bool {
  find(slot).is_some()
}

/// 已声明但宿主不支持的 Slot（用于安装提示）。
#[must_use]
pub fn unknown_declared_slots(provides: &[ProviderDecl]) -> Vec<&str> {
  provides
    .iter()
    .map(|provider| provider.slot.as_str())
    .filter(|slot| !is_known(slot))
    .collect()
}

/// 版本是否受当前宿主支持。
#[must_use]
pub fn supports_version(version: u32) -> bool {
  version == SLOT_API_VERSION
}

/// 声明能力里缺少的必需能力。
#[must_use]
pub fn missing_required(slot: &SlotDef, declared: &[String]) -> Vec<&'static str> {
  slot
    .required
    .iter()
    .copied()
    .filter(|capability| !declared.iter().any(|item| item == capability))
    .collect()
}

/// 声明能力里缺少的推荐能力。
#[must_use]
pub fn missing_recommended(slot: &SlotDef, declared: &[String]) -> Vec<&'static str> {
  slot
    .recommended
    .iter()
    .copied()
    .filter(|capability| !declared.iter().any(|item| item == capability))
    .collect()
}

/// 渠道能力里缺少的必需能力（用于运行前复核 granted）。
#[must_use]
pub fn missing_granted(slot: &SlotDef, granted: &[String]) -> Vec<&'static str> {
  slot
    .required
    .iter()
    .copied()
    .filter(|capability| !granted.iter().any(|item| item == capability))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn decl(slot: &str, version: u32) -> ProviderDecl {
    ProviderDecl {
      slot: slot.to_string(),
      version,
    }
  }

  #[test]
  fn known_slots_are_stable() {
    assert!(is_known("music-player"));
    assert!(is_known("noise-controller"));
    assert!(!is_known("pomodoro"));
    assert_eq!(
      find("music-player").map(|slot| slot.default_provider),
      Some("player")
    );
    assert_eq!(
      find("noise-controller").map(|slot| slot.default_provider),
      Some("noise")
    );
  }

  #[test]
  fn slot_for_provides_prefers_known_slot() {
    let provides = vec![decl("unknown-slot", 1), decl("music-player", 1)];
    assert_eq!(
      slot_for_provides(&provides).map(|slot| slot.id),
      Some("music-player")
    );
    assert_eq!(unknown_declared_slots(&provides), vec!["unknown-slot"]);
  }

  #[test]
  fn version_and_capability_checks() {
    assert!(supports_version(1));
    assert!(!supports_version(2));
    let slot = find("music-player").expect("music-player");
    let declared = vec!["widget.media".to_string(), "media.player.read".to_string()];
    assert_eq!(
      missing_required(slot, &declared),
      vec!["media.player.control"]
    );
    let granted = vec![
      "widget.media".to_string(),
      "media.player.read".to_string(),
      "media.player.control".to_string(),
    ];
    assert!(missing_granted(slot, &granted).is_empty());
  }
}
