-- Lull Music Library v1: sources, files, tracks, artists, albums, metadata,
-- content-addressed assets, lyrics, scan runs and a materialized search table.
--
-- 约定：
-- - 所有时间戳是 Unix 毫秒；所有 ID 是 TEXT。
-- - music_files 是磁盘文件，music_tracks 是可播放的音乐实体；一个 Track 可以
--   有多个文件（例如 FLAC + MP3 副本），文件移动不应改变 Track 身份。
-- - root_path / path / storage_key 只允许 Rust 后端读取，不进入公开 DTO。
-- - 普通重扫只更新 imported/normalized 与未被保护的关系；用户覆盖和人工整理
--   由 music_field_sources / music_track_artists.source 等字段保护。

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value) VALUES
  ('schema_version', '1'),
  ('revision', '0'),
  ('catalog_seed_version', '0'),
  ('search_backend', 'like');

CREATE TABLE music_sources (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'builtin')),
  name TEXT NOT NULL,
  root_path TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'scanning', 'missing', 'error')),
  last_scan_at INTEGER,
  last_scan_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX music_sources_root_path
  ON music_sources (root_path)
  WHERE root_path IS NOT NULL;

CREATE TABLE music_folders (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES music_sources (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES music_folders (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, path)
);

CREATE INDEX music_folders_parent ON music_folders (parent_id);

CREATE TABLE music_tracks (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'builtin')),
  title TEXT NOT NULL,
  sort_title TEXT,
  version_label TEXT,
  duration_ms INTEGER,
  year INTEGER,
  is_instrumental INTEGER NOT NULL DEFAULT 0 CHECK (is_instrumental IN (0, 1)),
  playback_preset_json TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'missing')),
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX music_tracks_title ON music_tracks (title);
CREATE INDEX music_tracks_status ON music_tracks (status);
CREATE INDEX music_tracks_kind ON music_tracks (kind);

CREATE TABLE music_files (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES music_sources (id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES music_folders (id) ON DELETE SET NULL,
  track_id TEXT REFERENCES music_tracks (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER,
  fingerprint TEXT,
  content_hash TEXT,
  raw_tags_json TEXT,
  duration_ms INTEGER,
  bitrate INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  last_seen_scan_id TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_id, path_key)
);

CREATE INDEX music_files_track ON music_files (track_id);
CREATE INDEX music_files_folder ON music_files (folder_id);
CREATE INDEX music_files_available ON music_files (available);
CREATE INDEX music_files_format ON music_files (format);

CREATE TABLE music_artists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  sort_name TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (kind IN ('person', 'group', 'various', 'unknown')),
  merged_into_id TEXT REFERENCES music_artists (id) ON DELETE SET NULL,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX music_artists_name ON music_artists (name);
CREATE INDEX music_artists_merged ON music_artists (merged_into_id);

CREATE TABLE music_artist_aliases (
  artist_id TEXT NOT NULL REFERENCES music_artists (id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'import',
  PRIMARY KEY (artist_id, normalized_alias)
);

CREATE INDEX music_artist_aliases_normalized
  ON music_artist_aliases (normalized_alias);

CREATE TABLE music_albums (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  sort_title TEXT,
  year INTEGER,
  album_artist_id TEXT REFERENCES music_artists (id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'album'
    CHECK (kind IN ('album', 'single', 'compilation', 'soundtrack')),
  merged_into_id TEXT REFERENCES music_albums (id) ON DELETE SET NULL,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX music_albums_title ON music_albums (title);
CREATE INDEX music_albums_artist ON music_albums (album_artist_id);
CREATE INDEX music_albums_merged ON music_albums (merged_into_id);

CREATE TABLE music_album_aliases (
  album_id TEXT NOT NULL REFERENCES music_albums (id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'import',
  PRIMARY KEY (album_id, normalized_alias)
);

CREATE INDEX music_album_aliases_normalized
  ON music_album_aliases (normalized_alias);

CREATE TABLE music_track_artists (
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES music_artists (id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('primary', 'featured', 'composer', 'lyricist', 'arranger', 'album_artist')),
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'import'
    CHECK (source IN ('import', 'filename', 'online', 'manual', 'split')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id, role)
);

CREATE INDEX music_track_artists_artist ON music_track_artists (artist_id);

CREATE TABLE music_track_albums (
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES music_albums (id) ON DELETE CASCADE,
  disc_number INTEGER,
  track_number INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'import'
    CHECK (source IN ('import', 'filename', 'online', 'manual', 'split')),
  PRIMARY KEY (track_id, album_id)
);

CREATE UNIQUE INDEX music_track_albums_primary
  ON music_track_albums (track_id)
  WHERE is_primary = 1;

CREATE INDEX music_track_albums_album ON music_track_albums (album_id);

CREATE TABLE music_track_metadata (
  track_id TEXT PRIMARY KEY NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  imported_json TEXT NOT NULL DEFAULT '{}',
  normalized_json TEXT NOT NULL DEFAULT '{}',
  overrides_json TEXT NOT NULL DEFAULT '{}',
  online_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE music_field_sources (
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('import', 'filename', 'online', 'manual', 'split')),
  provider TEXT,
  confidence REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, field)
);

CREATE TABLE music_assets (
  id TEXT PRIMARY KEY NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('cover', 'lyrics', 'artist_image')),
  content_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (content_hash, asset_type)
);

CREATE TABLE music_track_assets (
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES music_assets (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('cover', 'artist_image')),
  source TEXT NOT NULL CHECK (source IN ('embedded', 'folder', 'user', 'online')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, asset_id, role)
);

CREATE UNIQUE INDEX music_track_assets_cover_primary
  ON music_track_assets (track_id)
  WHERE role = 'cover' AND is_primary = 1;

CREATE TABLE music_lyrics (
  id TEXT PRIMARY KEY NOT NULL,
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  format TEXT NOT NULL
    CHECK (format IN ('lrc', 'vtt', 'ttml', 'qrc', 'yrc', 'krc', 'embedded')),
  source TEXT NOT NULL CHECK (source IN ('sidecar', 'embedded', 'user', 'online')),
  content TEXT NOT NULL,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  content_hash TEXT,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX music_lyrics_primary
  ON music_lyrics (track_id)
  WHERE is_primary = 1;

CREATE TABLE music_scan_runs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT REFERENCES music_sources (id) ON DELETE SET NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'cancelled', 'failed', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX music_scan_runs_source ON music_scan_runs (source_id, started_at);

CREATE TABLE music_search_text (
  track_id TEXT PRIMARY KEY NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  search_text TEXT NOT NULL
);
