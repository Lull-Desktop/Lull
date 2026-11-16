import { describe, expect, test } from "vitest";
import { intensityWeights, rainDetailParameters, validateIntensityAnchors } from "./environment-intensity";

const anchors = [
  { assetId: "drizzle", intensity: 0.1 },
  { assetId: "rain", intensity: 0.5 },
  { assetId: "storm", intensity: 0.9 },
];

describe("environment intensity anchors", () => {
  test("rain detail becomes denser without depending on volume", () => {
    expect(rainDetailParameters(0)).toEqual({ rate: 0.5, gain: 0.12 });
    expect(rainDetailParameters(1).rate).toBe(3);
    expect(rainDetailParameters(1).gain).toBeCloseTo(0.36);
    expect(rainDetailParameters(-1)).toEqual(rainDetailParameters(0));
    expect(rainDetailParameters(NaN)).toEqual(rainDetailParameters(0));
  });
  test("interpolates only adjacent authored sounds and holds the endpoints", () => {
    expect(intensityWeights(anchors, 0)).toEqual([1, 0, 0]);
    expect(intensityWeights(anchors, 0.3)[0]).toBeCloseTo(0.5);
    expect(intensityWeights(anchors, 0.3)[1]).toBeCloseTo(0.5);
    expect(intensityWeights(anchors, 0.5)).toEqual([0, 1, 0]);
    expect(intensityWeights(anchors, 1)).toEqual([0, 0, 1]);
    expect(intensityWeights([anchors[1]], 0.8)).toEqual([1]);
  });

  test("rejects duplicates, unordered and non-finite anchors", () => {
    expect(validateIntensityAnchors(anchors)).toBe(true);
    expect(validateIntensityAnchors([anchors[1], anchors[0]])).toBe(false);
    expect(validateIntensityAnchors([anchors[0], anchors[0]])).toBe(false);
    expect(validateIntensityAnchors([anchors[0], { assetId: "x", intensity: NaN }])).toBe(false);
    expect(intensityWeights([], 0.5)).toEqual([]);
  });
});
