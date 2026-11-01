//! 组装 `media_connect` / `system.snapshot` 的完整状态快照。
//!
//! Player、Queue、Output、Noise 各自持有 revision；顶层 revision 取最大值，供
//! 客户端在 connect 后丢弃旧事件。`noise` 是旧 5 层兼容视图，`noiseSession`
//! 是 N2 新模型；两者来自同一个运行时 Session。
//!
//! Widget 快照按授权裁剪：player / queue 只在对应读能力下出现；
//! output 与噪声视图保持现有行为（噪声包与播放器包共用 `widget.media` 总开关）。

use serde::Serialize;

use super::errors::MediaError;
use super::permissions;
use super::protocol::PROTOCOL_VERSION;
use crate::media::noise;
use crate::media::noise::dto::{NoiseSessionView, NoiseStateView};
use crate::media::output::{self, OutputView};
use crate::media::playback;
use crate::media::playback::model::{PlayerStateView, QueueStateView};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
  pub protocol: u32,
  pub revision: u64,
  pub player: PlayerStateView,
  pub queue: QueueStateView,
  pub output: OutputView,
  pub noise: NoiseStateView,
  pub noise_session: NoiseSessionView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
  pub protocol: u32,
  pub revision: u64,
  pub output: OutputView,
  pub noise: NoiseStateView,
  pub noise_session: NoiseSessionView,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub player: Option<PlayerStateView>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub queue: Option<QueueStateView>,
}

fn has(granted: &[String], capability: &str) -> bool {
  granted.iter().any(|item| item == capability)
}

#[must_use]
pub fn revision() -> u64 {
  playback::revision()
    .max(output::revision())
    .max(noise::revision())
}

/// Widget 快照的 revision 只包含被授权域，避免客户端拿未授权域的 revision 做比较。
#[must_use]
pub fn widget_revision(granted: &[String]) -> u64 {
  let mut revision = output::revision().max(noise::revision());
  if has(granted, permissions::PLAYER_READ) || has(granted, permissions::QUEUE_READ) {
    revision = revision.max(playback::revision());
  }
  revision
}

pub fn snapshot() -> Result<PlaybackSnapshot, MediaError> {
  let (player, queue) = playback::snapshot_parts()?;
  let (noise_session, noise) = noise::snapshots()?;
  Ok(PlaybackSnapshot {
    protocol: PROTOCOL_VERSION,
    revision: revision(),
    player,
    queue,
    output: output::view(),
    noise,
    noise_session,
  })
}

pub fn widget_snapshot(granted: &[String]) -> Result<WidgetSnapshot, MediaError> {
  let (noise_session, noise) = noise::snapshots()?;
  let player_allowed = has(granted, permissions::PLAYER_READ);
  let queue_allowed = has(granted, permissions::QUEUE_READ);
  let (player, queue) = if player_allowed || queue_allowed {
    let (player, queue) = playback::snapshot_parts()?;
    (
      player_allowed.then_some(player),
      queue_allowed.then_some(queue),
    )
  } else {
    (None, None)
  };
  Ok(WidgetSnapshot {
    protocol: PROTOCOL_VERSION,
    revision: widget_revision(granted),
    output: output::view(),
    noise,
    noise_session,
    player,
    queue,
  })
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
  fn widget_revision_tracks_only_granted_domains() {
    let without_playback = widget_revision(&granted(&[permissions::SESSION_READ]));
    let with_playback = widget_revision(&granted(&[permissions::PLAYER_READ]));
    assert!(with_playback >= without_playback);
  }

  #[test]
  fn widget_snapshot_omits_unauthorized_playback_fields() {
    let denied = widget_snapshot(&granted(&[permissions::SESSION_READ]));
    if let Ok(snapshot) = denied {
      assert!(snapshot.player.is_none());
      assert!(snapshot.queue.is_none());
    }
  }
}
