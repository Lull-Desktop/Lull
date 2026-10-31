-- P1 搜索加速：FTS5 trigram 索引。
--
-- 数据源仍是 music_search_text（由 Rust 在 Track/关系/标签变化时维护）；
-- 触发器保持索引同步。trigram 对中文子串和拉丁词都可用；短于 3 字符的
-- 查询仍由 repository 走 LIKE 回退。

CREATE VIRTUAL TABLE music_search_fts USING fts5(
  track_id UNINDEXED,
  search_text,
  tokenize = 'trigram'
);

INSERT INTO music_search_fts (track_id, search_text)
SELECT track_id, search_text FROM music_search_text;

CREATE TRIGGER music_search_text_ai AFTER INSERT ON music_search_text BEGIN
  INSERT INTO music_search_fts (track_id, search_text)
  VALUES (new.track_id, new.search_text);
END;

CREATE TRIGGER music_search_text_ad AFTER DELETE ON music_search_text BEGIN
  DELETE FROM music_search_fts WHERE track_id = old.track_id;
END;

CREATE TRIGGER music_search_text_au AFTER UPDATE ON music_search_text BEGIN
  DELETE FROM music_search_fts WHERE track_id = old.track_id;
  INSERT INTO music_search_fts (track_id, search_text)
  VALUES (new.track_id, new.search_text);
END;

UPDATE app_meta SET value = 'fts5' WHERE key = 'search_backend';
