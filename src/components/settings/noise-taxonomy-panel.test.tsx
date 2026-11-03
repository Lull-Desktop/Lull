import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LullMediaClient } from "@lull/media-sdk";
import { NoiseTaxonomyPanel } from "./noise-taxonomy-panel";

const mocks = vi.hoisted(() => ({
  getMediaClient: vi.fn(),
  getCategories: vi.fn(),
  getTags: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
}));

vi.mock("@/hooks/use-media-client", () => ({
  getMediaClient: mocks.getMediaClient,
}));

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
        getCategories: mocks.getCategories,
        getTags: mocks.getTags,
        createCategory: mocks.createCategory,
        updateCategory: mocks.updateCategory,
        deleteCategory: mocks.deleteCategory,
        createTag: mocks.createTag,
        updateTag: mocks.updateTag,
        deleteTag: mocks.deleteTag,
      },
    },
  } as unknown as LullMediaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCategories.mockResolvedValue(categories);
  mocks.getTags.mockResolvedValue(tags);
  mocks.createCategory.mockResolvedValue(categories[1]);
  mocks.updateCategory.mockResolvedValue(categories[1]);
  mocks.deleteCategory.mockResolvedValue(undefined);
  mocks.createTag.mockResolvedValue(tags[1]);
  mocks.updateTag.mockResolvedValue(tags[1]);
  mocks.deleteTag.mockResolvedValue(undefined);
  mocks.getMediaClient.mockReturnValue(client());
});

async function mount(): Promise<void> {
  render(<NoiseTaxonomyPanel />);
  await waitFor(() => expect(mocks.getCategories).toHaveBeenCalled());
  await screen.findByText("分类与标签");
}

describe("NoiseTaxonomyPanel", () => {
  test("creates, renames and deletes user taxonomy", async () => {
    await mount();

    fireEvent.change(screen.getByPlaceholderText("新分类名称"), {
      target: { value: "新分类" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建分类" }));
    await waitFor(() =>
      expect(mocks.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ name: "新分类" }),
      ),
    );

    fireEvent.click(screen.getAllByLabelText("编辑分类")[0]);
    fireEvent.change(screen.getByLabelText("编辑分类名称"), {
      target: { value: "改名分类" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存分类" }));
    await waitFor(() =>
      expect(mocks.updateCategory).toHaveBeenCalledWith(
        "cat_user",
        expect.objectContaining({ name: "改名分类", parentId: null }),
      ),
    );

    fireEvent.click(screen.getAllByLabelText("删除分类")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(mocks.deleteCategory).toHaveBeenCalledWith("cat_user"),
    );

    fireEvent.change(screen.getByPlaceholderText("新标签名称"), {
      target: { value: "新标签" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await waitFor(() => expect(mocks.createTag).toHaveBeenCalledWith("新标签"));

    fireEvent.click(screen.getAllByLabelText("编辑标签")[0]);
    fireEvent.change(screen.getByLabelText("编辑标签名称"), {
      target: { value: "改名标签" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() =>
      expect(mocks.updateTag).toHaveBeenCalledWith("tag_user", "改名标签"),
    );

    fireEvent.click(screen.getAllByLabelText("删除标签")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(mocks.deleteTag).toHaveBeenCalledWith("tag_user"),
    );
  });

  test("shows backend duplicate/cycle errors", async () => {
    mocks.createTag.mockRejectedValueOnce(new Error("已存在同名标签"));
    await mount();
    fireEvent.change(screen.getByPlaceholderText("新标签名称"), {
      target: { value: "雨" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    expect(await screen.findByText("已存在同名标签")).toBeDefined();
  });
});
