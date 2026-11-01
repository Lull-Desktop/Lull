import { describe, expect, it, vi } from "vitest";

import { type MediaHubClient, MediaSessionHub } from "./hub.js";
import type { MediaEvent } from "./protocol.js";
import type { PlaybackSnapshot } from "./types.js";

function snapshot(revision: number): PlaybackSnapshot {
  return {
    protocol: 1,
    revision,
    player: {
      status: "paused",
      positionMs: 0,
      volume: 1,
      muted: false,
      mode: "sequence",
      revision,
    },
    queue: { trackIds: [], revision },
    output: { volume: 1, muted: false },
    noise: { layers: [], revision },
    noiseSession: {
      id: "session",
      state: "idle",
      masterVolume: 1,
      muted: false,
      tracks: [],
      sleep: { enabled: false, minutes: 0, endsAt: null },
      revision,
      createdAt: 0,
    },
  } as unknown as PlaybackSnapshot;
}

function fakeClient() {
  const listeners = new Set<(event: MediaEvent) => void>();
  const connects: Parameters<MediaHubClient["connect"]>[0][] = [];
  const disconnect = vi.fn(async () => {});
  const client: MediaHubClient = {
    connect: vi.fn(async (options) => {
      connects.push(options);
      return snapshot(connects.length);
    }),
    disconnect,
    events: {
      on(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return {
    client,
    connects,
    disconnect,
    emit(event: MediaEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("MediaSessionHub", () => {
  it("connects with the union of all subscribers and never disconnects on release", async () => {
    const fake = fakeClient();
    const hub = new MediaSessionHub(fake.client);
    const releasePlayer = hub.ensure({ topics: ["player.state"] });
    await vi.waitFor(() => expect(fake.connects).toHaveLength(1));

    const releaseQueue = hub.ensure({ topics: ["queue.changed"] });
    await vi.waitFor(() => expect(fake.connects).toHaveLength(2));
    expect(fake.connects[1]?.topics).toEqual(["player.state", "queue.changed"]);

    releasePlayer();
    releaseQueue();
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(hub.status.connected).toBe(true);
  });

  it("merges player and queue events into the snapshot", async () => {
    const fake = fakeClient();
    const hub = new MediaSessionHub(fake.client);
    const listener = vi.fn();
    hub.subscribe(listener);
    const release = hub.ensure({
      topics: ["player.state", "player.progress", "queue.changed"],
      progressMs: 500,
      levels: true,
    });
    await vi.waitFor(() => expect(hub.status.connected).toBe(true));

    fake.emit({
      protocol: 1,
      topic: "player.state",
      revision: 10,
      at: 0,
      payload: {
        status: "playing",
        positionMs: 0,
        volume: 0.5,
        muted: false,
        mode: "repeat-one",
        revision: 10,
      },
    });
    expect(hub.snapshot?.player?.revision).toBe(10);
    expect(hub.snapshot?.player?.volume).toBe(0.5);
    expect(listener).toHaveBeenCalled();

    fake.emit({
      protocol: 1,
      topic: "player.progress",
      revision: 11,
      at: 0,
      payload: { positionMs: 1234, durationMs: 3000 },
    });
    expect(hub.snapshot?.player?.positionMs).toBe(1234);
    expect(hub.snapshot?.player?.durationMs).toBe(3000);

    fake.emit({
      protocol: 1,
      topic: "queue.changed",
      revision: 12,
      at: 0,
      payload: { trackIds: ["a", "b"], currentIndex: 0, revision: 12 },
    });
    expect(hub.snapshot?.queue?.trackIds).toEqual(["a", "b"]);
    release();
  });

  it("reconnects when progress or levels requirements grow", async () => {
    const fake = fakeClient();
    const hub = new MediaSessionHub(fake.client);
    const release = hub.ensure({
      topics: ["player.state"],
      progressMs: 1000,
      levels: false,
    });
    await vi.waitFor(() => expect(fake.connects).toHaveLength(1));

    const releaseLevels = hub.ensure({
      topics: ["player.state"],
      progressMs: 250,
      levels: true,
    });
    await vi.waitFor(() => expect(fake.connects).toHaveLength(2));
    expect(fake.connects[1]?.progressMs).toBe(250);
    expect(fake.connects[1]?.levels).toBe(true);

    release();
    releaseLevels();
  });
});
