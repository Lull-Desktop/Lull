import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { LullMediaClient } from "./client.js";
import { LullMediaProvider, usePlayerSession } from "./react.js";
import type { PlaybackSnapshot, TrackSummary } from "./types.js";

function track(index: number): TrackSummary {
  return {
    id: `track-${index}`,
    title: `Track ${index}`,
    artists: ["Artist"],
    source: "local",
    available: true,
    hasCover: false,
  };
}

const allTracks = Array.from({ length: 376 }, (_, index) => track(index));

const client = {
  connect: vi.fn(
    async (): Promise<PlaybackSnapshot> =>
      ({
        protocol: 1,
        revision: 1,
        player: null,
        queue: null,
        output: { volume: 1, muted: false },
        noise: { layers: [], revision: 1 },
        noiseSession: null,
      }) as unknown as PlaybackSnapshot,
  ),
  disconnect: vi.fn(async () => {}),
  events: { on: () => () => {} },
  library: {
    listTracks: vi.fn(
      async ({
        page = 1,
        pageSize = 200,
      }: {
        page?: number;
        pageSize?: number;
      }) => {
        const start = (page - 1) * pageSize;
        return {
          items: allTracks.slice(start, start + pageSize),
          total: allTracks.length,
          page,
          pageSize,
          hasMore: start + pageSize < allTracks.length,
        };
      },
    ),
    getTrack: vi.fn(async (id: string) => allTracks.find((t) => t.id === id)),
    getCoverUrl: vi.fn(async () => null),
  },
  favorites: { set: vi.fn(async () => ({})) },
  player: {},
  queue: { add: vi.fn(async () => ({})) },
} as unknown as LullMediaClient;

function wrapper({ children }: { children: ReactNode }) {
  return <LullMediaProvider client={client}>{children}</LullMediaProvider>;
}

describe("usePlayerSession pagination", () => {
  it("loads the first page lazily and appends the next page on demand", async () => {
    const { result } = renderHook(() => usePlayerSession(), { wrapper });
    await waitFor(() => expect(result.current.tracks).toHaveLength(200));
    expect(result.current.total).toBe(376);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(result.current.tracks).toHaveLength(376));
    expect(result.current.hasMore).toBe(false);
    expect(client.library.listTracks).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 200,
    });
  });
});
