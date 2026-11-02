/**
 * 设置页交互测试：验证显示器排序、开关与显示模式、事件订阅和 Tauri IPC 调用契约。
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
import type { SlotInfo } from "@/lib/extensions";
import { FLOW_THEME_STORAGE_KEY } from "@/lib/flow-theme";
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
// use-scene-catalog 的单元测试覆盖，设置页测试只关心控件契约。
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

/** 偏好页功能槽位卡片固定用的音乐播放器 Slot。 */
const MUSIC_SLOT: SlotInfo = {
  id: "music-player",
  name: "音乐播放器",
  description: "选择音乐播放界面",
  category: "audio",
  status: "active",
  selected: "player",
  active: "player",
  visible: true,
  defaultProvider: "player",
  providers: [
    {
      id: "player",
      name: "播放器",
      version: "1.1.0",
      origin: "bundled",
      enabled: true,
      eligible: true,
      selected: true,
      active: true,
    },
  ],
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
    greet: () => "hi",
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
    greet: () => "hi",
  });
}

/** 渲染设置页并切到「壁纸」页签（壁纸层设置不在默认的「偏好」页签里）。 */
function renderWallpaperTab(): void {
  render(<Page />);
  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));
}

test("moving a ranged scene param slider persists via wallpaper_set_scene_params", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperTab();

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

test("Page renders in browser mode (no tauri)", () => {
  render(<Page />);
  expect(screen.getByRole("main")).toBeDefined();
});

test("设置页签按 偏好 / 壁纸 / 音乐库 / 曲库整理 / 噪音素材库 / 噪音预设 / 媒体测试 / 白噪音测试 / 扩展 排列，壁纸层只在壁纸页签", () => {
  render(<Page />);

  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "偏好",
    "壁纸",
    "音乐库",
    "曲库整理",
    "噪音素材库",
    "噪音预设",
    "媒体测试",
    "白噪音测试",
    "扩展",
  ]);
  expect(
    screen.getByRole("tab", { name: "偏好" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByText("壁纸层")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));
  expect(screen.getByText("壁纸层")).toBeDefined();
  expect(screen.queryByText("主题流光")).toBeNull();
});

test("renders monitors sorted by geometry, primary badge, per-monitor switches", async () => {
  mockWallpaper(MONITORS, true);
  renderWallpaperTab();

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
  renderWallpaperTab();

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
  renderWallpaperTab();

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
  renderWallpaperTab();
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
    renderWallpaperTab();
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
  renderWallpaperTab();
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
  renderWallpaperTab();
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
  const { unmount } = render(<Page />);
  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));
  await waitFor(() => expect(screen.getByText("动画同步")).toBeDefined());
  expect(
    (screen.getByRole("switch", { name: "动画同步" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  unmount();

  mockWallpaperWithDisplay({ mode: "span", sync: false, scene: "lull.bamboo" });
  renderWallpaperTab();
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
  renderWallpaperTab();
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
  renderWallpaperTab();

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
  renderWallpaperTab();
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
  renderWallpaperTab();
  await waitFor(() => expect(screen.getByText("显示模式")).toBeDefined());
  expect(screen.queryByText(m.wallpaper_scene_global())).toBeNull();
});

test("窗口全局开关读取并保存 taskbarAndMinimize", async () => {
  mockInvoke({
    wallpaper_get_visible: () => true,
    wallpaper_monitors: () => MONITORS,
    wallpaper_display_get: () => ({
      mode: "mirror",
      sync: true,
      scene: "lull.bamboo",
    }),
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    window_prefs_set: (args) => ({
      taskbarAndMinimize: (args as { taskbarAndMinimize: boolean })
        .taskbarAndMinimize,
    }),
  });
  render(<Page />);

  const toggle = (await screen.findByRole("switch", {
    name: "显示在任务栏并允许最小化",
  })) as HTMLButtonElement;
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("window_prefs_set", {
      taskbarAndMinimize: false,
    });
  });
  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

test("工具窗开关按当前显示状态渲染，并能打开窗口", async () => {
  mockInvoke({
    wallpaper_get_visible: () => true,
    wallpaper_monitors: () => MONITORS,
    wallpaper_display_get: () => ({
      mode: "mirror",
      sync: true,
      scene: "lull.bamboo",
    }),
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [{ kind: "library", visible: false }],
    widget_open: () => null,
    widget_close: () => null,
  });
  render(<Page />);

  const library = (await screen.findByRole("switch", {
    name: "音乐库窗口",
  })) as HTMLButtonElement;
  expect(library.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(library);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("widget_open", { kind: "library" });
  });
});

test("功能槽位面板迁到偏好页的窗口设置下方，并能打开当前实现", async () => {
  mockInvoke({
    wallpaper_get_visible: () => true,
    wallpaper_monitors: () => MONITORS,
    wallpaper_display_get: () => ({
      mode: "mirror",
      sync: true,
      scene: "lull.bamboo",
    }),
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [],
    extensions_list: () => [],
    extensions_slots: () => [MUSIC_SLOT],
    extensions_slot_activate: () => MUSIC_SLOT,
  });
  render(<Page />);

  const panel = await screen.findByTestId("slot-panel");
  expect(within(panel).getByText("音乐播放器")).toBeDefined();
  expect(within(panel).getByText("运行中")).toBeDefined();
  expect(within(panel).getByText("播放器 1.1.0")).toBeDefined();

  // 功能槽位卡片排在「窗口」之后，保持偏好页的分组顺序。
  const windowTitle = screen.getByText("窗口");
  const slotsCard = screen.getByTestId("settings-feature-slots");
  expect(
    windowTitle.compareDocumentPosition(slotsCard) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(within(panel).getByRole("button", { name: "打开" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_activate", {
      slot: "music-player",
    });
  });
});

test("扩展页不再重复渲染功能槽位面板", async () => {
  mockInvoke({
    extensions_list: () => [],
    extensions_slots: () => [MUSIC_SLOT],
    extensions_dev_state: () => ({ devMode: false, packages: [] }),
  });
  render(<Page />);
  expect(await screen.findByTestId("slot-panel")).toBeDefined();

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));

  expect(await screen.findByText(/已安装 0 个/)).toBeDefined();
  expect(screen.queryByTestId("slot-panel")).toBeNull();
});

test("扩展页的「壁纸设置」切到壁纸页签", async () => {
  mockInvoke({
    extensions_list: () => [
      {
        kind: "scene",
        id: "community.mist",
        name: "雾岚",
        version: "1.0.0",
        status: "ready",
        verified: "declared",
        dev: false,
        capabilities: ["wallpaper.viewport"],
        entryUrl: "/content/scenes/mist/index.html",
      },
    ],
    extensions_dev_state: () => ({ devMode: false, packages: [] }),
  });
  render(<Page />);

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));
  fireEvent.click(await screen.findByRole("button", { name: "壁纸设置" }));

  expect(
    screen.getByRole("tab", { name: "壁纸" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("壁纸层")).toBeDefined();
});

test("主题流光卡片切换全局主题并立即写入存储", () => {
  render(<Page />);

  const jade = screen.getByRole("button", { name: "主题流光：林光" });
  expect(jade.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(jade);

  expect(jade.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("林光", { selector: "strong" })).toBeDefined();
  expect(document.documentElement.dataset.flowTheme).toBe("jade");
  expect(window.localStorage.getItem(FLOW_THEME_STORAGE_KEY)).toBe("jade");

  const aurora = screen.getByRole("button", { name: "主题流光：极光" });
  fireEvent.click(aurora);
  expect(aurora.getAttribute("aria-pressed")).toBe("true");
  expect(jade.getAttribute("aria-pressed")).toBe("false");
  expect(document.documentElement.dataset.flowTheme).toBe("aurora");
});

test("其他窗口的存储事件会同步主题流光", async () => {
  render(<Page />);

  window.localStorage.setItem(FLOW_THEME_STORAGE_KEY, "amber");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: FLOW_THEME_STORAGE_KEY,
      newValue: "amber",
    }),
  );

  expect(document.documentElement.dataset.flowTheme).toBe("amber");
  await waitFor(() => {
    expect(
      screen
        .getByRole("button", { name: "主题流光：暖金" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
