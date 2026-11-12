import { describe, expect, test } from "vitest";
import { createFakeGl } from "../testing/fake-gl";
import {
  createChannelTextures,
  createNoisePixels,
  NOISE_SIZE,
} from "./channel-textures";

describe("createNoisePixels", () => {
  test("is deterministic, opaque and non-constant", () => {
    const first = createNoisePixels(16);
    const second = createNoisePixels(16);
    expect(first).toEqual(second);
    expect(first).toHaveLength(16 * 16 * 4);
    for (let index = 3; index < first.length; index += 4) {
      expect(first[index]).toBe(255);
    }
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});

describe("createChannelTextures", () => {
  test("uploads the noise and black textures", () => {
    const { gl, state } = createFakeGl();
    const textures = createChannelTextures(gl);
    expect(state.texImages).toEqual([
      { width: NOISE_SIZE, height: NOISE_SIZE },
      { width: 1, height: 1 },
    ]);
    expect(textures.noise.width).toBe(NOISE_SIZE);
    expect(textures.noise.height).toBe(NOISE_SIZE);
    expect(textures.black.width).toBe(1);
    expect(textures.black.height).toBe(1);

    textures.dispose();
    expect(state.deletedTextures).toBe(2);
  });
});
