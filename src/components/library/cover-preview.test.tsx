import type { LullMediaClient, TrackSummary } from "@lull/media-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CoverPreview } from "./cover-preview";

const track: TrackSummary = {
  id: "trk_1",
  title: "测试曲目",
  artists: ["Lull"],
  source: "local",
  available: true,
  hasCover: true,
};

test("读取封面 URL 并渲染图片", async () => {
  const getCoverUrl = vi.fn().mockResolvedValue("https://example.test/cover.png");
  const client = {
    library: { getCoverUrl },
  } as unknown as LullMediaClient;

  render(<CoverPreview client={client} track={track} />);

  const image = await screen.findByRole("img", { name: "测试曲目 封面" });
  expect(image.getAttribute("src")).toBe("https://example.test/cover.png");
  expect(getCoverUrl).toHaveBeenCalledWith("trk_1");
});

test("没有封面时不调用 getCoverUrl", async () => {
  const getCoverUrl = vi.fn();
  const client = {
    library: { getCoverUrl },
  } as unknown as LullMediaClient;

  render(
    <CoverPreview client={client} track={{ ...track, hasCover: false }} />,
  );

  expect(await screen.findByText("无封面")).toBeDefined();
  await waitFor(() => expect(getCoverUrl).not.toHaveBeenCalled());
});
