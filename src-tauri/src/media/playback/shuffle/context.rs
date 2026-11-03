//! 智能随机选曲的输入数据：候选特征、最近播放与当前曲目。
//!
//! 这些类型不访问数据库；由 `playback` 查询后组装，Strategy/Engine 只消费。

/// 最近播放窗口：超过 6 小时的历史不再参与。
pub const RECENT_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;
/// 读取的最近播放条数上限。
pub const RECENT_LIMIT: usize = 32;

/// 参与打分的曲目特征。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrackFeatures {
  /// 主要/合作艺术家 id；同一艺人可能有多个 id，按集合求交。
  pub artists: Vec<String>,
  /// 主专辑 id。
  pub album: Option<String>,
  /// 归一化（trim + 小写）后的曲风。
  pub genre: Option<String>,
  pub favorite: bool,
}

/// 最近播放的一条记录；特征可能缺失（曲目已删除或元数据不可读）。
#[derive(Debug, Clone)]
pub struct RecentPlay {
  pub id: String,
  pub features: Option<TrackFeatures>,
}

/// 候选曲目；顺序来自播放器列表或队列。
#[derive(Debug, Clone)]
pub struct ShuffleCandidate {
  pub id: String,
  pub features: Option<TrackFeatures>,
}

/// 轮次袋对应的候选来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
  /// 播放器同步的当前页签列表（`player.setAdvanceList`）。
  Advance,
  /// 用户队列。
  Queue,
}

/// 一次选曲需要的完整上下文。
#[derive(Debug, Clone)]
pub struct ShuffleContext {
  pub candidates: Vec<ShuffleCandidate>,
  /// 新到旧；第一位通常是当前曲目。
  pub recent: Vec<RecentPlay>,
  pub current: Option<String>,
}
