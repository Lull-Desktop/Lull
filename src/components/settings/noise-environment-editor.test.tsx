import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LullMediaClient, NoiseTrack } from "@lull/media-sdk";
import { describe, expect, test, vi } from "vitest";
import { NoiseEnvironmentEditor } from "./noise-environment-editor";

describe("environment track editor", () => {
  test("creates an ordered multi-asset curve for the selected track", async () => {
    const configureEnvironment = vi.fn().mockResolvedValue(undefined);
    const client = { noise: { tracks: { configureEnvironment }, library: {
      listAssets: vi.fn().mockResolvedValue({ items: [{ id: "light", name: "细雨" }, { id: "storm", name: "暴雨" }], hasMore: false }),
    } } } as unknown as LullMediaClient;
    const track = { id: "track", assetId: "light", name: "雨" } as NoiseTrack;
    render(<NoiseEnvironmentEditor client={client} track={track} />);
    fireEvent.click(screen.getByRole("button", { name: "配置环境强度" }));
    await screen.findAllByRole("option", { name: "暴雨" });
    fireEvent.change(screen.getByLabelText("第 2 个强度素材"), { target: { value: "storm" } });
    fireEvent.click(screen.getByRole("button", { name: "保存环境配置" }));
    await waitFor(() => expect(configureEnvironment).toHaveBeenCalledWith("track", {
      type: "rain", intensity: 0.5,
      anchors: [{ assetId: "light", intensity: 0 }, { assetId: "storm", intensity: 1 }],
    }));
  });
});
