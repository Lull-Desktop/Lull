-- P2: durable playback and default noise mix.
--
-- 播放进度只在暂停/停止/切歌/退出时落盘；引擎每 250ms 的进度只存在内存与事件里。
-- 队列保存 Track 引用，Track 删除时级联移除。

CREATE TABLE player_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_track_id TEXT REFERENCES music_tracks (id) ON DELETE SET NULL,
  position_ms INTEGER NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0.78,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'sequence'
    CHECK (mode IN ('sequence', 'shuffle', 'repeat-one')),
  updated_at INTEGER NOT NULL
);

INSERT INTO player_state (id, volume, mode, updated_at)
VALUES (1, 0.78, 'sequence', 0);

CREATE TABLE player_queue (
  position INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL UNIQUE REFERENCES music_tracks (id) ON DELETE CASCADE
);

CREATE TABLE noise_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  master REAL NOT NULL DEFAULT 0.75,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  sleep_minutes INTEGER NOT NULL DEFAULT 0,
  sleep_ends_at INTEGER,
  layers_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

INSERT INTO noise_state (id, layers_json, updated_at) VALUES
  (1, '[{"soundId":"rain","enabled":true,"volume":0.7},{"soundId":"thunder","enabled":false,"volume":0.45},{"soundId":"wind","enabled":true,"volume":0.3},{"soundId":"waves","enabled":false,"volume":0.4},{"soundId":"fire","enabled":true,"volume":0.5}]', 0);
