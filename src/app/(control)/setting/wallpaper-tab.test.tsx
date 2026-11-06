/**
 * 设置页「壁纸」页签：原壁纸库窗口「壁纸层」页签的全部交互。
 *
 * 面板现在挂在 `settings-wallpaper-pane` 里，因此统一用 `within(pane)` 收窄，
 * 避免与音乐 / 白噪音页签的同名控件混在一起。原生窗口侧的用例（标题、无页签）
 * 在 components/library/wallpaper-library-window.test.tsx。
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
import { ThemeProvider } from "@/hooks/use-theme";
import { m } from "@/paraglide/messages";
import type { SceneCatalogEntry } from "@/sdk/scene";
import Page from "./page";

afterEach(() => {
  window.localStorage.clear();
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));

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

/** 设置页挂载即需要的命令；缺哪条 mockInvoke 会直接 reject 暴露出来。 */
const PAGE_COMMANDS = {
  window_prefs_get: () => ({ taskbarAndMinimize: true }),
  widget_states: () => [],
  extensions_list: () => [],
  extensions_slots: () => [],
  games_list: () => [],
  games_config_get: () => ({}),
};

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
    ...PAGE_COMMANDS,
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
    ...PAGE_COMMANDS,
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

function renderSettingsPage() {
  return render(
    <ThemeProvider>
      <Page />
    </ThemeProvider>,
  );
}

/** 打开壁纸页签并等到面板首屏数据落地。 */
async function openWallpaperPane(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));
  const pane = await screen.findByTestId("settings-wallpaper-pane");
  await within(pane).findByText("显示壁纸");
  return pane;
}

test("壁纸页签承载壁纸层设置，素材库窗口开关在面板下方", async () => {
  mockWallpaper(MONITORS, true);
  renderSettingsPage();

  const pane = await openWallpaperPane();

  expect(within(pane).getByRole("heading", { name: "壁纸" })).toBeDefined();
  expect(within(pane).getByTestId("wallpaper-panel")).toBeDefined();
  expect(within(pane).getByRole("switch", { name: "显示壁纸" })).toBeDefined();
  expect(
    within(pane).getByRole("button", { name: "壁纸素材库窗口" }),
  ).toBeDefined();
  // 占位文案不再出现在壁纸页签。
  expect(within(pane).queryByText("功能开发中，后续版本补充。")).toBeNull();
});

test("切页签不重新拉取壁纸配置", async () => {
  const monitors = vi.fn(() => MONITORS);
  mockInvoke({
    ...PAGE_COMMANDS,
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
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await waitFor(() => expect(monitors).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("tab", { name: "音乐" }));
  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));

  expect(within(pane).getByTestId("wallpaper-panel")).toBeDefined();
  expect(monitors).toHaveBeenCalledTimes(1);
});

test("moving a ranged scene param slider persists via wallpaper_set_scene_params", async () => {
  mockWallpaper(MONITORS, true);
  renderSettingsPage();

  const pane = await openWallpaperPane();
  const slider = await within(pane).findByRole("slider", { name: "薄雾浓度" });
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
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示器 1");
  // 按几何排序：x=-2560（DISPLAY2，副屏）在最左 → 显示器 1；主屏 DISPLAY1 → 显示器 2。
  expect(within(pane).getByText("显示器 2")).toBeDefined();
  expect(within(pane).getByText("主屏")).toBeDefined();
  expect(within(pane).getByText("2560×1440")).toBeDefined();
  expect(within(pane).getByText("1920×1080")).toBeDefined();

  const monitorsSwitches = [1, 2].map(
    (n) =>
      within(pane).getByRole("switch", {
        name: `显示器 ${n}`,
      }) as HTMLButtonElement,
  );
  expect(monitorsSwitches.map((s) => s.getAttribute("aria-checked"))).toEqual([
    "false", // DISPLAY2 配置为关闭
    "true", // DISPLAY1 开启
  ]);
});

test("toggling a monitor switch invokes wallpaper_set_monitor_visible with device", async () => {
  mockWallpaper(MONITORS, true);
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示器 2");
  fireEvent.click(within(pane).getByRole("switch", { name: "显示器 2" }));

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("wallpaper_set_monitor_visible", {
      device: "\\\\.\\DISPLAY1",
      visible: false,
    });
  });
});

test("monitor switches are disabled while master switch is off", async () => {
  mockWallpaper(MONITORS, false);
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示器 1");
  const master = within(pane).getByRole("switch", {
    name: "显示壁纸",
  }) as HTMLButtonElement;
  expect(master.getAttribute("aria-checked")).toBe("false");
  expect(master.disabled).toBe(false);

  const monitor2 = within(pane).getByRole("switch", {
    name: "显示器 2",
  }) as HTMLButtonElement;
  expect(monitor2.disabled).toBe(true);
});

test("wallpaper-changed event refreshes the monitor list", async () => {
  const handlers: Array<{ event: string; handler: () => void }> = [];
  listenState.impl = (event, handler) => {
    handlers.push({ event, handler });
    return Promise.resolve(() => {});
  };

  mockWallpaper(MONITORS, true);
  renderSettingsPage();
  const pane = await openWallpaperPane();

  await within(pane).findByText("显示器 1");
  expect(
    (
      within(pane).getByRole("switch", {
        name: "显示器 1",
      }) as HTMLButtonElement
    ).getAttribute("aria-checked"),
  ).toBe("false");

  // 模拟后端拓扑变化后广播：DISPLAY2 变为开启。
  mockWallpaper(
    MONITORS.map((monitor) => ({ ...monitor, enabled: true })),
    true,
  );
  for (const item of handlers) {
    if (item.event === "wallpaper-changed") item.handler();
  }

  await waitFor(() => {
    expect(
      (
        within(pane).getByRole("switch", {
          name: "显示器 1",
        }) as HTMLButtonElement
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
    renderSettingsPage();
    const pane = await openWallpaperPane();
    await within(pane).findByText("显示器 1");
    // 等 rejection 微任务跑完，给 unhandledRejection 触发机会。
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("renders display mode selector reflecting config", async () => {
  mockWallpaperWithDisplay({ mode: "span", sync: true, scene: "lull.bamboo" });
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示模式");
  const span = within(pane).getByRole("radio", { name: "跨屏" });
  expect(span.getAttribute("aria-checked")).toBe("true");
});

test("switching mode invokes wallpaper_set_display", async () => {
  mockWallpaperWithDisplay({
    mode: "mirror",
    sync: true,
    scene: "lull.bamboo",
  });
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示模式");
  fireEvent.click(within(pane).getByRole("radio", { name: "跨屏" }));
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
  const { unmount } = renderSettingsPage();
  const pane = await openWallpaperPane();
  await within(pane).findByText("动画同步");
  expect(
    (
      within(pane).getByRole("switch", {
        name: "动画同步",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  unmount();

  mockWallpaperWithDisplay({ mode: "span", sync: false, scene: "lull.bamboo" });
  renderSettingsPage();
  const spanPane = await openWallpaperPane();
  await within(spanPane).findByText("跨屏强制同步（防接缝撕裂）");
  const sync = within(spanPane).getByRole("switch", {
    name: "动画同步",
  }) as HTMLButtonElement;
  expect(sync.disabled).toBe(true);
  expect(sync.getAttribute("aria-checked")).toBe("true");
});

test("global scene dropdown shows current value and invokes on select", async () => {
  mockWallpaperWithDisplay({
    mode: "mirror",
    sync: true,
    scene: "lull.bamboo",
  });
  renderSettingsPage();

  const pane = await openWallpaperPane();
  const trigger = await within(pane).findByRole("combobox", {
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
  renderSettingsPage();

  const pane = await openWallpaperPane();
  const trigger = await within(pane).findByRole("combobox", {
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
  renderSettingsPage();

  const pane = await openWallpaperPane();
  const trigger = await within(pane).findByRole("combobox", {
    name: "显示器 2 壁纸",
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
  renderSettingsPage();

  const pane = await openWallpaperPane();
  await within(pane).findByText("显示模式");
  expect(within(pane).queryByText(m.wallpaper_scene_global())).toBeNull();
});
