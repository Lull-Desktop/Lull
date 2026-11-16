import type {
  LullMediaClient,
  NoiseAsset,
  NoiseSession,
  NoiseTrack,
} from "@lull/media-sdk";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { NoiseEnvironmentEditor } from "./noise-environment-editor";

function asset(id: string, name = id): NoiseAsset {
  return { id, name, status: "available" } as NoiseAsset;
}
function track(environment = true): NoiseTrack {
  return {
    id: "track",
    assetId: "light",
    name: "雨",
    volume: 0.7,
    enabled: true,
    loop: true,
    state: "paused",
    order: 0,
    positionMs: 0,
    ...(environment
      ? {
          environment: {
            type: "rain",
            intensity: 0.4,
            anchors: [
              {
                assetId: "light",
                intensity: 0,
                assetHash: "hash-light",
                expectedName: "细雨",
              },
              { assetId: "storm", intensity: 1 },
            ],
          },
        }
      : {}),
  };
}
function setup(initial = track()) {
  let current = initial;
  const assets = [
    asset("light", "细雨"),
    asset("storm", "暴雨"),
    asset("medium", "中雨"),
  ];
  const events = new Set<
    (event: { topic: string; payload?: unknown }) => void
  >();
  const snapshot = (): NoiseSession => ({
    id: "session",
    state: "paused",
    masterVolume: 0.75,
    muted: true,
    tracks: [current],
    sleep: { timerMinutes: 0 },
    revision: 1,
    createdAt: 0,
  });
  const configureEnvironment = vi.fn(async (_id, environment) => {
    current = { ...current, environment };
  });
  const setIntensity = vi.fn(async (_id, intensity) => {
    current = {
      ...current,
      environment: { ...current.environment!, intensity },
    };
  });
  const getCurrent = vi.fn(async () => snapshot());
  const getAsset = vi.fn(
    async (id: string) => assets.find((a) => a.id === id)!,
  );
  const listAssets = vi.fn(async () => ({
    items: assets,
    hasMore: false,
    page: 1,
    pageSize: 50,
    total: 3,
  }));
  const setVolume = vi.fn();
  const play = vi.fn();
  const setMuted = vi.fn();
  const setEnabled = vi.fn();
  const client = {
    events: {
      on: (listener: typeof events extends Set<infer T> ? T : never) => {
        events.add(listener);
        return () => events.delete(listener);
      },
    },
    noise: {
      tracks: { configureEnvironment, setIntensity, setVolume, setEnabled },
      session: { getCurrent, play, setMuted },
      library: { listAssets, getAsset, getCategories: vi.fn(async () => []) },
    },
  } as unknown as LullMediaClient;
  return {
    client,
    configureEnvironment,
    setIntensity,
    getCurrent,
    getAsset,
    listAssets,
    setVolume,
    play,
    setMuted,
    setEnabled,
    setCurrent: (next: NoiseTrack) => {
      current = next;
    },
    emitLibrary: () =>
      events.forEach((listener) =>
        listener({ topic: "noise.library.changed" }),
      ),
  };
}
function open(existing = true) {
  fireEvent.click(
    screen.getByRole("button", {
      name: existing ? "编辑环境配置" : "配置环境强度",
    }),
  );
}
function changePercent(index: number, value: string) {
  fireEvent.change(screen.getByLabelText(`档位 ${index} 强度 %`), {
    target: { value },
  });
}
const applyButton = () =>
  screen.getByRole("button", { name: "应用到当前音轨" }) as HTMLButtonElement;
async function choose(index: number, name: string) {
  fireEvent.click(screen.getByRole("button", { name: `档位 ${index} 素材` }));
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("环境素材编辑", () => {
  test("新轨配置必须选齐不同的可用素材，保存使用最新强度且不控制播放", async () => {
    const h = setup(track(false));
    render(<NoiseEnvironmentEditor client={h.client} track={track(false)} />);
    open(false);
    expect(applyButton().disabled).toBe(true);
    await choose(2, "暴雨");
    changePercent(2, "90");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await screen.findByText(/已应用到当前音轨/);
    expect(h.configureEnvironment).toHaveBeenCalledWith("track", {
      type: "rain",
      intensity: 0.5,
      anchors: [
        { assetId: "light", intensity: 0 },
        { assetId: "storm", intensity: 0.9 },
      ],
    });
    expect(h.play).not.toHaveBeenCalled();
    expect(h.setVolume).not.toHaveBeenCalled();
  });
  test("修改百分比保留素材元数据，替换素材清除旧引用信息", async () => {
    const h = setup();
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    changePercent(1, "10");
    h.setCurrent({
      ...track(),
      environment: { ...track().environment!, intensity: 0.85 },
    });
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(h.configureEnvironment).toHaveBeenCalled());
    expect(h.configureEnvironment.mock.calls[0][1]).toMatchObject({
      intensity: 0.85,
      anchors: [
        {
          assetId: "light",
          intensity: 0.1,
          assetHash: "hash-light",
          expectedName: "细雨",
        },
        { assetId: "storm", intensity: 1 },
      ],
    });
  });
  test("更换素材不会继承旧素材哈希", async () => {
    const h = setup();
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    await choose(1, "中雨");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(h.configureEnvironment).toHaveBeenCalled());
    expect(h.configureEnvironment.mock.calls[0][1].anchors[0]).toEqual({
      assetId: "medium",
      intensity: 0,
    });
  });
  test("空值、重复强度、乱序及重复素材在调用后端前阻止保存", async () => {
    const h = setup();
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    changePercent(2, "");
    expect(screen.getByText(/请输入 0～100/)).toBeDefined();
    expect(applyButton().disabled).toBe(true);
    changePercent(2, "0");
    expect(screen.getByText(/强度必须严格递增/)).toBeDefined();
    changePercent(1, "80");
    changePercent(2, "20");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "按强度排序" }));
    expect(
      (screen.getByLabelText("档位 1 强度 %") as HTMLInputElement).value,
    ).toBe("20");
    await choose(2, "暴雨");
    expect(screen.getAllByText(/每个档位必须使用不同素材/)).toHaveLength(2);
    expect(h.configureEnvironment).not.toHaveBeenCalled();
  });
  test("收起保留草稿，取消恢复服务端曲线，新增档位插在最大间隔", async () => {
    const h = setup();
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "添加素材档位" }));
    expect(
      (screen.getByLabelText("档位 2 强度 %") as HTMLInputElement).value,
    ).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "收起环境配置" }));
    open();
    expect(screen.getByLabelText("档位 3 强度 %")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
    expect(screen.queryByLabelText("档位 3 强度 %")).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });
  test("外部强度变化不影响草稿，外部曲线变化要求重新载入", async () => {
    const h = setup();
    const view = render(
      <NoiseEnvironmentEditor client={h.client} track={track()} />,
    );
    open();
    changePercent(2, "90");
    const updated = {
      ...track(),
      environment: { ...track().environment!, intensity: 0.8 },
    };
    view.rerender(<NoiseEnvironmentEditor client={h.client} track={updated} />);
    expect(screen.queryByText(/环境配置已在其他位置修改/)).toBeNull();
    const changed = {
      ...updated,
      environment: { ...updated.environment, type: "wind" },
    };
    view.rerender(<NoiseEnvironmentEditor client={h.client} track={changed} />);
    await screen.findByText(/环境配置已在其他位置修改/);
    expect(applyButton().disabled).toBe(true);
    expect(
      (screen.getByLabelText("档位 2 强度 %") as HTMLInputElement).value,
    ).toBe("90");
    fireEvent.click(screen.getByRole("button", { name: "重新载入最新配置" }));
    expect(
      (screen.getByLabelText("档位 2 强度 %") as HTMLInputElement).value,
    ).toBe("100");
  });
  test("保存前再次检查外部曲线更新，不盲目覆盖", async () => {
    const h = setup();
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    changePercent(2, "90");
    h.setCurrent({
      ...track(),
      environment: { ...track().environment!, type: "wind" },
    });
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await screen.findByText(/环境配置已在其他位置修改/);
    expect(h.configureEnvironment).not.toHaveBeenCalled();
  });
  test("保存失败保留草稿；素材加载失败与真实缺失区分并可重试", async () => {
    const h = setup();
    h.getAsset.mockRejectedValueOnce(new Error("network"));
    render(<NoiseEnvironmentEditor client={h.client} track={track()} />);
    open();
    changePercent(2, "90");
    await screen.findByText(/加载失败，请重试/);
    expect(screen.queryByText("素材缺失或不可用")).toBeNull();
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    h.configureEnvironment.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(applyButton());
    await screen.findByText(/配置未应用：save failed/);
    expect(
      (screen.getByLabelText("档位 2 强度 %") as HTMLInputElement).value,
    ).toBe("90");
    h.getAsset.mockResolvedValue({ ...asset("missing"), status: "missing" });
    act(() => h.emitLibrary());
    await screen.findAllByText("素材缺失或不可用");
    expect(applyButton().disabled).toBe(true);
  });
  test("自定义类型保留，当前强度输入只调用强度 API", async () => {
    const custom = {
      ...track(),
      environment: { ...track().environment!, type: "insects" },
    };
    const h = setup(custom);
    const onSession = vi.fn();
    render(
      <NoiseEnvironmentEditor
        client={h.client}
        track={custom}
        onSession={onSession}
      />,
    );
    open();
    expect(
      screen.getByRole("combobox", { name: "环境类型" }).textContent,
    ).toContain("insects");
    const input = screen.getByLabelText("当前环境强度 %");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(h.setIntensity).toHaveBeenCalledWith("track", 0),
    );
    expect(h.setVolume).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    expect(h.setMuted).not.toHaveBeenCalled();
    expect(h.configureEnvironment).not.toHaveBeenCalled();
  });
  test("保存成功后刷新失败不误报保存失败，重试只刷新会话", async () => {
    const h = setup();
    const onSession = vi.fn();
    render(
      <NoiseEnvironmentEditor
        client={h.client}
        track={track()}
        onSession={onSession}
      />,
    );
    open();
    changePercent(2, "90");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    h.getCurrent
      .mockResolvedValueOnce(await h.getCurrent())
      .mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(applyButton());
    await screen.findByText(/设置已应用，但状态刷新失败/);
    expect(screen.queryByText(/配置未应用/)).toBeNull();
    expect(screen.getByText(/已应用到当前音轨/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() =>
      expect(screen.queryByText(/设置已应用，但状态刷新失败/)).toBeNull(),
    );
    expect(h.configureEnvironment).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledTimes(2);
  });
  test("强度设置成功后刷新失败仍能恢复且不重复设置强度", async () => {
    const h = setup();
    const onSession = vi.fn();
    render(
      <NoiseEnvironmentEditor
        client={h.client}
        track={track()}
        onSession={onSession}
      />,
    );
    open();
    h.getCurrent.mockRejectedValueOnce(new Error("refresh failed"));
    const input = screen.getByLabelText("当前环境强度 %");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);
    await screen.findByText(/设置已应用，但状态刷新失败/);
    expect(screen.queryByText(/当前强度未更新/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(onSession).toHaveBeenCalled());
    expect(h.setIntensity).toHaveBeenCalledTimes(1);
    expect(h.setIntensity).toHaveBeenCalledWith("track", 0.75);
  });
});
