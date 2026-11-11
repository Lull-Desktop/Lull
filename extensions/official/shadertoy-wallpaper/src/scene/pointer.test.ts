import { describe, expect, test } from "vitest";
import { createMouseTracker, pointerToMouse } from "./pointer";

const VIEWPORT = { w: 800, h: 400 };
const DRAW = { width: 1600, height: 800 };

describe("pointerToMouse", () => {
  test("uses the Shadertoy default before the first sample", () => {
    expect(pointerToMouse(null, VIEWPORT, DRAW)).toEqual([0, 0, 0, 0]);
  });

  test("scales to draw pixels and flips Y to bottom-left", () => {
    expect(pointerToMouse({ x: 400, y: 100 }, VIEWPORT, DRAW)).toEqual([
      800, 600, 0, 0,
    ]);
    expect(pointerToMouse({ x: 0, y: 0 }, VIEWPORT, DRAW)).toEqual([
      0, 800, 0, 0,
    ]);
  });

  test("clamps positions at the draw bounds", () => {
    expect(pointerToMouse({ x: 900, y: 500 }, VIEWPORT, DRAW)).toEqual([
      1600, 0, 0, 0,
    ]);
    expect(pointerToMouse({ x: -10, y: -10 }, VIEWPORT, DRAW)).toEqual([
      0, 800, 0, 0,
    ]);
  });

  test("honors a render scale below 1", () => {
    expect(
      pointerToMouse({ x: 800, y: 400 }, VIEWPORT, { width: 800, height: 400 }),
    ).toEqual([800, 0, 0, 0]);
  });

  test("does not produce NaN for degenerate viewports", () => {
    expect(
      pointerToMouse({ x: 10, y: 10 }, { w: 0, h: 0 }, { width: 0, height: 0 }),
    ).toEqual([1, 0, 0, 0]);
  });
});

describe("createMouseTracker", () => {
  test("reports the default until an inside sample arrives", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 10, y: 10, inside: false, moving: false });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([0, 0, 0, 0]);
  });

  test("keeps the last inside position after the pointer leaves", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 400, y: 100, inside: true, moving: true });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([800, 600, 0, 0]);

    tracker.update({ x: 10, y: 10, inside: false, moving: false });
    tracker.update({ x: 20, y: 20, inside: false, moving: false });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([800, 600, 0, 0]);
  });

  test("moves again when the pointer re-enters", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 400, y: 100, inside: true, moving: true });
    tracker.update({ x: 10, y: 10, inside: false, moving: false });
    tracker.update({ x: 200, y: 300, inside: true, moving: true });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([400, 200, 0, 0]);
  });

  test("rescales the retained position when the draw size changes", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 400, y: 100, inside: true, moving: true });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([800, 600, 0, 0]);
    expect(tracker.resolve(VIEWPORT, { width: 800, height: 400 })).toEqual([
      400, 300, 0, 0,
    ]);
  });

  test("ignores non-finite samples", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 400, y: 100, inside: true, moving: true });
    tracker.update({ x: Number.NaN, y: 100, inside: true, moving: true });
    tracker.update({
      x: 400,
      y: Number.POSITIVE_INFINITY,
      inside: true,
      moving: true,
    });
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([800, 600, 0, 0]);
  });

  test("reset restores the default state", () => {
    const tracker = createMouseTracker();
    tracker.update({ x: 400, y: 100, inside: true, moving: true });
    tracker.reset();
    expect(tracker.resolve(VIEWPORT, DRAW)).toEqual([0, 0, 0, 0]);
  });
});
