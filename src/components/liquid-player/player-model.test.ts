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
  ONLINE_TRACKS,
  parseTrackName,
  persistPlayerPrefs,
  playModeLabel,
  previousIndex,
  readPlayerPrefs,
  totalDuration,
} from "./player-model";

beforeEach(() => {
  window.localStorage.clear();
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
  expect(parseTrackName("Aurora Lane - Beyond the Horizon.mp3")).toEqual({
    artist: "Aurora Lane",
    title: "Beyond the Horizon",
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
  expect(coverToneForText("Aurora Lane-Beyond the Horizon")).toBe(
    coverToneForText("Aurora Lane-Beyond the Horizon"),
  );
});

test("在线精选时长与本地目录时长累加", () => {
  expect(totalDuration(ONLINE_TRACKS)).toBe(252 + 236 + 265 + 228 + 260 + 312);
  expect(totalDuration([])).toBe(0);
});

test("音量夹取与偏好持久化", () => {
  expect(clampVolume(-8)).toBe(0);
  expect(clampVolume(108)).toBe(100);
  expect(clampVolume(Number.NaN)).toBe(78);

  persistPlayerPrefs({ mode: "repeat-one", volume: 42 });
  expect(readPlayerPrefs()).toEqual({ mode: "repeat-one", volume: 42 });

  window.localStorage.setItem(
    "lull:player:v1",
    JSON.stringify({ mode: "nope", volume: 999 }),
  );
  expect(readPlayerPrefs()).toEqual({ volume: 100 });
});
