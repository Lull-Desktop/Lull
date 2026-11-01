import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { createMediaClient } from "./client.js";
import { LullMediaProvider, useNoiseSession } from "./react.js";
import type { MediaResponse } from "./protocol.js";

function Probe() {
  const session = useNoiseSession();
  return <span>{session?.state ?? "loading"}</span>;
}

describe("Noise React hooks", () => {
  test("useNoiseSession connects once and unmounts disconnect", async () => {
    const snapshot = {
      protocol: 1,
      revision: 3,
      player: {
        status: "idle",
        positionMs: 0,
        volume: 1,
        muted: false,
        mode: "sequence",
        revision: 3,
      },
      queue: { trackIds: [], revision: 3 },
      output: { volume: 1, muted: false },
      noise: {
        sessionId: "session",
        active: false,
        master: 0.7,
        muted: false,
        layers: [],
        sleep: { timerMinutes: 0 },
        revision: 1,
      },
      noiseSession: {
        id: "session",
        state: "playing",
        masterVolume: 0.7,
        muted: false,
        tracks: [],
        sleep: { timerMinutes: 0 },
        revision: 1,
        createdAt: 1,
      },
    };
    const connect = vi.fn(
      async (): Promise<MediaResponse> => ({
        protocol: 1,
        requestId: "connect",
        ok: true,
        result: snapshot,
        revision: 3,
      }),
    );
    const disconnect = vi.fn(async () => {});
    const transport = {
      call: async (): Promise<MediaResponse> => ({
        protocol: 1,
        requestId: "call",
        ok: true,
        result: null,
        revision: 3,
      }),
      connect,
      disconnect,
      subscribe: () => () => {},
    };
    const client = createMediaClient({ transport });
    const view = render(
      <LullMediaProvider client={client}>
        <Probe />
      </LullMediaProvider>,
    );

    await waitFor(() => expect(screen.getByText("playing")).toBeDefined());
    expect(connect).toHaveBeenCalledTimes(1);
    view.unmount();
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
  });
});
