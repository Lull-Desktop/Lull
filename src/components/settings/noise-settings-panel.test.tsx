import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LullMediaClient } from "@lull/media-sdk";
import { NoiseSettingsPanel } from "./noise-settings-panel";

const mocks = vi.hoisted(() => ({
  listPresets: vi.fn(),
  loadPreset: vi.fn(),
  getCurrent: vi.fn(),
}));

const presets = [
  {
    id: "p_fav",
    name: "雨天",
    favorite: true,
    sourceType: "user",
    trackCount: 2,
  },
  {
    id: "p_plain",
    name: "篝火",
    favorite: false,
    sourceType: "builtin",
    trackCount: 1,
  },
];

function client(): LullMediaClient {
  return {
    events: { on: vi.fn(() => () => {}) },
    noise: {
      presets: {
        listPresets: mocks.listPresets,
        loadPreset: mocks.loadPreset,
      },
      session: { getCurrent: mocks.getCurrent },
      tracks: {
        remove: vi.fn(async () => {}),
        setVolume: vi.fn(async () => {}),
        setEnabled: vi.fn(async () => {}),
        setLoop: vi.fn(async () => {}),
        reorder: vi.fn(async () => {}),
      },
    },
  } as unknown as LullMediaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPresets.mockResolvedValue({
    items: presets,
    total: presets.length,
    page: 1,
    pageSize: 200,
    hasMore: false,
  });
  mocks.getCurrent.mockResolvedValue({ tracks: [] });
  mocks.loadPreset.mockResolvedValue({
    preset: { id: "p_fav", name: "雨天" },
    missing: [],
  });
});

describe("NoiseSettingsPanel", () => {
  test("client 为 null 时渲染空态且不调用预设接口", async () => {
    render(<NoiseSettingsPanel client={null} />);

    expect(screen.getByTestId("noise-settings-panel")).toBeDefined();
    expect(screen.queryByTestId("noise-session-tracks")).toBeDefined();
    expect(mocks.listPresets).not.toHaveBeenCalled();
  });

  test("默认选中第一个预设，应用即整体替换音轨并给出成功提示", async () => {
    render(<NoiseSettingsPanel client={client()} />);

    await waitFor(() => expect(mocks.listPresets).toHaveBeenCalled());

    const apply = screen.getByRole("button", { name: "应用" });
    expect(apply.getAttribute("disabled")).toBeNull();

    fireEvent.click(apply);

    await waitFor(() => expect(mocks.loadPreset).toHaveBeenCalledWith("p_fav"));
    expect(await screen.findByText("已应用预设「雨天」")).toBeDefined();
  });

  test("loadPreset 报错时展示失败原因", async () => {
    mocks.loadPreset.mockRejectedValue(new Error("boom"));
    render(<NoiseSettingsPanel client={client()} />);

    await waitFor(() => expect(mocks.listPresets).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "应用预设失败：boom",
    );
  });
});
