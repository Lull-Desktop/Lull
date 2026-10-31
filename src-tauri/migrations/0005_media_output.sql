-- N1: global output volume (Master Output Volume).
--
-- 这是 Music + Noise 进入音频设备前共享的最后一极增益，和 Windows 系统音量、
-- Music Volume、Noise Master Volume 分开。`music.db` 继续作为统一 Media DB；
-- Noise 的 noise_* 表在后续迁移中加入。

CREATE TABLE media_output (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  volume REAL NOT NULL DEFAULT 1.0 CHECK (volume >= 0.0 AND volume <= 1.0),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  updated_at INTEGER NOT NULL
);

INSERT INTO media_output (id, volume, muted, updated_at)
VALUES (1, 1.0, 0, 0);
