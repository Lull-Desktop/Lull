/**
 * 壁纸库窗口交互测试：显示器排序、开关、显示模式、场景与事件刷新。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { m } from "@/paraglide/messages";
import type { SceneCatalogEntry } from "@/sdk/scene";
import { WallpaperLibraryWindow } from "./wallpaper-library-window";

afterEach(() => {
  window.localStorage.clear();
  mediaApi.listMediaAssets.mockClear();
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));

// 只替换素材列表查询，其余媒体封装保持真实实现（浏览器下自然降级为空）。
const mediaApi = vi.hoisted(() => ({
  listMediaAssets: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/core/media/media-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/core/media/media-api")>();
  return { ...actual, listMediaAssets: mediaApi.listMediaAssets };
});

// 壁纸面板的场景目录由这里固定为「官方竹影 + 内置媒体」；目录合并本身由
// use-scene-catalog 的单元测试覆盖，这里只关心控件契约。
const sceneCatalog = vi.hoisted(() => ({
  entries: [
    {
      manifest: {
        schemaVersion: 1,
        type: "scene",
        id: "lull.bamboo",
        name: "竹影",
        version: "1.2.0",
        description: "深夜竹林、薄雾与远山。",
        author: "Lull",
        license: "GPL-3.0-or-later",
        capabilities: [
          "wallpaper.viewport",
          "wallpaper.canvas",
          "wallpaper.sync",
          "wallpaper.params",
          "wallpaper.script",
        ],
        entry: "scenes/bamboo/index.html",
        params: [
          {
            key: "mist",
            type: "number",
            label: "薄雾浓度",
            default: 0.5,
            min: 0,
            max: 1,
            step: 0.05,
          },
        ],
        compatibility: { hostApi: 1, platforms: ["windows"] },
      },
      source: "official",
      entryUrl:
        "http://lullcontent.localhost/lull.bamboo/scenes/bamboo/index.html",
      component: null,
    },
    {
      manifest: {
        schemaVersion: 1,
        type: "scene",
        id: "lull.video",
        name: "媒体",
        version: "1.0.0",
        description: "本地图片或视频壁纸。",
        author: "Lull",
        license: "GPL-3.0-or-later",
        capabilities: [
          "wallpaper.viewport",
          "wallpaper.canvas",
          "wallpaper.sync",
        ],
        compatibility: { hostApi: 1, platforms: ["windows"] },
      },
      source: "builtin",
      entryUrl: null,
      component: null,
    },
  ] as SceneCatalogEntry[],
}));

vi.mock("@/hooks/use-scene-catalog", () => ({
  useSceneCatalog: () => ({
    entries: sceneCatalog.entries,
    loading: false,
    error: null,
    issues: [],
  }),
}));

// 注意：listen 不用 vi.fn 包装——vitest 会给 vi.fn 返回的 promise 挂 then 做
// settledResults 记账，rejection 永远到不了 unhandledRejection，测试就观测不到
// "页面没处理 rejection" 这件事。用可替换的真实函数。
const listenState = vi.hoisted(() => ({
  impl: ((): Promise<() => void> => Promise.resolve(() => {})) as (
    event: string,
    handler: () => void,
  ) => Promise<() => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) =>
    listenState.impl(event, handler),
}));

type MonitorRow = {
  device: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dpi: number;
  primary: boolean;
  enabled: boolean;
  scene: string;
};

// 真实双屏形状：DISPLAY2（2560x1440，副屏，在左）排在 DISPLAY1（1920x1080，主屏）前。
const MONITORS: MonitorRow[] = [
  {
    device: "\\\\.\\DISPLAY2",
    index: 1,
    x: -2560,
    y: 0,
    w: 2560,
    h: 1440,
    dpi: 120,
    primary: false,
    enabled: false,
    scene: "lull.bamboo",
  },
  {
    device: "\\\\.\\DISPLAY1",
    index: 0,
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
    dpi: 96,
    primary: true,
    enabled: true,
    scene: "lull.bamboo",
  },
];

function mockInvoke(
  handlers: Record<string, (args?: unknown) => unknown>,
): void {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
    const handler = handlers[cmd];
    if (!handler) {
      return Promise.reject(new Error(`unmocked command: ${cmd}`));
    }
    return Promise.resolve(handler(args));
  }) as typeof invoke);
}

function mockWallpaper(monitors: MonitorRow[], masterVisible: boolean): void {
  mockInvoke({
    wallpaper_get_visible: () => masterVisible,
    wallpaper_monitors: () => monitors,
    wallpaper_display_get: () => ({
      mode: "mirror",
      sync: true,
      scene: "lull.bamboo",
    }),
    wallpaper_set_monitor_visible: () => undefined,
    wallpaper_set_visible: () => masterVisible,
    wallpaper_set_display: () => undefined,
    wallpaper_set_monitor_scene: () => undefined,
    wallpaper_set_scene_params: () => undefined,
  });
}

function mockWallpaperWithDisplay(display: {
  mode: string;
  sync: boolean;
  scene: string;
}): void {
  mockInvoke({
    wallpaper_get_visible: () => true,
    wallpaper_monitors: () => MONITORS,
    wallpaper_display_get: () => display,
    wallpaper_set_monitor_visible: () => undefined,
    wallpaper_set_visible: () => true,
    wallpaper_set_display: () => undefined,
    wallpaper_set_monitor_scene: () => undefined,
    wallpaper_set_scene_params: () => undefined,
  });
}

function renderWallpaperLibrary() {
  return render(<WallpaperLibraryWindow />);
}

test("壁纸库窗口沿用音乐库的标题布局与双页签", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();

  expect(screen.getByRole("heading", { name: "壁纸库" })).toBeDefined();
  expect(screen.getByRole("button", { name: "壁纸层" })).toBeDefined();
  expect(screen.getByRole("button", { name: "素材管理" })).toBeDefined();
  // 「壁纸层」既是页签按钮也是卡片标题，按容器界定后者。
  expect(
    within(screen.getByTestId("wallpaper-layer-pane")).getByText("壁纸层"),
  ).toBeDefined();
});

test("素材页签首次进入才读取素材，来回切换不重复请求", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();

  expect(mediaApi.listMediaAssets).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "素材管理" }));
  await waitFor(() =>
    expect(mediaApi.listMediaAssets).toHaveBeenCalledTimes(1),
  );
  // 壁纸层被 aria-hidden，角色查询查不到里面的控件。
  expect(screen.queryByRole("switch", { name: "显示壁纸" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "壁纸层" }));
  fireEvent.click(screen.getByRole("button", { name: "素材管理" }));
  await waitFor(() =>
    expect(mediaApi.listMediaAssets).toHaveBeenCalledTimes(1),
  );
});

test("切页签不会重新拉取壁纸配置", async () => {
  const monitors = vi.fn(() => MONITORS);
  mockInvoke({
    wallpaper_get_visible: () => true,
    wallpaper_monitors: monitors,
    wallpaper_display_get: () => ({
      mode: "mirror",
      sync: true,
      scene: "lull.bamboo",
    }),
    wallpaper_set_monitor_visible: () => undefined,
    wallpaper_set_visible: () => true,
    wallpaper_set_display: () => undefined,
    wallpaper_set_monitor_scene: () => undefined,
    wallpaper_set_scene_params: () => undefined,
  });
  renderWallpaperLibrary();

  await waitFor(() => expect(monitors).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "素材管理" }));
  fireEvent.click(screen.getByRole("button", { name: "壁纸层" }));
  expect(monitors).toHaveBeenCalledTimes(1);
});

test("moving a ranged scene param slider persists via wallpaper_set_scene_params", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();

  const slider = await screen.findByRole("slider", { name: "薄雾浓度" });
  fireEvent.keyDown(slider, { key: "End" });
  fireEvent.keyUp(slider, { key: "End" });

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_scene_params", {
      scene: "lull.bamboo",
      params: { mist: "1.00" },
    });
  });
});

test("renders monitors sorted by geometry, primary badge, per-monitor switches", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();

  await waitFor(() => {
    expect(screen.getByText("显示器 1")).toBeDefined();
  });
  // 按几何排序：x=-2560（DISPLAY2，副屏）在最左 → 显示器 1；主屏 DISPLAY1 → 显示器 2。
  expect(screen.getByText("显示器 2")).toBeDefined();
  expect(screen.getByText("主屏")).toBeDefined();
  expect(screen.getByText("2560×1440")).toBeDefined();
  expect(screen.getByText("1920×1080")).toBeDefined();

  const monitorsSwitches = [1, 2].map(
    (n) =>
      screen.getByRole("switch", { name: `显示器 ${n}` }) as HTMLButtonElement,
  );
  expect(monitorsSwitches.map((s) => s.getAttribute("aria-checked"))).toEqual([
    "false", // DISPLAY2 配置为关闭
    "true", // DISPLAY1 开启
  ]);
});

test("toggling a monitor switch invokes wallpaper_set_monitor_visible with device", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();

  await waitFor(() => {
    expect(screen.getByText("显示器 2")).toBeDefined();
  });
  fireEvent.click(screen.getByRole("switch", { name: "显示器 2" }));

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_monitor_visible", {
      device: "\\\\.\\DISPLAY1",
      visible: false,
    });
  });
});

test("monitor switches are disabled while master switch is off", async () => {
  mockWallpaper(MONITORS, false);
  renderWallpaperLibrary();

  await waitFor(() => {
    expect(screen.getByText("显示器 1")).toBeDefined();
  });
  const master = screen.getByRole("switch", {
    name: "显示壁纸",
  }) as HTMLButtonElement;
  expect(master.getAttribute("aria-checked")).toBe("false");
  expect(master.disabled).toBe(false);

  const monitor2 = screen.getByRole("switch", { name: "显示器 2" });
  expect((monitor2 as HTMLButtonElement).disabled).toBe(true);
});

test("wallpaper-changed event refreshes the monitor list", async () => {
  const handlers: Array<() => void> = [];
  listenState.impl = (_event, handler) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  };

  mockWallpaper(MONITORS, true);
  renderWallpaperLibrary();
  await waitFor(() => {
    expect(screen.getByText("显示器 1")).toBeDefined();
  });
  expect(
    (
      screen.getByRole("switch", { name: "显示器 1" }) as HTMLButtonElement
    ).getAttribute("aria-checked"),
  ).toBe("false");

  // 模拟后端拓扑变化后广播：DISPLAY2 变为开启。
  mockWallpaper(
    MONITORS.map((m) => ({ ...m, enabled: true })),
    true,
  );
  for (const h of handlers) {
    h();
  }

  await waitFor(() => {
    expect(
      (
        screen.getByRole("switch", { name: "显示器 1" }) as HTMLButtonElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

test("listen 被拒（权限缺失）时不产生未处理 rejection，页面降级为手动刷新", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    listenState.impl = () =>
      Promise.reject(new Error("event.listen not allowed"));
    mockWallpaper(MONITORS, true);
    renderWallpaperLibrary();
    await waitFor(() => {
      expect(screen.getByText("显示器 1")).toBeDefined();
    });
    // 等 rejection 微任务跑完，给 unhandledRejection 触发机会。
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("renders display mode selector reflecting config", async () => {
  mockWallpaperWithDisplay({ mode: "span", sync: true, scene: "lull.bamboo" });
  renderWallpaperLibrary();
  await waitFor(() => expect(screen.getByText("显示模式")).toBeDefined());
  const span = screen.getByRole("radio", { name: "跨屏" });
  expect(span.getAttribute("aria-checked")).toBe("true");
});

test("switching mode invokes wallpaper_set_display", async () => {
  mockWallpaperWithDisplay({
    mode: "mirror",
    sync: true,
    scene: "lull.bamboo",
  });
  renderWallpaperLibrary();
  await waitFor(() => expect(screen.getByText("显示模式")).toBeDefined());
  fireEvent.click(screen.getByRole("radio", { name: "跨屏" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_display", {
      mode: "span",
    });
  });
});

test("sync switch availability matrix", async () => {
  mockWallpaperWithDisplay({
    mode: "mirror",
    sync: false,
    scene: "lull.bamboo",
  });
  const { unmount } = renderWallpaperLibrary();
  await waitFor(() => expect(screen.getByText("动画同步")).toBeDefined());
  expect(
    (screen.getByRole("switch", { name: "动画同步" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  unmount();

  mockWallpaperWithDisplay({ mode: "span", sync: false, scene: "lull.bamboo" });
  renderWallpaperLibrary();
  await waitFor(() =>
    expect(screen.getByText("跨屏强制同步（防接缝撕裂）")).toBeDefined(),
  );
  const s = screen.getByRole("switch", {
    name: "动画同步",
  }) as HTMLButtonElement;
  expect(s.disabled).toBe(true);
  expect(s.getAttribute("aria-checked")).toBe("true");
});

test("global scene dropdown shows current value and invokes on select", async () => {
  mockWallpaperWithDisplay({
    mode: "mirror",
    sync: true,
    scene: "lull.bamboo",
  });
  renderWallpaperLibrary();
  const trigger = await screen.findByRole("combobox", {
    name: m.wallpaper_scene_global(),
  });
  expect(trigger.textContent).toContain("竹影");
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: "媒体" });
  fireEvent.keyDown(option, { key: "ArrowDown" });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_display", {
      scene: "lull.video",
    });
  });
});

test("缺失的全局场景回退到默认竹影并写回宿主", async () => {
  mockWallpaperWithDisplay({ mode: "mirror", sync: true, scene: "" });
  renderWallpaperLibrary();

  const trigger = await screen.findByRole("combobox", {
    name: m.wallpaper_scene_global(),
  });
  expect(trigger.textContent).toContain("竹影");
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_display", {
      scene: "lull.bamboo",
    });
  });
});

test("independent shows per-row scene dropdowns; selecting invokes command", async () => {
  mockWallpaperWithDisplay({
    mode: "independent",
    sync: true,
    scene: "lull.bamboo",
  });
  renderWallpaperLibrary();
  const trigger = await screen.findByRole("combobox", {
    name: "显示器 2 场景",
  });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: "媒体" });
  fireEvent.keyDown(option, { key: "ArrowDown" });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_monitor_scene", {
      device: "\\\\.\\DISPLAY1",
      scene: "lull.video",
    });
  });
});

test("global scene group hidden in independent mode", async () => {
  mockWallpaperWithDisplay({
    mode: "independent",
    sync: true,
    scene: "lull.bamboo",
  });
  renderWallpaperLibrary();
  await waitFor(() => expect(screen.getByText("显示模式")).toBeDefined());
  expect(screen.queryByText(m.wallpaper_scene_global())).toBeNull();
});
