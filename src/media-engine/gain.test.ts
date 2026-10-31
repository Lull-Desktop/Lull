import { describe, expect, test } from "vitest";

import {
  busGain,
  clamp01,
  NOISE_MASTER_TRIM,
  NOISE_TRACK_TRIM,
  noiseBusGain,
  OUTPUT_HEADROOM,
  outputGain,
  trackGain,
} from "./gain";

describe("shared audio gain staging", () => {
  test("clamps invalid and out-of-range volumes", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });

  test("mute always wins", () => {
    expect(busGain(0.8, true)).toBe(0);
    expect(outputGain(1, true)).toBe(0);
    expect(noiseBusGain(1, true)).toBe(0);
  });

  test("noise track is silent unless both track and session are audible", () => {
    expect(trackGain(1, true, false)).toBe(0);
    expect(trackGain(1, false, true)).toBe(0);
    expect(trackGain(0.5, true, true)).toBeCloseTo(0.5 * NOISE_TRACK_TRIM);
  });

  test("output and noise buses keep headroom before the limiter", () => {
    expect(outputGain(1, false)).toBeCloseTo(OUTPUT_HEADROOM);
    expect(noiseBusGain(1, false)).toBeCloseTo(NOISE_MASTER_TRIM);
  });
});
