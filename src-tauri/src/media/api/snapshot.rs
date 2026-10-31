//! 组装 `media_connect` / `system.snapshot` 的完整状态快照。
//!
//! Player、Queue、Output、Noise 各自持有 revision；顶层 revision 取最大值，供
//! 客户端在 connect 后丢弃旧事件。N1 仍返回旧 5 层 noise 视图；N2 再追加
//! `noiseSession`。

use serde::Serialize;

use super::errors::MediaError;
use super::protocol::PROTOCOL_VERSION;
use crate::media::output::{self, OutputView};
use crate::media::playback;
use crate::media::playback::model::{NoiseStateView, PlayerStateView, QueueStateView};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
  pub protocol: u32,
  pub revision: u64,
  pub player: PlayerStateView,
  pub queue: QueueStateView,
  pub output: OutputView,
  pub noise: NoiseStateView,
}

#[must_use]
pub fn revision() -> u64 {
  playback::revision().max(output::revision())
}

pub fn snapshot() -> Result<PlaybackSnapshot, MediaError> {
  let (player, queue, noise) = playback::snapshot_parts()?;
  Ok(PlaybackSnapshot {
    protocol: PROTOCOL_VERSION,
    revision: revision(),
    player,
    queue,
    output: output::view(),
    noise,
  })
}
