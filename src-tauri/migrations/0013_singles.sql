-- 单曲导入：没有物理根目录的「单曲导入」目录 + 每首曲目的绝对文件路径。
--
-- 目录导入仍然使用 root_path + relative_path 定位文件；单曲导入的文件来自
-- 任意目录，因此单独记录绝对路径，并允许同一目录下出现同名文件（relative_path
-- 只用于显示，唯一性由 file_path 保证）。

ALTER TABLE music_tracks ADD COLUMN file_path TEXT;

DROP INDEX IF EXISTS music_tracks_folder_relative;
CREATE UNIQUE INDEX music_tracks_folder_relative
  ON music_tracks (folder_id, relative_path)
  WHERE file_path IS NULL;
CREATE UNIQUE INDEX music_tracks_file_path
  ON music_tracks (file_path COLLATE NOCASE)
  WHERE file_path IS NOT NULL;

UPDATE app_meta SET value = '13' WHERE key = 'schema_version';
