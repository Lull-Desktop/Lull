-- MusicFolder 1:N MusicTrack.
--
-- 沿用现有 music_sources(kind='local') 作为物理目录，不新建表、不重建
-- music_scan_runs、不改内置曲 seed；只把文件定位与文件元数据前移到
-- music_tracks，并删除多余的 music_files 中间层。
--
-- 约定：
-- - music_tracks.folder_id 指向 music_sources(id)；内置曲为 NULL。
-- - relative_path 统一使用 '/'，绝对路径由 source.root_path + relative_path 得到。
-- - file_name 新扫描时写入；旧数据留空，读取时由 relative_path 兜底。
-- - 旧库多文件 Track 只保留主文件（available DESC, lower(format), id），
--   其余文件下次扫描会作为独立 Track 重新出现。

ALTER TABLE music_sources ADD COLUMN recursive INTEGER NOT NULL DEFAULT 1
  CHECK (recursive IN (0, 1));

ALTER TABLE music_tracks ADD COLUMN folder_id TEXT
  REFERENCES music_sources (id) ON DELETE CASCADE;
ALTER TABLE music_tracks ADD COLUMN relative_path TEXT;
ALTER TABLE music_tracks ADD COLUMN file_name TEXT;
ALTER TABLE music_tracks ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE music_tracks ADD COLUMN file_modified_at INTEGER;
ALTER TABLE music_tracks ADD COLUMN format TEXT;
ALTER TABLE music_tracks ADD COLUMN bitrate INTEGER;
ALTER TABLE music_tracks ADD COLUMN sample_rate INTEGER;

CREATE TABLE migration_primary_files AS
SELECT mf.track_id,
       mf.source_id AS folder_id,
       mf.relative_path,
       mf.format,
       mf.size_bytes,
       mf.mtime_ms,
       mf.bitrate,
       mf.sample_rate
FROM music_files mf
WHERE mf.id = (
  SELECT x.id
  FROM music_files x
  WHERE x.track_id = mf.track_id
  ORDER BY x.available DESC, lower(x.format), x.id
  LIMIT 1
);

UPDATE music_tracks
SET folder_id = (SELECT folder_id FROM migration_primary_files p WHERE p.track_id = music_tracks.id),
    relative_path = (SELECT relative_path FROM migration_primary_files p WHERE p.track_id = music_tracks.id),
    file_size = COALESCE((SELECT size_bytes FROM migration_primary_files p WHERE p.track_id = music_tracks.id), 0),
    file_modified_at = (SELECT mtime_ms FROM migration_primary_files p WHERE p.track_id = music_tracks.id),
    format = (SELECT format FROM migration_primary_files p WHERE p.track_id = music_tracks.id),
    bitrate = (SELECT bitrate FROM migration_primary_files p WHERE p.track_id = music_tracks.id),
    sample_rate = (SELECT sample_rate FROM migration_primary_files p WHERE p.track_id = music_tracks.id)
WHERE id IN (SELECT track_id FROM migration_primary_files);

DROP TABLE migration_primary_files;

-- 旧来源删除后遗留的空壳 Track：没有任何文件记录，也不属于任何目录。
DELETE FROM music_tracks WHERE kind = 'file' AND folder_id IS NULL;

DROP TABLE music_files;
DROP TABLE music_folders;

CREATE UNIQUE INDEX music_tracks_folder_relative
  ON music_tracks (folder_id, relative_path);
CREATE INDEX music_tracks_folder ON music_tracks (folder_id);
CREATE INDEX music_tracks_format ON music_tracks (format);

UPDATE app_meta SET value = '9' WHERE key = 'schema_version';
