import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { GameContext } from "@/lib/games";
import type { SceneFrame } from "@/sdk/scene";
import { GameReplicaHost } from "./game-replica-host";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/core/window/controls", () => ({
  isDesktopWindow: () => true,
}));

const frame: SceneFrame = {
  mode: "mirror",
  layout: "viewport",
  sync: { enabled: true, epochMs: 0 },
  viewport: { w: 1920, h: 1080, dpr: 1 },
  canvas: null,
  view: { x: 0, y: 0, w: 1920, h: 1080 },
  dpr: 1,
  params: {},
  reducedMotion: false,
  performance: null,
};

const context: GameContext = {
  protocol: 1,
  hostApi: 1,
  role: "replica",
  gameId: "community.living-world",
  instanceId: "instance",
  authorityId: "authority",
  authorityEpoch: 1,
  revision: 0,
  simulationTimeMs: 0,
  render: null,
  limits: {
    maxStateBytes: 1_048_576,
    maxEventBytes: 16_384,
    maxEventsPerCommit: 32,
    maxRenderStateBytes: 65_536,
    maxReplicas: 8,
    tickMs: 1_000,
  },
  locale: "zh-CN",
};

beforeEach(() => {
  invoke.mockReset();
  window.__LULL_GAME_TOKEN__ = "token";
});

test("iframe load performs the handshake even if game.ready was missed", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "game_replica_entry") {
      return Promise.resolve({
        gameId: "community.living-world",
        name: "Living World",
        version: "1.1.2",
        entryUrl:
          "http://lullgame.localhost/community.living-world/replica/index.html",
        enabled: true,
      });
    }
    if (command === "game_auto_start") {
      return Promise.resolve(null);
    }
    if (command === "game_connect") {
      return Promise.resolve({ context, replicaId: "replica-1" });
    }
    if (command === "game_snapshot_get") {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });

  const onReady = vi.fn();
  render(
    <GameReplicaHost
      gameId="community.living-world"
      frame={frame}
      onReady={onReady}
    />,
  );

  const iframe = await screen.findByTestId("game-replica");
  fireEvent.load(iframe);

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("game_auto_start", {
      gameId: "community.living-world",
    });
  });
  expect(invoke).toHaveBeenCalledWith(
    "game_connect",
    expect.objectContaining({
      token: "token",
      request: expect.objectContaining({
        gameId: "community.living-world",
        sceneId: null,
      }),
    }),
  );
  expect(onReady).toHaveBeenCalled();
});
