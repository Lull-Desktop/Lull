import { afterEach, describe, expect, test, vi } from "vitest";
import { createStabilityProbe } from "./diagnostics.js";

function rafHarness(): {
  fire(timestamp: number): void;
  pending(): boolean;
} {
  let callback: ((timestamp: number) => void) | null = null;
  globalThis.requestAnimationFrame = ((next: FrameRequestCallback) => {
    callback = next as (timestamp: number) => void;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    callback = null;
  }) as typeof cancelAnimationFrame;
  return {
    fire(timestamp) {
      const current = callback;
      callback = null;
      current?.(timestamp);
    },
    pending() {
      return callback !== null;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stability probe", () => {
  test("counts frames, long frames and worst frame", () => {
    const raf = rafHarness();
    let time = 0;
    const probe = createStabilityProbe({
      now: () => time,
      sampleIntervalMs: 10_000,
    });
    probe.start();
    expect(raf.pending()).toBe(true);
    raf.fire(0);
    raf.fire(16);
    raf.fire(120);
    const summary = probe.summary();
    expect(summary.frames).toBe(3);
    expect(summary.longFrames).toBe(1);
    expect(summary.worstFrameMs).toBe(104);
    expect(summary.avgFrameMs).toBe(60);
    probe.stop();
    expect(raf.pending()).toBe(false);
    time = 500;
  });

  test("samples fps and heap growth", () => {
    vi.useFakeTimers();
    const raf = rafHarness();
    let time = 0;
    let heap = 1_000;
    const probe = createStabilityProbe({
      now: () => time,
      readMemory: () => ({ usedJSHeapSize: heap, totalJSHeapSize: 2_000 }),
      sampleIntervalMs: 1_000,
    });
    probe.start();
    raf.fire(0);
    time = 1_000;
    raf.fire(16);
    raf.fire(32);
    vi.advanceTimersByTime(1_000);
    heap = 1_500;
    vi.advanceTimersByTime(1_000);
    const summary = probe.summary();
    expect(summary.samples.length).toBeGreaterThan(0);
    expect(summary.memoryGrowthBytes).toBe(500);
    expect(summary.samples[0]?.fps).toBeGreaterThan(0);
    probe.stop();
  });

  test("counts WebGL context loss and restore", () => {
    rafHarness();
    const canvas = document.createElement("canvas");
    const probe = createStabilityProbe({ canvas, sampleIntervalMs: 10_000 });
    probe.start();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    const summary = probe.summary();
    expect(summary.contextLost).toBe(1);
    expect(summary.contextRestored).toBe(1);
    probe.stop();
    probe.stop();
  });

  test("reset clears counters", () => {
    const raf = rafHarness();
    const probe = createStabilityProbe({ sampleIntervalMs: 10_000 });
    probe.start();
    raf.fire(0);
    raf.fire(100);
    expect(probe.summary().frames).toBe(2);
    probe.reset();
    expect(probe.summary().frames).toBe(0);
    expect(probe.summary().samples).toEqual([]);
    probe.stop();
  });
});
