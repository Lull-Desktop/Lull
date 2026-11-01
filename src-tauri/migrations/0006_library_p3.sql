-- P3: playlists, favorites and play history.
--
-- 播放历史按“一次播放尝试”记录，不做唯一约束；分页按 played_at DESC。
-- 歌单只存 Track 引用与顺序，不复制音频；删除 Track 时歌单引用级联移除。

CREATE TABLE music_playlists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX music_playlists_name ON music_playlists (name COLLATE NOCASE);

CREATE TABLE music_playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES music_playlists (id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX music_playlist_tracks_position
  ON music_playlist_tracks (playlist_id, position);
CREATE INDEX music_playlist_tracks_track
  ON music_playlist_tracks (track_id);

CREATE TABLE music_favorites (
  track_id TEXT PRIMARY KEY NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE music_play_history (
  id TEXT PRIMARY KEY NOT NULL,
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL,
  duration_ms INTEGER,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'play'
);

CREATE INDEX music_play_history_played
  ON music_play_history (played_at DESC);
CREATE INDEX music_play_history_track
  ON music_play_history (track_id, played_at DESC);
