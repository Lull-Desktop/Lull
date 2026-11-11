import { describe, expect, test } from "vitest";
import { buildUniforms, dateUniform } from "./uniform-adapter";

describe("dateUniform", () => {
  test("maps a local date to Shadertoy iDate semantics", () => {
    const date = new Date(2026, 10, 11, 13, 4, 5, 500);
    expect(dateUniform(date)).toEqual([2026, 10, 11, 13 * 3600 + 4 * 60 + 5.5]);
  });
});

describe("buildUniforms", () => {
  test("carries resolution, timing, mouse and a real date", () => {
    const now = new Date(2026, 0, 2, 3, 0, 0, 0);
    const uniforms = buildUniforms({
      width: 1280,
      height: 720,
      time: 12.5,
      timeDelta: 0.016,
      frame: 7,
      frameRate: 60,
      mouse: [10, 20, -1, -1],
      now,
    });
    expect(uniforms.resolution).toEqual([1280, 720]);
    expect(uniforms.time).toBe(12.5);
    expect(uniforms.timeDelta).toBe(0.016);
    expect(uniforms.frame).toBe(7);
    expect(uniforms.frameRate).toBe(60);
    expect(uniforms.mouse).toEqual([10, 20, -1, -1]);
    expect(uniforms.date).toEqual([2026, 0, 2, 3 * 3600]);
  });
});
