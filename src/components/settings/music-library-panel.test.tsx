import type { MediaRequest, Page, TrackSummary } from "@lull/media-sdk";
import { createMediaClient } from "@lull/media-sdk";
import { createMemoryTransport } from "@lull/media-sdk/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { MusicLibraryPanel } from "./music-library-panel";

const tracks: TrackSummary[] = [
  {
    id: "trk_1",
    title: "雨",
    artists: ["Lull"],
    album: "夜",
    durationMs: 120_000,
    source: "local",
    available: true,
    hasCover: false,
  },
];

const page: Page<TrackSummary> = {
  items: tracks,
  total: 1,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

function handler(request: MediaRequest): unknown {
  switch (`${request.namespace}.${request.method}`) {
    case "library.listSources":
      return [
        {
          id: "src_1",
          kind: "local",
          name: "测试音乐",
          status: "active",
          rootPath: "C:\\Music",
        },
      ];
    case "library.listTracks":
      return page;
    case "library.listArtists":
      return [{ id: "art_1", name: "Lull", kind: "group", trackCount: 1 }];
    case "library.listAlbums":
      return [
        {
          id: "alb_1",
          title: "夜",
          kind: "album",
          trackCount: 1,
          hasCover: false,
        },
      ];
    default:
      return null;
  }
}

test("展示来源、统计与曲目，并提交搜索", async () => {
  const transport = createMemoryTransport(handler);
  const client = createMediaClient({ transport });

  render(<MusicLibraryPanel client={client} />);

  await waitFor(() => {
    expect(screen.getByText("测试音乐")).toBeDefined();
  });
  expect(screen.getAllByText("雨").length).toBeGreaterThan(0);
  expect(screen.getByText("02:00")).toBeDefined();

  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "夜" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));

  await waitFor(() => {
    const requests = transport.requests.filter(
      (item) => item.method === "listTracks",
    );
    expect(requests.at(-1)?.args).toMatchObject({ keyword: "夜" });
  });
});
