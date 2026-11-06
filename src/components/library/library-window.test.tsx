import {
  type AlbumSummary,
  type ArtistSummary,
  DEFAULT_SMART_SHUFFLE_CONFIG,
  type HistoryEntry,
  type LullMediaClient,
  type MusicFolderView,
  type Page,
  type PlayerState,
  type QueueState,
  type SmartShuffleProfile,
  type SmartShuffleProfileSummary,
  type TrackSummary,
} from "@lull/media-sdk";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

const singlesFolder: MusicFolderView = {
  id: "src_singles",
  name: "单曲导入",
  recursive: false,
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

const builtinShuffleProfile: SmartShuffleProfile = {
  id: "builtin:balanced",
  name: "均衡随机",
  builtin: true,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

const userShuffleProfile: SmartShuffleProfile = {
  id: "shuffle_profile_test",
  name: "夜航",
  builtin: false,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

const shuffleProfiles: SmartShuffleProfileSummary[] = [
  {
    id: builtinShuffleProfile.id,
    name: builtinShuffleProfile.name,
    builtin: true,
    active: true,
  },
  {
    id: userShuffleProfile.id,
    name: userShuffleProfile.name,
    builtin: false,
    active: false,
  },
];

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, page: 1, pageSize: 100, hasMore: false };
}

function createClient(
  state: PlayerState = idleState,
  options: {
    queueState?: QueueState;
    historyEntries?: HistoryEntry[];
    folderEntries?: MusicFolderView[];
    artistEntries?: ArtistSummary[];
  } = {},
): LullMediaClient {
  const client = {
    connect: vi.fn(async () => ({ player: state })),
    disconnect: vi.fn(async () => {}),
    events: { on: () => () => {} },
    library: {
      listTracks: vi.fn(async () => page([track])),
      listArtists: vi.fn(async () => options.artistEntries ?? [artist]),
      listAlbums: vi.fn(async () => [album]),
      listGenres: vi.fn(async () => ["电子"]),
      listTags: vi.fn(async () => []),
      listSmartPlaylists: vi.fn(async () => []),
      runSmartPlaylist: vi.fn(async () => page([])),
      createSmartPlaylist: vi.fn(),
      deleteSmartPlaylist: vi.fn(),
      exportBackup: vi.fn(async () => null),
      importBackup: vi.fn(async () => null),
      getTrack: vi.fn(async (id: string) => ({ ...track, id })),
    },
    folders: {
      list: vi.fn(async () => options.folderEntries ?? [folder]),
      getTracks: vi.fn(async () =>
        page([{ ...track, relativePath: "rain.mp3" }]),
      ),
      add: vi.fn(async () => folder),
      addSingles: vi.fn(async () => ({
        folder: singlesFolder,
        added: 1,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [] as string[],
      })),
      scan: vi.fn(async () => ({
        jobId: "scan_1",
        sourceId: folder.id,
        status: "running" as const,
      })),
      cancelScan: vi.fn(async () => true),
      rename: vi.fn(async () => folder),
      remove: vi.fn(async () => true),
      removeTrack: vi.fn(async () => true),
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
      listShuffleProfiles: vi.fn(async () => shuffleProfiles),
      getShuffleProfile: vi.fn(async (profileId?: string) =>
        profileId === userShuffleProfile.id
          ? userShuffleProfile
          : builtinShuffleProfile,
      ),
      saveShuffleProfile: vi.fn(
        async (input: {
          profileId?: string;
          name: string;
          config: SmartShuffleProfile["config"];
        }) => ({
          id: input.profileId ?? "shuffle_profile_saved",
          name: input.name,
          builtin: false,
          config: input.config,
        }),
      ),
      deleteShuffleProfile: vi.fn(async () => true),
      activateShuffleProfile: vi.fn(async (profileId: string) =>
        profileId === userShuffleProfile.id
          ? userShuffleProfile
          : builtinShuffleProfile,
      ),
    },
    queue: {
      get: vi.fn(
        async () => options.queueState ?? { trackIds: [], revision: 1 },
      ),
      playAt: vi.fn(async () => ({ ...state, track, status: "playing" })),
      remove: vi.fn(async () => true),
    },
    favorites: { set: vi.fn(), list: vi.fn(async () => page([])) },
    history: {
      list: vi.fn(async () => page(options.historyEntries ?? [])),
      clear: vi.fn(),
    },
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

test("我的目录提供单曲导入入口", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "导入单曲" }));

  await waitFor(() => {
    expect(client.folders.addSingles).toHaveBeenCalledWith({
      name: "单曲导入",
    });
  });
  await screen.findByText("已导入 1 首单曲。");
});

test("单曲导入目录带单曲标记且不显示扫描按钮", async () => {
  const client = createClient(idleState, {
    folderEntries: [singlesFolder],
  });
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  await waitFor(async () => {
    expect((await screen.findAllByText("单曲导入")).length).toBeGreaterThan(0);
  });
  expect(screen.getByText("单曲")).toBeDefined();
  expect(screen.queryByRole("button", { name: "扫描" })).toBeNull();
});

test("单曲导入目录的曲目可逐条删除", async () => {
  const client = createClient(idleState, {
    folderEntries: [singlesFolder],
  });
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除单曲" }));

  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除单曲" }));

  await waitFor(() => {
    expect(client.folders.removeTrack).toHaveBeenCalledWith(
      "src_singles",
      "trk_1",
    );
  });
  await screen.findByText("已删除该单曲。");
});

test("目录导入的曲目列表不显示单曲删除按钮", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  expect(await screen.findByText("雨")).toBeDefined();
  expect(screen.queryByRole("button", { name: "删除单曲" })).toBeNull();
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

// 备份导出/恢复入口在「音乐库面板迁移至主界面」时被整体注释（见 library-window.tsx 里
// 注释掉的 exportBackup 回调与备份区块）。功能与 client 仍在，等入口恢复后取消 skip。
test.skip("我的目录保留备份与恢复入口", async () => {
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

test("测试与接口页签渲染媒体 API 面板", async () => {
  const client = createClient();
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "测试与接口" }));

  expect(await screen.findByText("媒体 API 测试面板")).toBeDefined();
  expect(await screen.findByText("智能随机 API 能力")).toBeDefined();
  await waitFor(() => {
    expect(client.player.listShuffleProfiles).toHaveBeenCalled();
  });
});

test("切换工具页签不会断开窗口的媒体订阅", async () => {
  const client = createClient();
  const { unmount } = render(<LibraryWindow client={client} />);

  await waitFor(() => {
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  fireEvent.click(screen.getByRole("button", { name: "曲库整理" }));
  fireEvent.click(screen.getByRole("button", { name: "测试与接口" }));
  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  expect(client.connect).toHaveBeenCalledTimes(1);
  expect(client.disconnect).not.toHaveBeenCalled();

  unmount();
  await waitFor(() => {
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});

test("我的目录按路径层级缩进子目录", async () => {
  const client = createClient(idleState, {
    folderEntries: [
      folder,
      {
        ...folder,
        id: "src_2",
        name: "Live",
        rootPath: "C:////Music////Pop////Live",
      },
    ],
  });
  render(<LibraryWindow client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的目录" }));

  const child = await screen.findByText("Live");
  const parent = screen.getAllByText("Pop")[0];
  expect((parent as HTMLElement).style.paddingLeft).toBe("0px");
  expect((child as HTMLElement).style.paddingLeft).toBe("12px");
});
