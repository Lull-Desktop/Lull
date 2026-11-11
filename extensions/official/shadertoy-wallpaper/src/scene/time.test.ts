import { describe, expect, test } from "vitest";
import { createShaderClock, syncEnabled } from "./time";

function setup(start = new Date(2026, 10, 11, 12, 0, 0, 0)) {
  let wall = start.getTime();
  let perf = 1_000;
  const clock = createShaderClock({
    now: () => wall,
    perfNow: () => perf,
  });
  return {
    clock,
    advance(ms: number) {
      wall += ms;
      perf += ms;
    },
    setWall(value: Date) {
      wall = value.getTime();
      perf += 0;
    },
  };
}

describe("syncEnabled", () => {
  test("only true when the host enables sync", () => {
    expect(syncEnabled({ enabled: true, epochMs: 0 })).toBe(true);
    expect(syncEnabled({ enabled: false, epochMs: 0 })).toBe(false);
    expect(syncEnabled(undefined)).toBe(false);
  });
});

describe("createShaderClock", () => {
  test("independent mode starts at zero and accumulates frame deltas", () => {
    const { clock, advance } = setup();
    const first = clock.tick();
    expect(first.time).toBe(0);
    expect(first.frame).toBe(1);
    advance(16);
    const second = clock.tick();
    expect(second.delta).toBeCloseTo(0.016, 5);
    expect(second.time).toBeCloseTo(0.016, 5);
    expect(second.frame).toBe(2);
  });

  test("pausing freezes time and resuming does not jump", () => {
    const { clock, advance } = setup();
    clock.tick();
    advance(16);
    clock.tick();
    const before = clock.tick().time;

    clock.setPaused(true);
    advance(5_000);
    const pausedFrame = clock.tick();
    expect(pausedFrame.time).toBeCloseTo(before, 5);
    expect(pausedFrame.delta).toBe(0);

    clock.setPaused(false);
    advance(16);
    const resumed = clock.tick();
    // 恢复后的第一帧只用来重建基准，delta 为 0，避免出现一个巨大的时间跳变。
    expect(resumed.time).toBeCloseTo(before, 3);
    expect(resumed.delta).toBe(0);

    advance(16);
    const next = clock.tick();
    expect(next.delta).toBeCloseTo(0.016, 5);
  });

  test("sync mode follows the local wall clock phase", () => {
    const { clock, advance } = setup();
    clock.setSync(true);
    clock.restart();
    expect(clock.tick().time).toBeCloseTo(12 * 3600, 3);
    advance(1_000);
    expect(clock.tick().time).toBeCloseTo(12 * 3600 + 1, 3);
  });

  test("sync mode ignores ticks while paused", () => {
    const { clock, advance } = setup();
    clock.setSync(true);
    clock.restart();
    const before = clock.tick().time;
    clock.setPaused(true);
    advance(5_000);
    expect(clock.tick().time).toBeCloseTo(before, 3);
  });

  test("sync mode subtracts paused wall time", () => {
    const { clock, advance } = setup();
    clock.setSync(true);
    clock.restart();
    const before = clock.tick().time;

    clock.setPaused(true);
    advance(5_000);
    clock.setPaused(false);
    advance(16);
    expect(clock.tick().time).toBeCloseTo(before + 0.016, 3);
  });

  test("sync mode stays non-negative when a pause crosses midnight", () => {
    const { clock, advance } = setup(new Date(2026, 10, 11, 23, 59, 30, 0));
    clock.setSync(true);
    clock.restart();
    expect(clock.tick().time).toBeCloseTo(23 * 3600 + 59 * 60 + 30, 3);

    clock.setPaused(true);
    advance(120_000);
    clock.setPaused(false);
    const resumed = clock.tick();
    expect(resumed.time).toBeGreaterThanOrEqual(0);
    expect(resumed.time).toBeCloseTo(23 * 3600 + 59 * 60 + 30, 3);
  });

  test("restart resets frame count and independent time", () => {
    const { clock, advance } = setup();
    clock.tick();
    advance(16);
    clock.tick();
    clock.restart();
    const restarted = clock.peek();
    expect(restarted.time).toBe(0);
    expect(restarted.frame).toBe(0);
    expect(clock.tick().time).toBe(0);
  });
});
