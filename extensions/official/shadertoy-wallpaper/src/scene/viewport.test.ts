import { describe, expect, test } from "vitest";
import {
  clampRenderScale,
  computeDrawSize,
  MAX_DRAW_PIXELS,
  MAX_RENDER_SCALE,
  MIN_RENDER_SCALE,
} from "./viewport";

describe("clampRenderScale", () => {
  test("clamps to the supported range and falls back for bad input", () => {
    expect(clampRenderScale(0.1)).toBe(MIN_RENDER_SCALE);
    expect(clampRenderScale(3)).toBe(MAX_RENDER_SCALE);
    expect(clampRenderScale(Number.NaN)).toBe(1);
    expect(clampRenderScale(0.5)).toBe(0.5);
  });
});

describe("computeDrawSize", () => {
  test("uses CSS size × DPR × scale", () => {
    expect(computeDrawSize({ w: 1280, h: 720, dpr: 2 }, 0.5)).toEqual({
      width: 1280,
      height: 720,
      scale: 0.5,
    });
  });

  test("falls back to DPR 1 for invalid values", () => {
    expect(computeDrawSize({ w: 100, h: 50, dpr: Number.NaN }, 1)).toEqual({
      width: 100,
      height: 50,
      scale: 1,
    });
  });

  test("caps huge draw sizes at the 4K pixel budget", () => {
    const size = computeDrawSize({ w: 3840, h: 2160, dpr: 2 }, 1);
    expect(size.width * size.height).toBeLessThanOrEqual(
      MAX_DRAW_PIXELS + 4096,
    );
    expect(size.scale).toBeLessThan(1);
  });

  test("keeps at least one pixel", () => {
    const size = computeDrawSize({ w: 0, h: 0, dpr: 0 }, 0);
    expect(size.width).toBe(1);
    expect(size.height).toBe(1);
  });
});
