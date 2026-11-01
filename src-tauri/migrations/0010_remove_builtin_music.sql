-- 移除默认/内置曲库。
--
-- 早期版本会把 `music_tracks(kind='builtin')` 的“Lull 精选”与
-- `music_sources(kind='builtin')` seed 进数据库。这些曲目已不再需要，
-- 这里删除数据并清理只由它们产生的孤立艺术家。
--
-- 只删数据库记录；音频引擎、封面/歌词资产文件不受影响。Track 删除会
-- 级联清理播放队列、歌单引用、收藏、历史、标签、歌词与搜索索引。

CREATE TABLE migration_builtin_artists AS
SELECT DISTINCT artist_id
FROM music_track_artists
WHERE track_id IN (SELECT id FROM music_tracks WHERE kind = 'builtin');

DELETE FROM music_tracks WHERE kind = 'builtin';
DELETE FROM music_sources WHERE kind = 'builtin';
DELETE FROM app_meta WHERE key = 'catalog_seed_version';

DELETE FROM music_artists
WHERE id IN (SELECT artist_id FROM migration_builtin_artists)
  AND NOT EXISTS (
    SELECT 1 FROM music_track_artists ta WHERE ta.artist_id = music_artists.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM music_albums al WHERE al.album_artist_id = music_artists.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM music_artists child WHERE child.merged_into_id = music_artists.id
  );

DROP TABLE migration_builtin_artists;

UPDATE app_meta SET value = '10' WHERE key = 'schema_version';
