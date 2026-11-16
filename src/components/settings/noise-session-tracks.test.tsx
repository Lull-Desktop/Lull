import type { LullMediaClient, NoiseSession } from "@lull/media-sdk";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { NoiseSessionTracks } from "./noise-session-tracks";

test("subscribe before snapshot, reject late older state, and destroy removed track drafts", async () => {
  type Event = { topic: string; payload: NoiseSession };
  const listeners = new Set<(event: Event) => void>();
  const emit = (event: Event) =>
    listeners.forEach((listener) => listener(event));
  let resolve: (session: NoiseSession) => void = () => {};
  const calls: string[] = [];
  const stop = vi.fn();
  const client = {
    events: {
      on: (listener: typeof emit) => {
        calls.push("listen");
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          stop();
        };
      },
    },
    noise: {
      session: {
        getCurrent: () => {
          calls.push("snapshot");
          return new Promise<NoiseSession>((r) => {
            resolve = r;
          });
        },
      },
    },
  } as unknown as LullMediaClient;
  const snapshot = (revision: number, name: string): NoiseSession => ({
    id: "session",
    revision,
    state: "playing",
    muted: false,
    masterVolume: 0.5,
    sleep: { timerMinutes: 0 },
    createdAt: 0,
    tracks: [
      {
        id: "track",
        assetId: "asset",
        name,
        volume: 0.4,
        enabled: true,
        loop: true,
        order: 0,
        positionMs: 0,
        state: "playing",
      },
    ],
  });
  const view = render(<NoiseSessionTracks client={client} />);
  expect(calls.slice(0, 2)).toEqual(["listen", "snapshot"]);
  act(() =>
    emit({ topic: "noise.session.changed", payload: snapshot(2, "new") }),
  );
  await act(async () => resolve(snapshot(1, "old")));
  expect(screen.getByText("1. new")).toBeDefined();
  expect(screen.queryByText("1. old")).toBeNull();
  act(() =>
    emit({
      topic: "noise.session.changed",
      payload: { ...snapshot(3, "removed"), tracks: [] },
    }),
  );
  await waitFor(() => expect(screen.queryByText("1. new")).toBeNull());
  view.unmount();
  expect(stop).toHaveBeenCalled();
});
