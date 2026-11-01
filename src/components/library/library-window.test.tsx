import type {
  LullMediaClient,
  MusicFolderView,
  Page,
  TrackSummary,
} from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LibraryWindow } from "./library-window";

const track: TrackSummary = {
  id: "trk_1",
  title: "雨",
  artists: ["Lull"],
  album: "夜",
  durationMs: 120_000,
  source: "local",
  available: true,
  hasCover: false,
  fileName: "rain.mp3",
};

const folder: MusicFolderView = {
  id: "src_1",
  name: "Pop",
  rootPath: "C:\\Music\\Pop",
  recursive: true,
  status: "available",
  trackCount: 1,
  createdAt: 1,
  updatedAt: 1,
};

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, page: 1, pageSize: 100, hasMore: false };
}

function createClient(): LullMediaClient {
  const client = {
    connect: vi.fn(async () => ({})),
    disconnect: vi.fn(async () => {}),
    events: { on: () => () => {} },
    library: {
      listTracks: vi.fn(async () => page([track])),
      listSmartPlaylists: vi.fn(async () => []),
      runSmartPlaylist: vi.fn(async () => page([])),
      createSmartPlaylist: vi.fn(),
      deleteSmartPlaylist: vi.fn(),
    },
    folders: {
      list: vi.fn(async () => [folder]),
      getTracks: vi.fn(async () =>
        page([{ ...track, relativePath: "rain.mp3" }]),
      ),
      add: vi.fn(async () => folder),
      scan: vi.fn(async () => ({
        jobId: "scan_1",
        sourceId: folder.id,
        status: "running" as const,
      })),
      cancelScan: vi.fn(async () => true),
      rename: vi.fn(async () => folder),
      remove: vi.fn(async () => true),
    },
    playlists: {
      list: vi.fn(async () => []),
    },
    player: { play: vi.fn(async () => ({})) },
    queue: { get: vi.fn(async () => ({ trackIds: [], revision: 1 })) },
    favorites: { set: vi.fn(), list: vi.fn() },
    history: { list: vi.fn(), clear: vi.fn() },
  };
  return client as unknown as LullMediaClient;
}

test("我的目录页签加载目录与目录曲目", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  await waitFor(() => {
    expect(client.folders.list).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(screen.getAllByText("Pop").length).toBeGreaterThan(0);
  });
  expect(screen.getByText(/rain\.mp3/)).toBeDefined();
  expect(client.folders.getTracks).toHaveBeenCalledWith("src_1", {
    pageSize: 100,
  });
});

test("最近添加页签按 addedAt 倒序请求", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "最近添加" }));

  await waitFor(() => {
    expect(client.library.listTracks).toHaveBeenLastCalledWith({
      sortBy: "addedAt",
      sortOrder: "desc",
      pageSize: 100,
    });
  });
});
