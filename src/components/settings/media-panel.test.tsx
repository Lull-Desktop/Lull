import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MEDIA_CONFIG } from "@/core/media/types";
import { MediaPanel } from "./media-panel";

const mocks = vi.hoisted(() => ({
  getMediaConfig: vi.fn(),
  listMediaAssets: vi.fn(),
  getMediaStats: vi.fn(),
  pickMediaAsset: vi.fn(),
  removeMediaAsset: vi.fn(),
  setMediaConfig: vi.fn(),
  activateMediaAsset: vi.fn(),
}));

vi.mock("@/core/media/media-api", () => ({
  getMediaConfig: mocks.getMediaConfig,
  listMediaAssets: mocks.listMediaAssets,
  getMediaStats: mocks.getMediaStats,
  pickMediaAsset: mocks.pickMediaAsset,
  removeMediaAsset: mocks.removeMediaAsset,
  setMediaConfig: mocks.setMediaConfig,
  activateMediaAsset: mocks.activateMediaAsset,
}));

vi.mock("@/core/media/media-events", () => ({
  onMediaConfigChanged: () => () => {},
}));

const asset = {
  id: "m_1",
  name: "night.mp4",
  sizeBytes: 1024,
  addedAt: 0,
  available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMediaConfig.mockResolvedValue({
    config: { ...DEFAULT_MEDIA_CONFIG, assetId: "m_1" },
    asset,
    assetUrl: "http://asset.localhost/night.mp4",
    capabilities: {
      nativeTextureStream: false,
      hardwareDecode: false,
      reason: "native disabled",
      runtimeVersion: null,
      adapterLuid: null,
      htmlFallback: true,
    },
  });
  mocks.listMediaAssets.mockResolvedValue([asset]);
  mocks.getMediaStats.mockResolvedValue(null);
});

describe("MediaPanel", () => {
  test("shows the selected video and fallback backend", async () => {
    render(<MediaPanel />);
    expect(await screen.findByText("视频壁纸")).toBeTruthy();
    expect(screen.getByText("night.mp4")).toBeTruthy();
    expect(screen.getAllByText(/HTML 视频回退/).length).toBeGreaterThan(0);
  });

  test("explains when the wallpaper runtime is not running", async () => {
    mocks.getMediaConfig.mockResolvedValue(null);
    render(<MediaPanel />);
    expect(await screen.findByText(/壁纸运行时未启动/)).toBeTruthy();
  });

  test("shows the attached backend instead of the probe capability", async () => {
    mocks.getMediaConfig.mockResolvedValue({
      config: { ...DEFAULT_MEDIA_CONFIG, assetId: "m_1" },
      asset,
      assetUrl: "http://asset.localhost/night.mp4",
      capabilities: {
        nativeTextureStream: true,
        hardwareDecode: true,
        reason: null,
        runtimeVersion: null,
        adapterLuid: 1,
        htmlFallback: true,
      },
    });
    mocks.getMediaStats.mockResolvedValue({
      sessions: 1,
      nativeSessions: 0,
      fallbackSessions: 1,
      decoderInstances: 0,
      cpuReadbackBytes: 0,
      capabilities: {
        nativeTextureStream: true,
        hardwareDecode: true,
        reason: null,
        runtimeVersion: null,
        adapterLuid: 1,
        htmlFallback: true,
      },
      sessionViews: [
        {
          sessionId: "media-1",
          assetId: "m_1",
          backend: "html-video",
          state: "playing",
          surfaces: [{ backend: "html-video" }],
        },
      ],
    });
    render(<MediaPanel />);
    expect(await screen.findByText("视频壁纸")).toBeTruthy();
    expect(screen.getAllByText(/HTML 视频回退/).length).toBeGreaterThan(0);
    expect(screen.queryByText("原生纹理共享")).toBeNull();
  });
});
