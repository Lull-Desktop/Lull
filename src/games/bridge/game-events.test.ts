import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  currentWindowLabel,
  isGameEventForGame,
  listenGameEvent,
} from "./game-events";

const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen }));

type TestWindow = Window & {
  __TAURI_INTERNALS__?: {
    metadata?: { currentWindow?: { label?: string } };
  };
};

const testWindow = window as TestWindow;

beforeEach(() => {
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  delete testWindow.__TAURI_INTERNALS__;
});

afterEach(() => {
  delete testWindow.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("game event targeting", () => {
  test("registers against the current Tauri window instead of Any", async () => {
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "wallpaper-1" } },
    };
    const handler = vi.fn();

    await listenGameEvent("game:snapshot", handler);

    expect(currentWindowLabel()).toBe("wallpaper-1");
    expect(listen).toHaveBeenCalledWith("game:snapshot", handler, {
      target: { kind: "AnyLabel", label: "wallpaper-1" },
    });
  });

  test("falls back to the default listener outside Tauri", async () => {
    const handler = vi.fn();

    await listenGameEvent("game:snapshot", handler);

    expect(currentWindowLabel()).toBeNull();
    expect(listen).toHaveBeenCalledWith("game:snapshot", handler);
  });

  test("does not silently listen globally when Tauri lacks a window label", async () => {
    testWindow.__TAURI_INTERNALS__ = { metadata: {} };
    const handler = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await listenGameEvent("game:snapshot", handler);

    expect(listen).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe("game event payload ownership", () => {
  test("accepts only the matching gameId", () => {
    expect(
      isGameEventForGame(
        { gameId: "community.phaser-demo" },
        "community.phaser-demo",
      ),
    ).toBe(true);
    expect(
      isGameEventForGame(
        { gameId: "community.pixi-demo" },
        "community.phaser-demo",
      ),
    ).toBe(false);
    expect(isGameEventForGame(null, "community.phaser-demo")).toBe(false);
    expect(isGameEventForGame({}, "community.phaser-demo")).toBe(false);
  });
});
