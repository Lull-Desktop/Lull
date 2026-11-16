// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 白噪音库窗口：三个子页签与“窗口级单次连接”的所有权。
 */
import type {
  LullMediaClient,
  NoisePresetDetail,
  PlaybackSnapshot,
} from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { NoiseLibraryWindow } from "./noise-library-window";

const mediaState = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@/hooks/use-media-client", () => ({
  getMediaClient: () => mediaState.client,
}));

const snapshot: PlaybackSnapshot = {
  protocol: 1,
  revision: 1,
  player: {
    status: "idle",
    positionMs: 0,
    volume: 1,
    muted: false,
    mode: "sequence",
    revision: 1,
  },
  queue: { trackIds: [], revision: 1 },
  output: { volume: 0.8, muted: false },
  noise: {
    sessionId: "noise-session",
    active: false,
    master: 0.75,
    muted: false,
    layers: [],
    sleep: { timerMinutes: 0 },
    revision: 1,
  },
  noiseSession: {
    id: "noise-session",
    state: "idle",
    masterVolume: 0.75,
    muted: false,
    tracks: [],
    sleep: { timerMinutes: 0 },
    revision: 1,
    createdAt: 1,
  },
};

function createClient(
  connectResult: Promise<PlaybackSnapshot> = Promise.resolve(snapshot),
): LullMediaClient {
  const client = {
    connect: vi.fn(() => connectResult),
    disconnect: vi.fn(async () => {}),
    events: { on: vi.fn(() => () => {}) },
    noise: {
      library: {
        listAssets: vi.fn(async () => ({
          items: [],
          total: 0,
          page: 1,
          pageSize: 30,
          hasMore: false,
        })),
        getCategories: vi.fn(async () => []),
        getTags: vi.fn(async () => []),
      },
      presets: {
        listPresets: vi.fn(async () => ({
          items: [],
          total: 0,
          page: 1,
          pageSize: 50,
          hasMore: false,
        })),
      },
      session: { getCurrent: vi.fn(async () => snapshot.noiseSession) },
      getState: vi.fn(async () => snapshot.noise),
      getSounds: vi.fn(async () => []),
      tracks: {
        add: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        setVolume: vi.fn(async () => {}),
        setEnabled: vi.fn(async () => {}),
        setLoop: vi.fn(async () => {}),
        reorder: vi.fn(async () => {}),
      },
    },
    system: { getOutput: vi.fn(async () => snapshot.output) },
  };
  return client as unknown as LullMediaClient;
}

beforeEach(() => {
  mediaState.client = createClient();
});

test("白噪音库三个子页签可切换", async () => {
  render(<NoiseLibraryWindow />);

  expect(screen.getByRole("heading", { name: "音境管理" })).toBeDefined();
  const tabs = screen
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(tabs).toEqual(
    expect.arrayContaining(["音境素材库", "分类与标签", "音境测试"]),
  );
  expect(tabs).not.toContain("音境预设");

  expect((await screen.findAllByText("音境素材库")).length).toBeGreaterThan(0);
  // 预设管理并入素材库页签，不再有独立页签。
  expect(await screen.findByText("预设管理")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "音境测试" }));
  expect(await screen.findByText("音境 API 调试")).toBeDefined();
});

test("窗口根节点只 connect 一次，切页签不会断开，卸载时才断开", async () => {
  const client = createClient();
  mediaState.client = client;
  const { unmount } = render(<NoiseLibraryWindow />);

  await waitFor(() => {
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
  expect(client.connect).toHaveBeenCalledWith(
    expect.objectContaining({ levels: true }),
  );
  const topics = (client.connect as ReturnType<typeof vi.fn>).mock
    .calls[0]?.[0] as { topics: string[] };
  expect(topics.topics).toContain("noise.session.changed");
  expect(topics.topics).toContain("noise.level");
  expect(topics.topics).toContain("output.changed");

  fireEvent.click(screen.getByRole("button", { name: "分类与标签" }));
  fireEvent.click(screen.getByRole("button", { name: "音境测试" }));
  fireEvent.click(screen.getByRole("button", { name: "音境素材库" }));

  expect(client.connect).toHaveBeenCalledTimes(1);
  expect(client.disconnect).not.toHaveBeenCalled();

  unmount();
  await waitFor(() => {
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});

test("连接失败时显示窗口级错误横幅", async () => {
  mediaState.client = createClient(
    Promise.reject(new Error("media_connect denied")),
  );
  render(<NoiseLibraryWindow />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("音境服务连接失败");
  expect(alert.textContent).toContain("media_connect denied");
});

test("preset copying, save isolation and tab changes respect the preset draft", async () => {
  const client = createClient();
  const builtin: NoisePresetDetail = {
    preset: {
      id: "builtin",
      name: "Builtin rain",
      sourceType: "builtin",
      trackCount: 0,
      schemaVersion: 2,
      masterVolume: 0.5,
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
    },
    tracks: [],
  };
  const copy: NoisePresetDetail = {
    ...builtin,
    preset: {
      ...builtin.preset,
      id: "copy",
      name: "Builtin rain（副本）",
      sourceType: "user",
      updatedAt: 2,
    },
  };
  client.noise.presets.listPresets = vi.fn(async () => ({
    items: [builtin.preset],
    total: 1,
    page: 1,
    pageSize: 50,
    hasMore: false,
  }));
  client.noise.presets.getPreset = vi.fn(async () => builtin);
  client.noise.presets.duplicatePreset = vi.fn(async () => copy);
  client.noise.presets.updatePreset = vi.fn(async (_id, patch) => ({
    ...copy,
    preset: { ...copy.preset, name: patch.name!, updatedAt: 3 },
  }));
  client.noise.presets.loadPreset = vi.fn();
  mediaState.client = client;
  render(<NoiseLibraryWindow />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Builtin rain.*内置/ }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "创建可编辑副本" }),
  );
  await screen.findByRole("heading", {
    name: "预设编辑：Builtin rain（副本）",
  });
  expect(client.noise.presets.duplicatePreset).toHaveBeenCalledWith("builtin", {
    name: "Builtin rain（副本）",
  });
  await waitFor(() =>
    expect((screen.getByLabelText("名称") as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "Edited copy" },
  });
  expect(screen.getByText("有未保存的修改")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "分类与标签" }));
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "Edited copy",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存预设" }));
  await screen.findByText("预设已保存；加载到当前混音后生效。");
  expect(client.noise.presets.updatePreset).toHaveBeenCalledWith("copy", {
    name: "Edited copy",
    description: null,
    expectedUpdatedAt: 2,
  });
  expect(client.noise.presets.loadPreset).not.toHaveBeenCalled();
  expect(client.noise.session.getCurrent).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "Discarded" },
  });
  fireEvent.click(screen.getByRole("button", { name: "分类与标签" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "放弃修改并继续" }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("noise-preset-editor")).toBeNull(),
  );
  expect(client.connect).toHaveBeenCalledTimes(1);
});
