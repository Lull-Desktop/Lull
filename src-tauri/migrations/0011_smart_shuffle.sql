-- 智能随机配置：面向用户的五项听感参数。
--
-- 轮次袋、历史窗口和权重方向属于算法内部，不落库；这里只保存用户配置，
-- 缺省或损坏时由 Rust 回退到 SmartShuffleConfig::default()。

CREATE TABLE player_smart_shuffle (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

UPDATE app_meta SET value = '11' WHERE key = 'schema_version';
