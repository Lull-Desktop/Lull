import { describe, expect, test, vi } from "vitest";
import { alignVideoPhase, loopDistance, videoPhase } from "./phase";

describe("videoPhase", () => {
  test("按墙钟把播放位置折算到循环内", () => {
    expect(videoPhase(2500, 10)).toBe(2.5);
    expect(videoPhase(14_500, 10)).toBeCloseTo(4.5, 5);
    // 时钟回拨到负值也要落在 [0, duration)。
    expect(videoPhase(-2500, 10)).toBeCloseTo(7.5, 5);
  });

  test("rate 参与相位换算", () => {
    expect(videoPhase(2500, 10, 2)).toBe(5);
    expect(videoPhase(14_500, 10, 2)).toBeCloseTo(9, 5);
  });

  test("时长不可用时返回 null", () => {
    expect(videoPhase(2500, Number.NaN)).toBeNull();
    expect(videoPhase(2500, 0)).toBeNull();
    expect(videoPhase(2500, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("loopDistance", () => {
  test("把循环两端视为同一帧", () => {
    expect(loopDistance(0.2, 9.9, 10)).toBeCloseTo(0.3, 5);
    expect(loopDistance(2, 8, 10)).toBe(4);
  });
});

describe("alignVideoPhase", () => {
  test("偏差超过容差时 seek 到目标相位", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(12_345));
    const video = document.createElement("video");
    Object.defineProperty(video, "duration", {
      value: 10,
      configurable: true,
    });
    video.currentTime = 0;

    alignVideoPhase(video, 0.5);
    expect(video.currentTime).toBeCloseTo(2.345, 2);
    vi.useRealTimers();
  });

  test("偏差在容差内不 seek", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(12_345));
    const video = document.createElement("video");
    Object.defineProperty(video, "duration", {
      value: 10,
      configurable: true,
    });
    video.currentTime = 2.2;

    alignVideoPhase(video, 0.5);
    expect(video.currentTime).toBe(2.2);
    vi.useRealTimers();
  });
});
