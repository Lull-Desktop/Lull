ALTER TABLE noise_preset_tracks ADD COLUMN environment_json TEXT;
UPDATE app_meta SET value = '14' WHERE key = 'schema_version';
