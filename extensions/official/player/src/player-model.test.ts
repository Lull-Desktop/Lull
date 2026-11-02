/**
 * 播放器纯函数测试：曲名解析、时间格式、模式循环、随机切歌与偏好读取。
 */
import { beforeEach, expect, test } from "vitest";
import {
  clampVolume,
  coverPalette,
  coverToneForText,
  formatClock,
  formatTrackDuration,
  nextIndexForMode,
  nextPlayMode,
  type PlayerTrack,
  parseTrackName,
  persistPlayerPrefs,
  playModeLabel,
  previousIndex,
  readPlayerPrefs,
  totalDuration,
} from "./player-model";
import { resetStorageForTests, writeStorage } from "./storage";

beforeEach(() => {
  resetStorageForTests();
});

test("时间格式化：时钟、占位符与非法值", () => {
  expect(formatClock(0)).toBe("00:00");
  expect(formatClock(154.4)).toBe("02:34");
  expect(formatClock(252)).toBe("04:12");
  expect(formatClock(Number.NaN)).toBe("00:00");
  expect(formatTrackDuration(0)).toBe("--:--");
  expect(formatTrackDuration(252)).toBe("04:12");
});

test("曲名解析支持 Artist - Title 与无艺术家兜底", () => {
  expect(parseTrackName("Artist - Title.mp3")).toEqual({
    artist: "Artist",
    title: "Title",
  });
  expect(parseTrackName("夜航.flac")).toEqual({
    artist: "本地曲目",
    title: "夜航",
  });
  expect(parseTrackName(" - .wav")).toEqual({
    artist: "本地曲目",
    title: "未命名音频",
  });
});

test("播放模式按顺序循环，并带中文标签", () => {
  expect(nextPlayMode("sequence")).toBe("shuffle");
  expect(nextPlayMode("shuffle")).toBe("repeat-one");
  expect(nextPlayMode("repeat-one")).toBe("sequence");
  expect(playModeLabel("repeat-one")).toBe("单曲循环");
});

test("随机切歌避开当前曲目，单曲列表不会越界", () => {
  expect(nextIndexForMode(0, 6, "sequence")).toBe(1);
  expect(nextIndexForMode(5, 6, "sequence")).toBe(0);
  expect(nextIndexForMode(2, 6, "shuffle", () => 0)).toBe(3);
  expect(nextIndexForMode(2, 6, "shuffle", () => 0.999)).toBe(1);
  expect(nextIndexForMode(0, 1, "shuffle")).toBe(0);
  expect(previousIndex(0, 6)).toBe(5);
});

test("封面色板循环取用，本地文件名哈希稳定", () => {
  expect(coverPalette(0).id).toBe("aurora-lake");
  expect(coverPalette(6).id).toBe("aurora-lake");
  expect(coverPalette(-1).id).toBe("last-light");
  expect(coverToneForText("Artist-Title")).toBe(
    coverToneForText("Artist-Title"),
  );
});

test("本地曲目时长累加", () => {
  const tracks: PlayerTrack[] = [
    { id: "a", title: "A", artist: "", duration: 120, tone: 0 },
    { id: "b", title: "B", artist: "", duration: 60, tone: 1 },
  ];
  expect(totalDuration(tracks)).toBe(180);
  expect(totalDuration([])).toBe(0);
});

test("音量夹取与偏好持久化", () => {
  expect(clampVolume(-8)).toBe(0);
  expect(clampVolume(108)).toBe(100);
  expect(clampVolume(Number.NaN)).toBe(78);

  persistPlayerPrefs({ mode: "repeat-one", volume: 42 });
  expect(readPlayerPrefs()).toEqual({ mode: "repeat-one", volume: 42 });

  writeStorage("v1", JSON.stringify({ mode: "nope", volume: 999 }));
  expect(readPlayerPrefs()).toEqual({ volume: 100 });
});
