import { describe, expect, test } from "vitest";
import { intensityWeights, validateIntensityAnchors } from "./environment-intensity";

const anchors = [
  { assetId: "drizzle", intensity: 0.1 },
  { assetId: "rain", intensity: 0.5 },
  { assetId: "storm", intensity: 0.9 },
];

describe("environment intensity anchors", () => {
  test("interpolates only adjacent authored sounds and holds the endpoints", () => {
    expect(intensityWeights(anchors, 0)).toEqual([1, 0, 0]);
    expect(intensityWeights(anchors, 0.3)[0]).toBeCloseTo(0.5);
    expect(intensityWeights(anchors, 0.3)[1]).toBeCloseTo(0.5);
    expect(intensityWeights(anchors, 0.5)).toEqual([0, 1, 0]);
    expect(intensityWeights(anchors, 1)).toEqual([0, 0, 1]);
  });

  test("rejects duplicates, unordered and non-finite anchors", () => {
    expect(validateIntensityAnchors(anchors)).toBe(true);
    expect(validateIntensityAnchors([anchors[1], anchors[0]])).toBe(false);
    expect(validateIntensityAnchors([anchors[0], anchors[0]])).toBe(false);
    expect(validateIntensityAnchors([anchors[0], { assetId: "x", intensity: NaN }])).toBe(false);
    expect(intensityWeights([], 0.5)).toEqual([]);
  });
});
