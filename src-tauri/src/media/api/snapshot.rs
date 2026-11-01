//! 组装 `media_connect` / `system.snapshot` 的完整状态快照。
//!
//! Player、Queue、Output、Noise 各自持有 revision；顶层 revision 取最大值，供
//! 客户端在 connect 后丢弃旧事件。`noise` 是旧 5 层兼容视图，`noiseSession`
//! 是 N2 新模型；两者来自同一个运行时 Session。

use serde::Serialize;

use super::errors::MediaError;
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

#[must_use]
pub fn revision() -> u64 {
  playback::revision()
    .max(output::revision())
    .max(noise::revision())
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
