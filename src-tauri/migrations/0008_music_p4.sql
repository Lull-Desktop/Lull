-- P4: music tags, smart playlists, and metadata-edit support.
--
-- Individual field sources already live in `music_field_sources`; manual edits use
-- source='manual' / 'split'. Smart playlists store a rule snapshot and are evaluated
-- at read time so they never go stale.

CREATE TABLE music_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (normalized_name)
);

CREATE INDEX music_tags_name ON music_tags (name COLLATE NOCASE);

CREATE TABLE music_track_tags (
  track_id TEXT NOT NULL REFERENCES music_tracks (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES music_tags (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, tag_id)
);

CREATE INDEX music_track_tags_tag ON music_track_tags (tag_id);

CREATE TABLE music_smart_playlists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  rules_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
