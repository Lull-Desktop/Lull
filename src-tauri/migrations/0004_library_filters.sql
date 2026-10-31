-- P1 filters: lightweight genre tag on tracks (full tag entities remain P4).
ALTER TABLE music_tracks ADD COLUMN genre TEXT;
CREATE INDEX music_tracks_genre ON music_tracks (genre);
