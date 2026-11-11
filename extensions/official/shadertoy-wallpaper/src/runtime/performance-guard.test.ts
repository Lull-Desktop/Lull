import { describe, expect, test } from "vitest";
import { createPerformanceGuard } from "./performance-guard";

describe("createPerformanceGuard", () => {
  test("stays ok for fast frames", () => {
    const guard = createPerformanceGuard({
      warnMs: 50,
      stopMs: 100,
      warnAfterSeconds: 0.5,
      stopAfterSeconds: 1,
    });
    for (let index = 0; index < 20; index += 1) {
      expect(guard.sample(0.008).level).toBe("ok");
    }
    expect(guard.scaleFactor).toBe(1);
  });

  test("degrades once, then stops when still too slow", () => {
    const guard = createPerformanceGuard({
      warnMs: 50,
      stopMs: 100,
      warnAfterSeconds: 0.5,
      stopAfterSeconds: 1,
    });

    let degraded = false;
    let stopped = false;
    for (let index = 0; index < 20; index += 1) {
      const sample = guard.sample(0.12);
      if (sample.level === "degrade") degraded = true;
      if (sample.level === "stop") {
        stopped = true;
        break;
      }
    }
    expect(degraded).toBe(true);
    expect(stopped).toBe(true);
    expect(guard.scaleFactor).toBe(0.75);
  });

  test("reset restores the initial state", () => {
    const guard = createPerformanceGuard({
      warnMs: 10,
      stopMs: 20,
      warnAfterSeconds: 0.1,
      stopAfterSeconds: 0.2,
    });
    guard.sample(1);
    guard.sample(1);
    guard.reset();
    expect(guard.scaleFactor).toBe(1);
    expect(guard.sample(0.001).level).toBe("ok");
  });
});
