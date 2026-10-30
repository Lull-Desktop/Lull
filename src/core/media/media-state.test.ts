import { describe, expect, test } from "vitest";
import {
  decideNativeAttempt,
  formatBytes,
  mediaObjectPosition,
} from "@/core/media/media-state";
import type { MediaCapabilities } from "@/core/media/types";

const capabilities: MediaCapabilities = {
  nativeTextureStream: true,
  hardwareDecode: true,
  reason: null,
  runtimeVersion: "156.0.0",
  adapterLuid: 1,
  htmlFallback: true,
};

describe("media state", () => {
  test("native is attempted only with runtime support and WebView2 API", () => {
    expect(decideNativeAttempt(capabilities, true)).toEqual({
      attempt: true,
      reason: null,
    });
    expect(decideNativeAttempt(capabilities, false).attempt).toBe(false);
    expect(
      decideNativeAttempt(
        { ...capabilities, nativeTextureStream: false, reason: "disabled" },
        true,
      ),
    ).toEqual({ attempt: false, reason: "disabled" });
  });

  test("object position maps to CSS values", () => {
    expect(mediaObjectPosition("center")).toBe("center center");
    expect(mediaObjectPosition("top")).toBe("center top");
    expect(mediaObjectPosition("left")).toBe("left center");
  });

  test("formatBytes keeps readable units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});
