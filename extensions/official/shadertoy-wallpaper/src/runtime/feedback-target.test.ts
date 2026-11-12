import { describe, expect, test } from "vitest";
import { createFakeContext, createFakeGl } from "../testing/fake-gl";
import { createFeedbackTarget } from "./feedback-target";

function setup() {
  const fake = createFakeGl();
  const context = createFakeContext(fake.gl, { version: 1 });
  const target = createFeedbackTarget(context, 8, 8);
  return { fake, target };
}

describe("createFeedbackTarget", () => {
  test("falls back to RGBA8 without half-float extensions", () => {
    const { fake, target } = setup();
    expect(target.format).toBe("rgba8");
    expect(target.width).toBe(8);
    expect(target.height).toBe(8);
    expect(fake.state.texImages).toHaveLength(2);
    target.dispose();
    expect(fake.state.deletedTextures).toBe(2);
  });

  test("swaps the readable texture before each draw", () => {
    const { target } = setup();
    const before = target.outputTexture();
    target.beginDraw();
    target.endDraw();
    const after = target.outputTexture();
    expect(after).not.toBe(before);
    target.beginDraw();
    target.endDraw();
    expect(target.outputTexture()).toBe(before);
    target.dispose();
  });

  test("resizes and disposes the FBO textures", () => {
    const { fake, target } = setup();
    target.resize(16, 12);
    expect(target.width).toBe(16);
    expect(target.height).toBe(12);
    expect(fake.state.texImages.length).toBeGreaterThanOrEqual(4);
    target.dispose();
    expect(fake.state.deletedTextures).toBe(4);
  });
});
