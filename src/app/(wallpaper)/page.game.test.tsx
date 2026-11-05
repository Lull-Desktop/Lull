/**
 * 壁纸直接渲染游戏包 `entry.replica`：不经过 Scene 目录的完整包路径。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Page from "./page";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const GAME_ENTRY_URL =
  "http://lullgame.localhost/community.stability-probe/replica/index.html";

beforeEach(() => {
  window.location.hash = "";
  invoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("game hash mounts the package's entry.replica instead of a scene", async () => {
  window.location.hash =
    "#mode=mirror&sync=1&scene=lull.bamboo&game=community.stability-probe&canvas=0,0,1920,1080&view=0,0,1920,1080";
  invoke.mockImplementation((command: string) => {
    if (command === "game_replica_entry") {
      return Promise.resolve({
        gameId: "community.stability-probe",
        name: "Stability Probe",
        version: "1.0.3",
        entryUrl: GAME_ENTRY_URL,
        enabled: true,
      });
    }
    return Promise.resolve(null);
  });

  render(<Page />);

  const frame = await screen.findByTestId("game-replica");
  expect(frame.getAttribute("src")).toBe(GAME_ENTRY_URL);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(screen.queryByTestId("external-scene")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("game_replica_entry", {
    gameId: "community.stability-probe",
  });
});

test("game package without entry.replica shows a notice and no iframe", async () => {
  window.location.hash = "#mode=mirror&game=community.old-game";
  invoke.mockImplementation((command: string) => {
    if (command === "game_replica_entry") {
      return Promise.resolve({
        gameId: "community.old-game",
        name: "Old Game",
        version: "1.0.0",
        entryUrl: null,
        enabled: true,
      });
    }
    return Promise.resolve(null);
  });

  render(<Page />);

  expect(await screen.findByTestId("game-replica-missing")).toBeDefined();
  expect(screen.queryByTestId("game-replica")).toBeNull();
});
