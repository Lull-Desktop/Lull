/**
 * 设置页曲库浏览（MusicBrowser）测试：分类切换、按需加载、精简行与滚动容器。
 *
 * 六个分类原先在音乐管理窗口的页签里，迁到设置页后由这个组件统一渲染；
 * 分类是受控的，所以用一个最小外壳模拟设置页持有状态的写法。
 */
import type {
  AlbumSummary,
  ArtistSummary,
  HistoryEntry,
  LullMediaClient,
  Page,
  PlayerState,
  QueueState,
  TrackSummary,
} from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { MusicBrowser, type MusicCategory } from "./music-browser";

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

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, page: 1, pageSize: 100, hasMore: false };
}

function createClient(
  options: { queueState?: QueueState; historyEntries?: HistoryEntry[] } = {},
): LullMediaClient {
  const client = {
    connect: vi.fn(async () => ({ player: idleState })),
    disconnect: vi.fn(async () => {}),
    events: { on: () => () => {} },
    library: {
      listTracks: vi.fn(async () => page([track])),
      listArtists: vi.fn(async () => [artist]),
      listAlbums: vi.fn(async () => [album]),
      listGenres: vi.fn(async () => ["电子"]),
      getTrack: vi.fn(async (id: string) => ({ ...track, id })),
    },
    player: {
      play: vi.fn(async () => ({ ...idleState, track, status: "playing" })),
      resume: vi.fn(async () => ({ ...idleState, status: "playing" })),
      stop: vi.fn(async () => idleState),
      setMode: vi.fn(async () => ({
        ...idleState,
        mode: "repeat-one" as const,
      })),
    },
    queue: {
      get: vi.fn(
        async () => options.queueState ?? { trackIds: [], revision: 1 },
      ),
      add: vi.fn(async () => ({ trackIds: [track.id], revision: 2 })),
      remove: vi.fn(async () => true),
      playAt: vi.fn(async () => ({ ...idleState, track, status: "playing" })),
    },
    favorites: {
      set: vi.fn(async () => ({ favorite: true })),
      list: vi.fn(async () => page([track])),
    },
    history: {
      list: vi.fn(async () => page(options.historyEntries ?? [])),
      clear: vi.fn(async () => true),
    },
    playlists: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      reorder: vi.fn(),
      importM3u: vi.fn(),
      exportM3u: vi.fn(),
    },
  };
  return client as unknown as LullMediaClient;
}

/** 设置页的写法：分类受控，初始值可指定。 */
function Harness({
  client,
  initial = "tracks",
}: {
  client: LullMediaClient;
  initial?: MusicCategory;
}) {
  const [category, setCategory] = useState<MusicCategory>(initial);
  return (
    <MusicBrowser
      client={client}
      category={category}
      onCategoryChange={setCategory}
    />
  );
}

test("默认停在全部歌曲，关键字与筛选一起进入 TrackQuery", async () => {
  const client = createClient();
  render(<Harness client={client} />);

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
  expect(await screen.findByText("雨")).toBeDefined();

  // 高级筛选默认收起，只留搜索框与统计。
  expect(screen.queryByLabelText("艺术家")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));

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

test("艺术家筛选只列出有曲目的艺术家", async () => {
  const albumOnlyArtist: ArtistSummary = {
    ...artist,
    id: "art_album_only",
    name: "Ocean Waves",
    trackCount: 0,
  };
  const client = createClient();
  vi.mocked(client.library.listArtists).mockResolvedValue([
    artist,
    albumOnlyArtist,
  ]);
  render(<Harness client={client} />);

  await screen.findByText("雨");
  fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));

  const select = (await screen.findByLabelText("艺术家")) as HTMLSelectElement;
  await waitFor(() => {
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toEqual(["艺术家", "Lull"]);
  });
  expect(screen.queryByRole("option", { name: "Ocean Waves" })).toBeNull();
});

test("切到我的收藏会按需加载收藏列表", async () => {
  const client = createClient();
  render(<Harness client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "我的收藏" }));

  await waitFor(() => {
    expect(client.favorites.list).toHaveBeenCalledWith(1, 100);
  });
  expect(await screen.findByText("雨")).toBeDefined();
  expect(
    screen
      .getByRole("button", { name: /我的收藏/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("精简行只保留喜欢 / 播放 / 加入队列", async () => {
  const client = createClient();
  render(<Harness client={client} />);

  await screen.findByText("雨");

  expect(screen.getByRole("button", { name: "播放" })).toBeDefined();
  expect(screen.getByRole("button", { name: "喜欢" })).toBeDefined();
  expect(screen.getByRole("button", { name: "加入队列" })).toBeDefined();
  // 编辑元数据与「加入歌单」下拉只在音乐管理窗口提供。
  expect(screen.queryByTitle("编辑元数据与标签")).toBeNull();
  expect(screen.queryByLabelText("加入歌单")).toBeNull();
});

test("队列分类保留移出操作", async () => {
  const client = createClient({
    queueState: { trackIds: [track.id], currentIndex: 0, revision: 1 },
  });
  render(<Harness client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "队列" }));

  expect(await screen.findByText("雨")).toBeDefined();
  expect(screen.getByText(/Lull · 夜/)).toBeDefined();
  expect(screen.getByText("02:00")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "移出队列" }));

  await waitFor(() => {
    expect(client.queue.remove).toHaveBeenCalledWith("trk_1");
  });
});

test("最近播放去重并标注最近一次播放时间", async () => {
  const playedAt = new Date("2026-11-02T10:00:00Z").getTime();
  const client = createClient({
    historyEntries: [
      { id: "h_1", trackId: track.id, track, playedAt, completed: true },
      {
        id: "h_2",
        trackId: track.id,
        track,
        playedAt: playedAt - 60_000,
        completed: true,
      },
    ],
  });
  render(<Harness client={client} />);

  fireEvent.click(screen.getByRole("button", { name: "最近播放" }));

  expect(await screen.findAllByText("雨")).toHaveLength(1);
  expect(
    screen.getByText((content) =>
      content.includes(new Date(playedAt).toLocaleString()),
    ),
  ).toBeDefined();
});

test("内容区是唯一滚动条，分类行走自己的限高滚动", async () => {
  const client = createClient();
  render(<Harness client={client} />);

  const content = screen.getByTestId("music-browser-content");
  // 内容区自己滚，并留一个高度下限（极矮窗口下不被分类行挤成 0 高）；
  // 父级链是 flex-1 + min-h-0，卡片才不会被内容撑高。
  expect(content.className).toContain("overflow-y-auto");
  expect(content.className).toContain("min-h-[140px]");
  expect(content.className).toContain("flex-1");
  expect(content.parentElement?.className).toContain("min-h-0");

  const categories = screen.getByTestId("music-browser-categories");
  expect(categories.className).toContain("overflow-y-auto");
  expect(categories.className).toContain("max-h-");
  expect(categories.parentElement?.className).toContain("flex-1");
});
