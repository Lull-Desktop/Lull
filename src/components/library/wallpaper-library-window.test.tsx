/**
 * 壁纸管理窗口：只剩媒体素材管理，不再有页签导航。
 *
 * 壁纸层本身的交互测试在 src/app/(control)/setting/wallpaper-tab.test.tsx。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MediaAsset } from "@/core/media/types";
import { WallpaperLibraryWindow } from "./wallpaper-library-window";

afterEach(() => {
  mediaApi.listMediaAssets.mockClear();
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// 只替换素材列表查询，其余媒体封装保持真实实现（浏览器下自然降级为空）。
const mediaApi = vi.hoisted(() => ({
  listMediaAssets: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/core/media/media-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/core/media/media-api")>();
  return { ...actual, listMediaAssets: mediaApi.listMediaAssets };
});

const VIDEO_ASSET: MediaAsset = {
  id: "m_9f2c0d",
  name: "雾山.mp4",
  kind: "video",
  sizeBytes: 1024 * 1024,
  addedAt: 0,
  available: true,
};

test("窗口只有素材管理，不再有页签导航", () => {
  render(<WallpaperLibraryWindow />);

  expect(screen.getByRole("heading", { name: "壁纸管理" })).toBeDefined();
  expect(
    screen.getByText("导入、预览与管理壁纸使用的图片和视频素材。"),
  ).toBeDefined();
  // 原「壁纸层 / 素材管理」两个页签按钮都已移除。
  expect(screen.queryByRole("button", { name: "壁纸层" })).toBeNull();
  expect(screen.queryByRole("button", { name: "素材管理" })).toBeNull();

  const pane = screen.getByTestId("wallpaper-media-pane");
  expect(within(pane).getByText("素材库")).toBeDefined();
});

test("挂载即读取素材，无需先切页签", async () => {
  render(<WallpaperLibraryWindow />);

  await waitFor(() =>
    expect(mediaApi.listMediaAssets).toHaveBeenCalledTimes(1),
  );
});

test("素材列表在窗口内容区里渲染", async () => {
  mediaApi.listMediaAssets.mockResolvedValueOnce([VIDEO_ASSET]);
  render(<WallpaperLibraryWindow />);

  const pane = screen.getByTestId("wallpaper-media-pane");
  // 素材名在列表与预览区各出现一次，按列表容器收窄。
  const list = await within(pane).findByTestId("media-asset-list");
  expect(within(list).getByText("雾山.mp4")).toBeDefined();
});
