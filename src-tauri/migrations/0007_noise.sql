-- N2: Noise business domain.
--
-- Session/Track are runtime-only; only assets, categories/tags, presets and
-- preferences are persisted. `noise_state` stays untouched for rollback and
-- one-time preference migration; new code only reads `noise_preferences`.

CREATE TABLE noise_sources (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'local', 'community', 'widget')),
  name TEXT NOT NULL,
  root_path TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'missing', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX noise_sources_root_path
  ON noise_sources (root_path)
  WHERE root_path IS NOT NULL;

CREATE TABLE noise_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES noise_categories (id) ON DELETE SET NULL,
  icon TEXT,
  source_type TEXT NOT NULL DEFAULT 'builtin',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX noise_categories_parent ON noise_categories (parent_id);

CREATE TABLE noise_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'builtin',
  created_at INTEGER NOT NULL,
  UNIQUE (normalized_name, source_type)
);

CREATE TABLE noise_assets (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES noise_sources (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('procedural', 'file')),
  format TEXT NOT NULL,
  storage_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  content_hash TEXT,
  generator_json TEXT,
  category_id TEXT REFERENCES noise_categories (id) ON DELETE SET NULL,
  capabilities_json TEXT NOT NULL
    DEFAULT '{"loop":true,"seek":false,"fade":true}',
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'missing', 'invalid')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX noise_assets_content_hash
  ON noise_assets (content_hash)
  WHERE content_hash IS NOT NULL;
CREATE INDEX noise_assets_source ON noise_assets (source_id);
CREATE INDEX noise_assets_category ON noise_assets (category_id);
CREATE INDEX noise_assets_status ON noise_assets (status);
CREATE INDEX noise_assets_name ON noise_assets (name COLLATE NOCASE);

CREATE TABLE noise_asset_tags (
  asset_id TEXT NOT NULL REFERENCES noise_assets (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES noise_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX noise_asset_tags_tag ON noise_asset_tags (tag_id);

CREATE TABLE noise_favorites (
  asset_id TEXT PRIMARY KEY NOT NULL REFERENCES noise_assets (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE noise_presets (
  id TEXT PRIMARY KEY NOT NULL,
  origin_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('builtin', 'user', 'community')),
  author TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  master_volume REAL NOT NULL DEFAULT 1.0,
  cover_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX noise_presets_name ON noise_presets (name COLLATE NOCASE);
CREATE INDEX noise_presets_source ON noise_presets (source_type);

CREATE TABLE noise_preset_tracks (
  id TEXT PRIMARY KEY NOT NULL,
  preset_id TEXT NOT NULL REFERENCES noise_presets (id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES noise_assets (id) ON DELETE SET NULL,
  asset_hash TEXT,
  asset_source_type TEXT,
  asset_source_id TEXT,
  expected_name TEXT NOT NULL,
  volume REAL NOT NULL DEFAULT 1.0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  loop INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (0, 1)),
  fade_in_ms INTEGER,
  fade_out_ms INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX noise_preset_tracks_preset
  ON noise_preset_tracks (preset_id, sort_order);

CREATE TABLE noise_preset_favorites (
  preset_id TEXT PRIMARY KEY NOT NULL REFERENCES noise_presets (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE noise_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  master_volume REAL NOT NULL DEFAULT 0.75,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  last_preset_id TEXT REFERENCES noise_presets (id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO noise_preferences (id, master_volume, muted, updated_at)
SELECT 1, master, muted, updated_at FROM noise_state WHERE id = 1;

INSERT OR IGNORE INTO noise_preferences (id, master_volume, muted, updated_at)
VALUES (1, 0.75, 0, 0);
