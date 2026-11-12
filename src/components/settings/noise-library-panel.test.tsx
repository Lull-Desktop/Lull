// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
import type { LullMediaClient } from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NoiseLibraryPanel } from "./noise-library-panel";

const mocks = vi.hoisted(() => ({
  getMediaClient: vi.fn(),
  listAssets: vi.fn(),
  getCategories: vi.fn(),
  getTags: vi.fn(),
  importAssets: vi.fn(),
  importFolder: vi.fn(),
  revalidateAssets: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  setAssetFavorite: vi.fn(),
  addTrack: vi.fn(),
  getSession: vi.fn(),
  playSession: vi.fn(),
  listPresets: vi.fn(),
}));

vi.mock("@/hooks/use-media-client", () => ({
  getMediaClient: mocks.getMediaClient,
}));

const page = { items: [], total: 0, page: 1, pageSize: 30, hasMore: false };
const categories = [
  {
    id: "cat_builtin",
    name: "自然",
    sortOrder: 0,
    assetCount: 0,
    sourceType: "builtin",
  },
  {
    id: "cat_user",
    name: "用户分类",
    sortOrder: 100,
    assetCount: 1,
    sourceType: "user",
  },
  {
    id: "cat_child",
    name: "子分类",
    parentId: "cat_user",
    sortOrder: 101,
    assetCount: 0,
    sourceType: "user",
  },
];
const tags = [
  { id: "tag_builtin", name: "雨", assetCount: 0, sourceType: "builtin" },
  { id: "tag_user", name: "用户标签", assetCount: 1, sourceType: "user" },
];

function client(): LullMediaClient {
  return {
    events: { on: vi.fn(() => () => {}) },
    noise: {
      library: {
        listAssets: mocks.listAssets,
        getCategories: mocks.getCategories,
        getTags: mocks.getTags,
        importAssets: mocks.importAssets,
        importFolder: mocks.importFolder,
        revalidateAssets: mocks.revalidateAssets,
        createCategory: mocks.createCategory,
        updateCategory: mocks.updateCategory,
        deleteCategory: mocks.deleteCategory,
        createTag: mocks.createTag,
        updateTag: mocks.updateTag,
        deleteTag: mocks.deleteTag,
        setAssetFavorite: mocks.setAssetFavorite,
      },
      getSounds: vi.fn(async () => []),
      tracks: {
        add: mocks.addTrack,
        remove: vi.fn(async () => {}),
        setVolume: vi.fn(async () => {}),
        setEnabled: vi.fn(async () => {}),
        setLoop: vi.fn(async () => {}),
        reorder: vi.fn(async () => {}),
      },
      session: { getCurrent: mocks.getSession, play: mocks.playSession },
      presets: { listPresets: mocks.listPresets },
    },
  } as unknown as LullMediaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAssets.mockResolvedValue(page);
  mocks.getCategories.mockResolvedValue(categories);
  mocks.getTags.mockResolvedValue(tags);
  mocks.importAssets.mockResolvedValue({
    imported: [],
    duplicates: [],
    failed: [],
  });
  mocks.importFolder.mockResolvedValue({
    imported: [],
    duplicates: [],
    failed: [],
  });
  mocks.revalidateAssets.mockResolvedValue({
    checked: 0,
    missing: 0,
    restored: 0,
  });
  mocks.createCategory.mockResolvedValue(categories[1]);
  mocks.updateCategory.mockResolvedValue(categories[1]);
  mocks.deleteCategory.mockResolvedValue(undefined);
  mocks.createTag.mockResolvedValue(tags[1]);
  mocks.updateTag.mockResolvedValue(tags[1]);
  mocks.deleteTag.mockResolvedValue(undefined);
  mocks.listPresets.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
    hasMore: false,
  });
  mocks.getMediaClient.mockReturnValue(client());
});

async function mount(): Promise<void> {
  render(<NoiseLibraryPanel />);
  await waitFor(() => expect(mocks.getCategories).toHaveBeenCalled());
  await screen.findByText("音境素材库");
}

describe("NoiseLibraryPanel", () => {
  test("supports import and missing-asset revalidation", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "音频导入" }));
    await waitFor(() => expect(mocks.importAssets).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(mocks.revalidateAssets).toHaveBeenCalled());
  });

  test("素材库页签内嵌预设管理，不再渲染音轨卡", async () => {
    await mount();

    // 预设的保存/导入导出随素材库页签；音轨编辑已迁到设置窗。
    expect(await screen.findByText("预设管理")).toBeDefined();
    expect(screen.queryByText("音轨（Session/Track API）")).toBeNull();
    expect(screen.queryByTestId("noise-session-tracks")).toBeNull();
  });
});
