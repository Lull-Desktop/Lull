-- 智能随机 Profile：内置 + 用户自定义配置，以及激活项。
--
-- 旧的单行 player_smart_shuffle 迁移为 user:migrated（我的配置）；
-- 没有旧配置时默认激活内置「均衡随机」。

CREATE TABLE player_shuffle_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX player_shuffle_profiles_builtin
  ON player_shuffle_profiles (builtin, name);

CREATE TABLE player_shuffle_active (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  profile_id TEXT NOT NULL REFERENCES player_shuffle_profiles (id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);

INSERT INTO player_shuffle_profiles
  (id, name, name_key, builtin, config_json, created_at, updated_at)
VALUES
  ('builtin:balanced', '均衡随机', '均衡随机', 1,
   '{"version":1,"experience":{"randomness":60,"diversity":50,"repeatAvoidance":80},"separation":{"artist":3,"album":2},"audioFeatures":{"bpmMatching":30,"energyMatching":30,"moodDiversity":30,"genreDiversity":50}}',
   0, 0),
  ('builtin:random', '高度随机', '高度随机', 1,
   '{"version":1,"experience":{"randomness":90,"diversity":25,"repeatAvoidance":50},"separation":{"artist":1,"album":1},"audioFeatures":{"bpmMatching":30,"energyMatching":30,"moodDiversity":30,"genreDiversity":50}}',
   0, 0),
  ('builtin:diverse', '多样性优先', '多样性优先', 1,
   '{"version":1,"experience":{"randomness":40,"diversity":100,"repeatAvoidance":90},"separation":{"artist":6,"album":4},"audioFeatures":{"bpmMatching":30,"energyMatching":30,"moodDiversity":30,"genreDiversity":50}}',
   0, 0);

INSERT INTO player_shuffle_active (id, profile_id, updated_at)
VALUES (1, 'builtin:balanced', 0);

INSERT INTO player_shuffle_profiles
  (id, name, name_key, builtin, config_json, created_at, updated_at)
SELECT 'user:migrated', '我的配置', '我的配置', 0, config_json, updated_at, updated_at
FROM player_smart_shuffle WHERE id = 1;

UPDATE player_shuffle_active
SET profile_id = 'user:migrated', updated_at = 0
WHERE id = 1
  AND EXISTS (SELECT 1 FROM player_shuffle_profiles WHERE id = 'user:migrated');

DROP TABLE player_smart_shuffle;

UPDATE app_meta SET value = '12' WHERE key = 'schema_version';
