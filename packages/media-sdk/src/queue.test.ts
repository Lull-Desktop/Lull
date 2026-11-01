import { describe, expect, it } from "vitest";

import { queueTracksFor } from "./queue.js";
import type { TrackSummary } from "./types.js";

function track(id: string): TrackSummary {
  return {
    id,
    title: id,
    artists: ["Artist"],
    source: "local",
    available: true,
    hasCover: false,
  };
}

describe("queueTracksFor", () => {
  it("keeps the host order even when a track is outside the library page", () => {
    const byId = new Map([
      ["first", track("first")],
      ["last", track("last")],
    ]);
    const resolved = queueTracksFor(
      ["first", "missing-page-2", "last"],
      byId,
    );
    expect(resolved.map((item) => item.id)).toEqual([
      "first",
      "missing-page-2",
      "last",
    ]);
    expect(resolved[1]?.available).toBe(false);
    expect(resolved[1]?.title).toBe("未知曲目");
  });

  it("preserves duplicate ids and empty queues", () => {
    const byId = new Map([["a", track("a")]]);
    expect(queueTracksFor(["a", "a"], byId)).toHaveLength(2);
    expect(queueTracksFor([], byId)).toEqual([]);
  });
});
