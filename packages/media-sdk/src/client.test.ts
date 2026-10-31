import { describe, expect, test } from "vitest";

import { createMediaClient } from "./client";
import { LullMediaError } from "./errors";
import { MEDIA_PROTOCOL } from "./protocol";
import { createMemoryTransport } from "./testing";
import type { Page, TrackSummary } from "./types";

const track: TrackSummary = {
  id: "trk_1",
  title: "雨",
  artists: ["Lull"],
  source: "builtin",
  available: true,
  hasCover: false,
};

const page: Page<TrackSummary> = {
  items: [track],
  total: 1,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

describe("media client", () => {
  test("sends a protocol 1 request and parses the result", async () => {
    const transport = createMemoryTransport((request) => {
      expect(request.protocol).toBe(MEDIA_PROTOCOL);
      expect(request.namespace).toBe("library");
      expect(request.method).toBe("listTracks");
      expect(request.args).toMatchObject({ keyword: "雨", page: 1 });
      return page;
    });
    const media = createMediaClient({ transport });

    const result = await media.library.listTracks({ keyword: "雨", page: 1 });

    expect(result.items[0]?.title).toBe("雨");
    expect(transport.requests).toHaveLength(1);
  });

  test("throws a typed error for a failed response", async () => {
    const transport = createMemoryTransport(() => {
      throw new LullMediaError({
        code: "capability.denied",
        message: "没有权限",
      });
    });
    const media = createMediaClient({ transport });

    await expect(media.library.listSources()).rejects.toMatchObject({
      code: "capability.denied",
    });
  });

  test("adds the request id and preserves caller args", async () => {
    const transport = createMemoryTransport(() => ({ removed: true }));
    const media = createMediaClient({ transport });

    await expect(media.library.removeSource("src_1")).resolves.toBe(true);
    expect(transport.requests[0]?.requestId).toMatch(/.+/);
    expect(transport.requests[0]?.args).toEqual({ sourceId: "src_1" });
  });
});
