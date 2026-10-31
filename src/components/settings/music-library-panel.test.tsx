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
    case "library.listGenres":
      return ["Ambient"];
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

test("按艺术家、格式与年份筛选曲目", async () => {
  const transport = createMemoryTransport(handler);
  const client = createMediaClient({ transport });

  render(<MusicLibraryPanel client={client} />);
  await waitFor(() => {
    expect(screen.getByLabelText("艺术家")).toBeDefined();
  });

  fireEvent.change(screen.getByLabelText("艺术家"), {
    target: { value: "art_1" },
  });
  fireEvent.change(screen.getByLabelText("格式"), {
    target: { value: "flac" },
  });
  fireEvent.change(screen.getByLabelText("年份"), {
    target: { value: "2024" },
  });

  await waitFor(() => {
    const requests = transport.requests.filter(
      (item) => item.method === "listTracks",
    );
    expect(requests.at(-1)?.args).toMatchObject({
      artistId: "art_1",
      format: "flac",
      year: 2024,
    });
  });
});

test("扫描中显示取消按钮并调用 cancelScan", async () => {
  const transport = createMemoryTransport((request) => {
    if (request.method === "listSources") {
      return [
        {
          id: "src_1",
          kind: "local",
          name: "测试音乐",
          status: "scanning",
          rootPath: "C:\\Music",
        },
      ];
    }
    if (request.method === "cancelScan") return { cancelled: true };
    if (request.method === "listTracks") return page;
    if (request.method === "listArtists") return [];
    if (request.method === "listAlbums") return [];
    if (request.method === "listGenres") return [];
    return null;
  });
  const client = createMediaClient({ transport });

  render(<MusicLibraryPanel client={client} />);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "取消扫描" })).toBeDefined();
  });
  fireEvent.click(screen.getByRole("button", { name: "取消扫描" }));

  await waitFor(() => {
    expect(
      transport.requests.some((request) => request.method === "cancelScan"),
    ).toBe(true);
  });
});
