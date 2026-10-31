import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MEDIA_CONFIG } from "@/core/media/types";
import { MediaSurface } from "./media-surface";

const mocks = vi.hoisted(() => ({
  getMediaConfig: vi.fn(),
  openMediaSession: vi.fn(),
  attachMediaSession: vi.fn(),
  detachMediaSession: vi.fn(),
  degradeMediaSession: vi.fn(),
  getWebView2TextureStream: vi.fn(),
}));

vi.mock("@/core/media/media-api", () => ({
  isMediaDesktop: () => true,
  getMediaConfig: mocks.getMediaConfig,
  openMediaSession: mocks.openMediaSession,
  attachMediaSession: mocks.attachMediaSession,
  detachMediaSession: mocks.detachMediaSession,
  degradeMediaSession: mocks.degradeMediaSession,
  getWebView2TextureStream: mocks.getWebView2TextureStream,
}));

vi.mock("@/core/media/media-events", () => ({
  onMediaConfigChanged: () => () => {},
  onMediaDegraded: () => () => {},
  onMediaMasterVisible: () => () => {},
  onMediaResync: () => () => {},
  onMediaStreamStalled: () => () => {},
}));

const asset = {
  id: "m_1",
  name: "night.mp4",
  kind: "video",
  sizeBytes: 1024,
  addedAt: 0,
  available: true,
};

const capabilities = {
  nativeTextureStream: false,
  hardwareDecode: false,
  reason: "native disabled",
  runtimeVersion: null,
  adapterLuid: null,
  htmlFallback: true,
};

function configView(overrides: Record<string, unknown> = {}) {
  return {
    config: { ...DEFAULT_MEDIA_CONFIG, assetId: "m_1" },
    asset,
    assetUrl: "http://asset.localhost/night.mp4",
    capabilities,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  mocks.getMediaConfig.mockResolvedValue(configView());
  mocks.openMediaSession.mockResolvedValue({
    sessionId: "media-1",
    backend: "html-video",
    assetUrl: "http://asset.localhost/night.mp4",
    state: "playing",
    reason: null,
  });
  mocks.attachMediaSession.mockResolvedValue({
    backend: "html-video",
    streamId: "stream-1",
    assetUrl: "http://asset.localhost/night.mp4",
    state: "playing",
    reason: null,
  });
  mocks.detachMediaSession.mockResolvedValue(undefined);
  mocks.degradeMediaSession.mockResolvedValue(null);
  mocks.getWebView2TextureStream.mockResolvedValue(null);
});

describe("MediaSurface", () => {
  test("falls back to the asset URL when the native backend is unavailable", async () => {
    const { unmount } = render(<MediaSurface />);
    await waitFor(() => {
      expect(
        screen.getByTestId("media-surface").getAttribute("data-backend"),
      ).toBe("html-video");
    });
    expect(screen.getByTestId("media-video").getAttribute("src")).toBe(
      "http://asset.localhost/night.mp4",
    );
    unmount();
    expect(mocks.detachMediaSession).toHaveBeenCalledWith(
      "media-1",
      "stream-1",
    );
  });

  test("renders an idle gradient without a selected asset", async () => {
    mocks.getMediaConfig.mockResolvedValue(
      configView({ asset: null, assetUrl: null }),
    );
    render(<MediaSurface />);
    await waitFor(() => {
      expect(
        screen.getByTestId("media-surface").getAttribute("data-backend"),
      ).toBe("idle");
    });
    expect(screen.getByTestId("media-video").getAttribute("src")).toBeNull();
  });

  test("still renders HTML video when session creation fails", async () => {
    mocks.openMediaSession.mockResolvedValue(null);
    render(<MediaSurface />);
    await waitFor(() => {
      expect(screen.getByTestId("media-video").getAttribute("src")).toBe(
        "http://asset.localhost/night.mp4",
      );
    });
  });

  test("releases the video source on pagehide", async () => {
    const { unmount } = render(<MediaSurface />);
    await waitFor(() => {
      expect(screen.getByTestId("media-video").getAttribute("src")).toBe(
        "http://asset.localhost/night.mp4",
      );
    });
    const video = screen.getByTestId("media-video") as HTMLVideoElement;
    window.dispatchEvent(new Event("pagehide"));
    expect(video.getAttribute("src")).toBeNull();
    expect(video.srcObject).toBeNull();
    unmount();
  });

  test("renders images without opening a media session", async () => {
    const image = {
      id: "m_img",
      name: "wall.png",
      kind: "image",
      sizeBytes: 2048,
      addedAt: 0,
      available: true,
    };
    mocks.getMediaConfig.mockResolvedValue({
      config: { ...DEFAULT_MEDIA_CONFIG, assetId: "m_img" },
      asset: image,
      assetUrl: "http://asset.localhost/wall.png",
      capabilities,
    });

    render(<MediaSurface />);
    await waitFor(() => {
      expect(screen.getByTestId("media-image").getAttribute("src")).toBe(
        "http://asset.localhost/wall.png",
      );
    });
    expect(
      screen.getByTestId("media-surface").getAttribute("data-backend"),
    ).toBe("image");
    expect(screen.queryByTestId("media-video")).toBeNull();
    expect(mocks.openMediaSession).not.toHaveBeenCalled();
    expect(mocks.attachMediaSession).not.toHaveBeenCalled();
  });

  test("HTML video aligns to wall-clock phase on metadata when sync is on", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(12_345);
    render(<MediaSurface syncEnabled />);
    await waitFor(() => {
      expect(screen.getByTestId("media-video").getAttribute("src")).toBe(
        "http://asset.localhost/night.mp4",
      );
    });

    const video = screen.getByTestId("media-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      value: 10,
      configurable: true,
    });
    Object.defineProperty(video, "readyState", {
      value: 0,
      configurable: true,
    });
    fireEvent.loadedMetadata(video);

    // 12.345s 在 10s 循环里的相位是 2.345s。
    expect(video.currentTime).toBeCloseTo(2.345, 2);
    now.mockRestore();
  });
});
