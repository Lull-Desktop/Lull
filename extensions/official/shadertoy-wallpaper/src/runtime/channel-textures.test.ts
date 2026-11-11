import { describe, expect, test } from "vitest";
import { createFakeGl } from "../testing/fake-gl";
import {
  CHANNEL_RESOLUTIONS,
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
  test("uploads noise for channel 0 and black for channels 1-3", () => {
    const { gl, state } = createFakeGl();
    const textures = createChannelTextures(gl);
    expect(state.texImages).toEqual([
      { width: NOISE_SIZE, height: NOISE_SIZE },
      { width: 1, height: 1 },
    ]);

    state.calls.length = 0;
    textures.bind();
    expect(state.calls.filter((call) => call === "activeTexture")).toHaveLength(
      4,
    );
    expect(state.calls.filter((call) => call === "bindTexture")).toHaveLength(
      4,
    );

    textures.dispose();
    expect(state.deletedTextures).toBe(2);
  });

  test("channel resolutions match the placeholder sizes", () => {
    expect([...CHANNEL_RESOLUTIONS.slice(0, 3)]).toEqual([
      NOISE_SIZE,
      NOISE_SIZE,
      1,
    ]);
    for (let offset = 3; offset < CHANNEL_RESOLUTIONS.length; offset += 3) {
      expect([...CHANNEL_RESOLUTIONS.slice(offset, offset + 3)]).toEqual([
        1, 1, 1,
      ]);
    }
  });
});
