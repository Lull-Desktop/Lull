/**
 * N6 回归：加载 Preset 后 Session 是 idle，官方 UI 必须同步显示暂停/待播放，
 * 不能继续显示“正在播放”的泡泡状态。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

const { client } = vi.hoisted(() => {
  const session = {
    id: "session",
    state: "idle",
    masterVolume: 0.75,
    muted: false,
    tracks: [
      {
        id: "track-rain",
        assetId: "noise:builtin:rain",
        name: "雨声",
        state: "stopped",
        volume: 0.7,
        enabled: true,
        loop: true,
        positionMs: 0,
        order: 0,
      },
    ],
    sleep: { timerMinutes: 0 },
    revision: 2,
    createdAt: 1,
  };
  const preset = {
    id: "noise:preset:default",
    name: "默认混音",
    sourceType: "builtin",
    schemaVersion: 1,
    masterVolume: 0.75,
    favorite: false,
    trackCount: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    client: {
      events: { on: () => () => {} },
      connect: async () => ({
        protocol: 1,
        revision: 2,
        noiseSession: session,
        noise: {
          sessionId: "session",
          active: false,
          master: 0.75,
          muted: false,
          layers: [],
          sleep: { timerMinutes: 0 },
          revision: 2,
        },
      }),
      disconnect: async () => {},
      noise: {
        session: {
          getCurrent: async () => session,
          play: async () => session,
          pause: async () => session,
          setMuted: async () => session,
          setMasterVolume: async () => session,
          setSleepTimer: async () => session,
        },
        tracks: {
          add: async () => ({ ...session.tracks[0], id: "track-added" }),
          setVolume: async () => {},
          setEnabled: async () => {},
          remove: async () => {},
        },
        presets: {
          listPresets: async () => ({
            items: [preset],
            total: 1,
            page: 1,
            pageSize: 50,
            hasMore: false,
          }),
          loadPreset: async () => ({
            preset,
            session,
            resolved: ["track-rain"],
            missing: [],
          }),
        },
      },
    },
  };
});

vi.mock("@/hooks/use-media-client", () => ({
  getMediaClient: () => client,
}));

import NoisePage from "./page";

test("加载 Preset 后 UI 显示暂停而不是播放", async () => {
  render(<NoisePage />);

  fireEvent.click(screen.getByRole("button", { name: "泡泡设置" }));
  const load = await screen.findByRole("button", { name: "加载" });
  fireEvent.click(load);

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /白噪音，已暂停/ }),
    ).toBeDefined();
  });
  expect(screen.getAllByText("待播放").length).toBeGreaterThan(0);
});
