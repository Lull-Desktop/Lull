/**
 * 媒体事件 topic 表。
 *
 * Rust 的 `media_connect` 按窗口 label 保存**一份**订阅（后一次覆盖前一次），
 * `media_disconnect` 清空整份。所以同一个窗口只能有一个 connect 所有者：
 * 该窗口里所有面板共享同一份 topic 并集，面板自己不再 connect/disconnect。
 */

/** 播放器 / 队列。 */
export const PLAYER_TOPICS = ["player.state", "queue.changed"] as const;

/** 白噪音全量：白噪音库窗口直接使用这份列表连接。 */
export const NOISE_WINDOW_TOPICS = [
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
] as const;

/**
 * 设置窗口的唯一订阅：音乐页要播放器/队列，白噪音页要 session/preset 变更。
 * 不订阅进度与电平（设置页不画波形）。
 */
export const SETTINGS_MEDIA_TOPICS = [
  ...PLAYER_TOPICS,
  ...NOISE_WINDOW_TOPICS,
] as const;
