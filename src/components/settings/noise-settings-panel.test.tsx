import type { LullMediaClient } from "@lull/media-sdk";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NoiseSettingsPanel } from "./noise-settings-panel";

const mocks = vi.hoisted(() => ({
  listPresets: vi.fn(),
  loadPreset: vi.fn(),
  getCurrent: vi.fn(),
  setMasterVolume: vi.fn(),
  setMuted: vi.fn(),
  setSleepTimer: vi.fn(),
}));

const session = {
  id: "noise-session",
  state: "idle",
  masterVolume: 0.75,
  muted: false,
  tracks: [],
  sleep: { timerMinutes: 0 },
  revision: 1,
  createdAt: 1,
};

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
      session: {
        getCurrent: mocks.getCurrent,
        setMasterVolume: mocks.setMasterVolume,
        setMuted: mocks.setMuted,
        setSleepTimer: mocks.setSleepTimer,
      },
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
  mocks.getCurrent.mockResolvedValue(session);
  mocks.setMasterVolume.mockResolvedValue(session);
  mocks.setMuted.mockResolvedValue(session);
  mocks.setSleepTimer.mockResolvedValue(session);
  mocks.loadPreset.mockResolvedValue({
    preset: { id: "p_fav", name: "雨天" },
    missing: [],
  });
});

describe("NoiseSettingsPanel", () => {
  test("client 为 null 时渲染空态且不调用预设接口", async () => {
    render(<NoiseSettingsPanel client={null} />);

    expect(screen.getByTestId("noise-settings-panel")).toBeDefined();
    expect(screen.getByTestId("noise-session-controls")).toBeDefined();
    expect(screen.queryByTestId("noise-session-tracks")).toBeDefined();
    expect(mocks.listPresets).not.toHaveBeenCalled();
    expect(mocks.getCurrent).not.toHaveBeenCalled();
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

  test("主音量 / 静音 / 睡眠定时整体位于预设之上", async () => {
    render(<NoiseSettingsPanel client={client()} />);
    await waitFor(() => expect(mocks.getCurrent).toHaveBeenCalled());

    const controls = screen.getByTestId("noise-session-controls");
    expect(
      within(controls).getByRole("slider", { name: "主音量" }),
    ).toBeDefined();
    expect(
      within(controls).getByRole("switch", { name: "静音" }),
    ).toBeDefined();
    expect(
      within(controls).getByRole("combobox", { name: "睡眠定时（分钟）" }),
    ).toBeDefined();

    const preset = screen.getByRole("combobox", { name: "白噪音预设" });
    expect(
      controls.compareDocumentPosition(preset) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("静音开关即时写入 Session muted", async () => {
    render(<NoiseSettingsPanel client={client()} />);
    await waitFor(() => expect(mocks.getCurrent).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("switch", { name: "静音" }));

    await waitFor(() => expect(mocks.setMuted).toHaveBeenCalledWith(true));
  });

  test("睡眠定时先选分钟数，点「应用」才写回", async () => {
    render(<NoiseSettingsPanel client={client()} />);
    await waitFor(() => expect(mocks.getCurrent).toHaveBeenCalled());

    fireEvent.change(
      screen.getByRole("combobox", { name: "睡眠定时（分钟）" }),
      { target: { value: "15" } },
    );
    expect(mocks.setSleepTimer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "应用睡眠定时" }));

    await waitFor(() => expect(mocks.setSleepTimer).toHaveBeenCalledWith(15));
  });

  test("主音量滑杆松手才写回 Session master", async () => {
    render(<NoiseSettingsPanel client={client()} />);
    await waitFor(() => expect(mocks.getCurrent).toHaveBeenCalled());

    const slider = screen.getByRole("slider", { name: "主音量" });
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyUp(slider, { key: "End" });

    await waitFor(() => expect(mocks.setMasterVolume).toHaveBeenCalledWith(1));
  });
});
