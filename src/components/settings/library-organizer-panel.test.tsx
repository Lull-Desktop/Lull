// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
import type {
  MediaRequest,
  Page,
  PlayerState,
  TagView,
  TrackSummary,
} from "@lull/media-sdk";
import { createMediaClient, LullMediaError } from "@lull/media-sdk";
import { createMemoryTransport } from "@lull/media-sdk/testing";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LibraryOrganizerPanel } from "./library-organizer-panel";

const track: TrackSummary = {
  id: "trk_1",
  title: "测试曲目",
  artists: ["Lull"],
  album: "夜",
  genre: "Ambient",
  year: 2026,
  source: "local",
  available: true,
  hasCover: false,
  tags: [],
};

const page: Page<TrackSummary> = {
  items: [track],
  total: 1,
  page: 1,
  pageSize: 100,
  hasMore: false,
};

const idleState: PlayerState = {
  status: "idle",
  positionMs: 0,
  volume: 1,
  muted: false,
  mode: "sequence",
  revision: 1,
};

test("选择曲目并保存元数据/标签", async () => {
  const update = vi.fn(async (_args: unknown) => ({
    ...track,
    title: "新标题",
  }));
  const setTags = vi.fn(async (_args: unknown) => ({ updated: true }));
  const handler = (request: MediaRequest): unknown => {
    switch (`${request.namespace}.${request.method}`) {
      case "library.listTags":
        return [{ id: "tag_1", name: "夜间", trackCount: 1 }];
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
      case "library.listSmartPlaylists":
        return [];
      case "library.listTracks":
        return page;
      case "library.updateTrackMetadata":
        return update(request.args);
      case "library.setTrackTags":
        return setTags(request.args);
      default:
        return null;
    }
  };

  const client = createMediaClient({
    transport: createMemoryTransport(handler),
  });
  render(<LibraryOrganizerPanel client={client} />);

  expect(await screen.findByText("曲库整理测试")).toBeDefined();
  const row = await screen.findByRole("button", {
    name: "选择曲目 测试曲目",
  });
  fireEvent.click(row);

  const title = await screen.findByLabelText("标题");
  fireEvent.change(title, { target: { value: "新标题" } });
  fireEvent.click(screen.getByRole("button", { name: /保存元数据与标签/ }));

  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(setTags).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[0]).toMatchObject({
    trackId: "trk_1",
    title: "新标题",
  });
});

test("曲目行提供预览播放与停止切换", async () => {
  const transport = createMemoryTransport((request): unknown => {
    switch (`${request.namespace}.${request.method}`) {
      case "library.listTags":
      case "library.listArtists":
      case "library.listAlbums":
      case "library.listSmartPlaylists":
        return [];
      case "library.listTracks":
        return page;
      case "player.getState":
        return idleState;
      case "player.play":
        return { ...idleState, track, status: "playing", revision: 2 };
      case "player.stop":
        return { ...idleState, revision: 3 };
      default:
        return null;
    }
  });
  const client = createMediaClient({ transport });
  render(<LibraryOrganizerPanel client={client} />);

  fireEvent.click(
    await screen.findByRole("button", { name: "播放预览 测试曲目" }),
  );
  await waitFor(() => {
    const plays = transport.requests.filter(
      (request) => request.namespace === "player" && request.method === "play",
    );
    expect(plays).toHaveLength(1);
    expect(plays[0]?.args).toMatchObject({ trackId: "trk_1" });
  });
  expect(
    await screen.findByRole("button", { name: "停止预览 测试曲目" }),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "停止预览 测试曲目" }));
  await waitFor(() => {
    expect(
      transport.requests.some(
        (request) =>
          request.namespace === "player" && request.method === "stop",
      ),
    ).toBe(true);
  });
  expect(
    await screen.findByRole("button", { name: "播放预览 测试曲目" }),
  ).toBeDefined();
});

/** 有状态的标签/曲目夹具，CRUD 与 setTrackTags 会作用到同一份内存数据。 */
function createTagManagerClient() {
  const managedTags: TagView[] = [
    { id: "tag_1", name: "夜间", trackCount: 0 },
    { id: "tag_2", name: "通勤", trackCount: 0 },
  ];
  const managedTracks: TrackSummary[] = [
    { ...track, tags: [managedTags[0], managedTags[1]] },
    {
      id: "trk_2",
      title: "清晨",
      artists: ["Lull"],
      source: "local",
      available: true,
      hasCover: false,
      tags: [managedTags[1]],
    },
  ];
  const countOf = (tagId: string): number =>
    managedTracks.filter((item) =>
      (item.tags ?? []).some((tag) => tag.id === tagId),
    ).length;

  const handler = (request: MediaRequest): unknown => {
    const args = (request.args ?? {}) as Record<string, unknown>;
    switch (`${request.namespace}.${request.method}`) {
      case "player.getState":
        return idleState;
      case "library.listTags":
        return managedTags.map((tag) => ({
          ...tag,
          trackCount: countOf(tag.id),
        }));
      case "library.listTracks": {
        const keyword = typeof args.keyword === "string" ? args.keyword : "";
        const tagId = typeof args.tagId === "string" ? args.tagId : "";
        const items = managedTracks.filter((item) => {
          if (keyword && !item.title.includes(keyword)) return false;
          return !tagId || (item.tags ?? []).some((tag) => tag.id === tagId);
        });
        return {
          items,
          total: items.length,
          page: 1,
          pageSize: 100,
          hasMore: false,
        };
      }
      case "library.createTag": {
        const name = String(args.name ?? "").trim();
        if (managedTags.some((tag) => tag.name === name)) {
          throw new LullMediaError({
            code: "tag.exists",
            message: "同名标签已存在",
          });
        }
        const tag: TagView = {
          id: `tag_${managedTags.length + 1}`,
          name,
          trackCount: 0,
        };
        managedTags.push(tag);
        return tag;
      }
      case "library.renameTag": {
        const tag = managedTags.find((item) => item.id === args.tagId);
        if (!tag) {
          throw new LullMediaError({
            code: "tag.not-found",
            message: "标签不存在",
          });
        }
        tag.name = String(args.name ?? "");
        return { ...tag, trackCount: countOf(tag.id) };
      }
      case "library.deleteTag": {
        const index = managedTags.findIndex((item) => item.id === args.tagId);
        if (index < 0) {
          throw new LullMediaError({
            code: "tag.not-found",
            message: "标签不存在",
          });
        }
        const removed = managedTags[index];
        managedTags.splice(index, 1);
        for (const item of managedTracks) {
          item.tags = (item.tags ?? []).filter((tag) => tag.id !== removed?.id);
        }
        return { deleted: true };
      }
      case "library.setTrackTags": {
        const ids = Array.isArray(args.tagIds) ? (args.tagIds as string[]) : [];
        const item = managedTracks.find(
          (candidate) => candidate.id === args.trackId,
        );
        if (!item) {
          throw new LullMediaError({
            code: "track.not-found",
            message: "曲目不存在",
          });
        }
        item.tags = ids
          .map((id) => managedTags.find((tag) => tag.id === id))
          .filter((tag): tag is TagView => Boolean(tag));
        return { updated: true };
      }
      case "library.listArtists":
      case "library.listAlbums":
      case "library.listSmartPlaylists":
        return [];
      default:
        return null;
    }
  };

  const transport = createMemoryTransport(handler);
  return { client: createMediaClient({ transport }), transport };
}

test("标签管理卡片支持新建标签并自动选中", async () => {
  const { client, transport } = createTagManagerClient();
  render(<LibraryOrganizerPanel client={client} />);

  expect(await screen.findByLabelText("选择标签 夜间")).toBeDefined();
  fireEvent.change(screen.getByLabelText("新标签名称"), {
    target: { value: "深夜" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建标签" }));

  expect(await screen.findByLabelText("选择标签 深夜")).toBeDefined();
  expect(await screen.findByText("「深夜」的曲目")).toBeDefined();
  expect(
    transport.requests.find((request) => request.method === "createTag")?.args,
  ).toEqual({ name: "深夜" });
});

test("标签管理卡片支持内联重命名与确认删除", async () => {
  const { client, transport } = createTagManagerClient();
  render(<LibraryOrganizerPanel client={client} />);

  fireEvent.click(await screen.findByLabelText("重命名标签 夜间"));
  fireEvent.change(screen.getByLabelText("编辑标签名称"), {
    target: { value: "夜晚" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存标签名称" }));

  expect(await screen.findByLabelText("选择标签 夜晚")).toBeDefined();
  expect(
    transport.requests.find((request) => request.method === "renameTag")?.args,
  ).toEqual({ tagId: "tag_1", name: "夜晚" });

  fireEvent.click(await screen.findByLabelText("删除标签 通勤"));
  const dialog = await screen.findByRole("dialog", { name: "删除标签" });
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

  await waitFor(() =>
    expect(screen.queryByLabelText("选择标签 通勤")).toBeNull(),
  );
  expect(
    transport.requests.find((request) => request.method === "deleteTag")?.args,
  ).toEqual({ tagId: "tag_2" });
});

test("标签管理卡片按标签加载曲目并在移除时保留其他标签", async () => {
  const { client, transport } = createTagManagerClient();
  render(<LibraryOrganizerPanel client={client} />);

  fireEvent.click(await screen.findByLabelText("从标签移除 测试曲目"));

  await waitFor(() =>
    expect(
      transport.requests.find((request) => request.method === "setTrackTags")
        ?.args,
    ).toEqual({ trackId: "trk_1", tagIds: ["tag_2"] }),
  );
});

test("标签管理卡片可搜索曲目并加入当前标签", async () => {
  const { client, transport } = createTagManagerClient();
  render(<LibraryOrganizerPanel client={client} />);

  fireEvent.change(await screen.findByLabelText("搜索要加入标签的曲目"), {
    target: { value: "清晨" },
  });
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "将 清晨 加入标签" },
      { timeout: 3000 },
    ),
  );

  await waitFor(() =>
    expect(
      transport.requests.find((request) => request.method === "setTrackTags")
        ?.args,
    ).toEqual({ trackId: "trk_2", tagIds: ["tag_2", "tag_1"] }),
  );
});

test("标签管理卡片显示重名错误并保留输入", async () => {
  const { client } = createTagManagerClient();
  render(<LibraryOrganizerPanel client={client} />);

  expect(await screen.findByLabelText("选择标签 夜间")).toBeDefined();
  const input = screen.getByLabelText("新标签名称") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "夜间" } });
  fireEvent.click(screen.getByRole("button", { name: "创建标签" }));

  expect(await screen.findByText(/同名标签已存在/)).toBeDefined();
  expect(input.value).toBe("夜间");
});
