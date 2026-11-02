/**
 * 素材管理面板：导入汇总、预览、重命名、清理与设为壁纸的交互契约。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MediaAsset } from "@/core/media/types";
import { MediaManagerPanel } from "./media-manager-panel";

const mocks = vi.hoisted(() => ({
  listMediaAssets: vi.fn(),
  getMediaAssetUrl: vi.fn(),
  importMediaAssets: vi.fn(),
  renameMediaAsset: vi.fn(),
  pruneMediaAssets: vi.fn(),
  removeMediaAsset: vi.fn(),
  activateMediaAsset: vi.fn(),
}));

vi.mock("@/core/media/media-api", () => ({
  listMediaAssets: mocks.listMediaAssets,
  getMediaAssetUrl: mocks.getMediaAssetUrl,
  importMediaAssets: mocks.importMediaAssets,
  renameMediaAsset: mocks.renameMediaAsset,
  pruneMediaAssets: mocks.pruneMediaAssets,
  removeMediaAsset: mocks.removeMediaAsset,
  activateMediaAsset: mocks.activateMediaAsset,
}));

vi.mock("@/core/media/media-events", () => ({
  onMediaChanged: () => () => {},
}));

const image: MediaAsset = {
  id: "m_img",
  name: "山景.png",
  kind: "image",
  sizeBytes: 2048,
  addedAt: 2,
  available: true,
};

const video: MediaAsset = {
  id: "m_vid",
  name: "夜.mp4",
  kind: "video",
  sizeBytes: 1024 * 1024,
  addedAt: 1,
  available: true,
};

const gone: MediaAsset = {
  id: "m_gone",
  name: "旧图.png",
  kind: "image",
  sizeBytes: 10,
  addedAt: 0,
  available: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMediaAssets.mockResolvedValue([image, video]);
  mocks.getMediaAssetUrl.mockImplementation(
    async (id: string) => `http://asset.localhost/${id}`,
  );
  mocks.importMediaAssets.mockResolvedValue({
    added: [],
    skipped: 0,
    failed: [],
  });
  mocks.renameMediaAsset.mockResolvedValue(image);
  mocks.pruneMediaAssets.mockResolvedValue(0);
  mocks.removeMediaAsset.mockResolvedValue(undefined);
  mocks.activateMediaAsset.mockResolvedValue({});
});

/** 列表与预览区都会显示素材名，按列表容器界定查询范围。 */
async function findInList(text: string): Promise<void> {
  const list = await screen.findByTestId("media-asset-list");
  expect(within(list).getByText(text)).toBeTruthy();
}

describe("MediaManagerPanel", () => {
  test("空素材库给出说明与导入入口，清理按钮不可点", async () => {
    mocks.listMediaAssets.mockResolvedValue([]);
    render(<MediaManagerPanel active />);

    expect(await screen.findByText("还没有素材。")).toBeTruthy();
    const prune = screen.getByRole("button", {
      name: "清理失效素材",
    }) as HTMLButtonElement;
    expect(prune.disabled).toBe(true);
  });

  test("列出图片与视频，并标出失效素材与汇总计数", async () => {
    mocks.listMediaAssets.mockResolvedValue([image, video, gone]);
    render(<MediaManagerPanel active />);

    const list = await screen.findByTestId("media-asset-list");
    expect(within(list).getByText("山景.png")).toBeTruthy();
    expect(within(list).getByText("夜.mp4")).toBeTruthy();
    expect(within(list).getByText("失效")).toBeTruthy();
    expect(screen.getByText("共 3 个素材 · 图片 2 · 视频 1")).toBeTruthy();
    // 图片行取到 URL 后渲染缩略图，视频行只给占位，不预取解码。
    await waitFor(() => {
      expect(mocks.getMediaAssetUrl).toHaveBeenCalledWith("m_img");
    });
    expect(mocks.getMediaAssetUrl).not.toHaveBeenCalledWith("m_vid");
  });

  test("批量导入后汇报成功、重复与失败文件名", async () => {
    mocks.importMediaAssets.mockResolvedValue({
      added: [image],
      skipped: 2,
      failed: [{ name: "clip.mkv", reason: "不支持的素材扩展名: .mkv" }],
    });
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "导入素材…" }));

    expect(
      await screen.findByText(/已导入 1 个素材（重复 2 个，失败 1 个）。/),
    ).toBeTruthy();
    expect(screen.getByText(/失败文件：clip\.mkv/)).toBeTruthy();
  });

  test("导入失败时给出原因且不清空列表", async () => {
    mocks.importMediaAssets.mockRejectedValue(
      new Error("只有设置窗口可以导入"),
    );
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "导入素材…" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("导入素材失败：只有设置窗口可以导入");
    await findInList("山景.png");
  });

  test("非桌面环境导入返回 null 时不显示成功提示", async () => {
    mocks.importMediaAssets.mockResolvedValue(null);
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "导入素材…" }));

    await waitFor(() => expect(mocks.importMediaAssets).toHaveBeenCalled());
    expect(screen.queryByText(/已导入/)).toBeNull();
  });

  test("重命名提交去掉首尾空白", async () => {
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByLabelText("重命名素材 山景.png");
    fireEvent.change(input, { target: { value: "  北山  " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mocks.renameMediaAsset).toHaveBeenCalledWith("m_img", "北山");
    });
  });

  test("空名称不提交，Esc 取消编辑", async () => {
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByLabelText("重命名素材 山景.png");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mocks.renameMediaAsset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const again = screen.getByLabelText("重命名素材 山景.png");
    fireEvent.change(again, { target: { value: "改了一半" } });
    fireEvent.keyDown(again, { key: "Escape" });

    expect(screen.queryByLabelText("重命名素材 山景.png")).toBeNull();
    expect(mocks.renameMediaAsset).not.toHaveBeenCalled();
  });

  test("清理失效素材按实际数量汇报", async () => {
    mocks.listMediaAssets.mockResolvedValue([image, gone]);
    mocks.pruneMediaAssets.mockResolvedValue(1);
    render(<MediaManagerPanel active />);
    await findInList("旧图.png");

    fireEvent.click(screen.getByRole("button", { name: "清理失效素材" }));

    expect(await screen.findByText("已清理 1 个失效素材。")).toBeTruthy();
    expect(mocks.pruneMediaAssets).toHaveBeenCalledTimes(1);
  });

  test("设为壁纸走 activateMediaAsset，失效素材禁用该操作", async () => {
    render(<MediaManagerPanel active />);
    await findInList("山景.png");

    fireEvent.click(screen.getByRole("button", { name: "设为壁纸" }));
    await waitFor(() => {
      expect(mocks.activateMediaAsset).toHaveBeenCalledWith("m_img");
    });

    mocks.listMediaAssets.mockResolvedValue([gone]);
    fireEvent.click(
      within(screen.getByTestId("media-asset-list")).getAllByRole("button", {
        name: "移除",
      })[0],
    );
    await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "设为壁纸",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
  });

  test("视频只在被选中后才挂载播放器", async () => {
    const { container } = render(<MediaManagerPanel active />);
    await findInList("夜.mp4");
    expect(container.querySelector("video")).toBeNull();

    fireEvent.click(
      within(screen.getByTestId("media-asset-list")).getByText("夜.mp4"),
    );

    await waitFor(() => {
      expect(container.querySelector("video")).not.toBeNull();
    });
    expect(mocks.getMediaAssetUrl).toHaveBeenCalledWith("m_vid");
  });
});
