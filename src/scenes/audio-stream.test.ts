import { describe, expect, test } from "vitest";
import { audioStatusAllFalse } from "@/sdk/scene";
import {
  connectWallpaperAudio,
  isAudioEventEnvelope,
  WALLPAPER_AUDIO_EVENT,
} from "./audio-stream";

function frame(source: "music" | "noise" = "music") {
  return {
    protocol: 1,
    timestamp: 10,
    sequence: 1,
    source,
    active: true,
    level: { rms: 0.2, peak: 0.4, normalized: 0.5 },
    bands: { bass: 0.5, lowMid: 0.4, mid: 0.3, highMid: 0.2, treble: 0.1 },
  };
}

describe("audio-stream", () => {
  test("event name matches Rust AUDIO_EVENT", () => {
    expect(WALLPAPER_AUDIO_EVENT).toBe("wallpaper-audio");
  });

  test("accepts frame/status envelopes and rejects malformed payloads", () => {
    expect(
      isAudioEventEnvelope({
        v: 1,
        type: "frame",
        timestamp: 10,
        sequence: 1,
        frames: [frame()],
      }),
    ).toBe(true);
    expect(
      isAudioEventEnvelope({
        v: 1,
        type: "status",
        status: audioStatusAllFalse("inactive"),
      }),
    ).toBe(true);

    expect(
      isAudioEventEnvelope({
        v: 1,
        type: "frame",
        timestamp: 10,
        sequence: 1,
        frames: [{ ...frame(), protocol: 2 }],
      }),
    ).toBe(false);
    expect(
      isAudioEventEnvelope({
        v: 1,
        type: "status",
        status: { available: true, sources: {} },
      }),
    ).toBe(false);
    expect(isAudioEventEnvelope({ v: 2, type: "status" })).toBe(false);
    expect(isAudioEventEnvelope(null)).toBe(false);
  });

  test("浏览器预览降级为 not-supported，且不抛错", async () => {
    const connection = connectWallpaperAudio({
      sources: ["music", "noise"],
      features: ["level", "bands"],
    });
    await expect(connection.whenReady).resolves.toBeUndefined();
    expect(connection.getStatus()).toMatchObject({
      available: false,
      reason: "not-supported",
    });
    expect(connection.getSnapshot().sources.music).toBeNull();

    const seen: unknown[] = [];
    const off = connection.subscribeFrames((frames) => seen.push(frames));
    off();
    connection.disconnect();
    connection.disconnect();
    expect(seen).toEqual([]);
  });
});
