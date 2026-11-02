import type {
  AlbumSummary,
  ArtistSummary,
  LullMediaClient,
  MusicFolderView,
  Page,
  PlayerState,
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

const artist: ArtistSummary = {
  id: "art_1",
  name: "Lull",
  kind: "person",
  trackCount: 1,
  needsReview: false,
};

const album: AlbumSummary = {
  id: "alb_1",
  title: "夜",
  year: 2024,
  kind: "album",
  trackCount: 1,
  hasCover: false,
};

const idleState: PlayerState = {
  status: "idle",
  positionMs: 0,
  volume: 1,
  muted: false,
  mode: "sequence",
  revision: 1,
};

const playingState: PlayerState = {
  ...idleState,
  track,
  status: "playing",
  positionMs: 1000,
  durationMs: 120_000,
  revision: 2,
};

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, page: 1, pageSize: 100, hasMore: false };
}

function createClient(state: PlayerState = idleState): LullMediaClient {
  const client = {
    connect: vi.fn(async () => ({ player: state })),
    disconnect: vi.fn(async () => {}),
    events: { on: () => () => {} },
    library: {
      listTracks: vi.fn(async () => page([track])),
      listArtists: vi.fn(async () => [artist]),
      listAlbums: vi.fn(async () => [album]),
      listGenres: vi.fn(async () => ["电子"]),
      listTags: vi.fn(async () => []),
      listSmartPlaylists: vi.fn(async () => []),
      runSmartPlaylist: vi.fn(async () => page([])),
      createSmartPlaylist: vi.fn(),
      deleteSmartPlaylist: vi.fn(),
      exportBackup: vi.fn(async () => null),
      importBackup: vi.fn(async () => null),
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
    player: {
      getState: vi.fn(async () => state),
      play: vi.fn(async () => ({ ...state, track, status: "playing" })),
      resume: vi.fn(async () => ({ ...state, status: "playing" })),
      stop: vi.fn(async () => idleState),
      setMode: vi.fn(async () => ({ ...state, mode: "repeat-one" as const })),
    },
    queue: {
      get: vi.fn(async () => ({ trackIds: [], revision: 1 })),
      playAt: vi.fn(async () => ({ ...state, track, status: "playing" })),
    },
    favorites: { set: vi.fn(), list: vi.fn(async () => page([])) },
    history: { list: vi.fn(async () => page([])), clear: vi.fn() },
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

test("全部歌曲的筛选索引与关键字一起进入 TrackQuery", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  await waitFor(() => {
    expect(client.library.listTracks).toHaveBeenCalledWith({
      keyword: undefined,
      artistId: undefined,
      albumId: undefined,
      genre: undefined,
      format: undefined,
      year: undefined,
      pageSize: 100,
    });
  });

  await screen.findByRole("option", { name: "Lull" });
  fireEvent.change(screen.getByLabelText("艺术家"), {
    target: { value: "art_1" },
  });

  await waitFor(() => {
    expect(client.library.listTracks).toHaveBeenLastCalledWith({
      keyword: undefined,
      artistId: "art_1",
      albumId: undefined,
      genre: undefined,
      format: undefined,
      year: undefined,
      pageSize: 100,
    });
  });

  fireEvent.change(screen.getByPlaceholderText("搜索曲目、艺术家、专辑"), {
    target: { value: "雨" },
  });

  await waitFor(() => {
    expect(client.library.listTracks).toHaveBeenLastCalledWith({
      keyword: "雨",
      artistId: "art_1",
      albumId: undefined,
      genre: undefined,
      format: undefined,
      year: undefined,
      pageSize: 100,
    });
  });

  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));

  await waitFor(() => {
    expect(client.library.listTracks).toHaveBeenLastCalledWith({
      keyword: "雨",
      artistId: undefined,
      albumId: undefined,
      genre: undefined,
      format: undefined,
      year: undefined,
      pageSize: 100,
    });
  });
});

test("从资料库播放会先切到单曲循环", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(await screen.findByRole("button", { name: "播放" }));

  await waitFor(() => {
    expect(client.player.setMode).toHaveBeenCalledWith("repeat-one");
  });
  await waitFor(() => {
    expect(client.player.play).toHaveBeenCalledWith("trk_1");
  });
});

test("正在播放的曲目把播放按钮切成停止，点停止后回到播放", async () => {
  const client = createClient(playingState);
  render(<LibraryWindow client={client} />);

  fireEvent.click(await screen.findByRole("button", { name: "停止" }));

  await waitFor(() => {
    expect(client.player.stop).toHaveBeenCalledTimes(1);
  });
  await screen.findByRole("button", { name: "播放" });
  expect(client.player.play).not.toHaveBeenCalled();
});

test("我的目录保留备份与恢复入口", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  await screen.findByText("备份与恢复");
  fireEvent.click(screen.getByRole("button", { name: "导出" }));

  await waitFor(() => {
    expect(client.library.exportBackup).toHaveBeenCalledTimes(1);
  });
});

test("曲库整理页签渲染整理面板并复用窗口 client", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "曲库整理" }));

  expect(await screen.findByText("曲库整理测试")).toBeDefined();
  await waitFor(() => {
    expect(client.library.listTags).toHaveBeenCalled();
  });
});

test("媒体测试页签渲染媒体 API 面板", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "媒体测试" }));

  expect(await screen.findByText("媒体 API 测试面板")).toBeDefined();
});

test("切换工具页签不会断开窗口的媒体订阅", async () => {
  const client = createClient();
  const { unmount } = render(<LibraryWindow client={client} />);

  await waitFor(() => {
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  fireEvent.click(screen.getByRole("button", { name: "曲库整理" }));
  fireEvent.click(screen.getByRole("button", { name: "媒体测试" }));
  fireEvent.click(screen.getByRole("button", { name: "全部歌曲" }));

  expect(client.connect).toHaveBeenCalledTimes(1);
  expect(client.disconnect).not.toHaveBeenCalled();

  unmount();
  await waitFor(() => {
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
