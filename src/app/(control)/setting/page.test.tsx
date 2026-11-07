/**
 * 设置页交互测试：七页签信息架构、窗口开关、功能槽位与主题偏好。
 *
 * 三个库窗口的开关分别落在壁纸 / 音乐 / 白噪音页签；音乐播放器与白噪音两个
 * 功能槽位也在这两个页签里。壁纸页签内部的交互测试在
 * app/(control)/setting/wallpaper-tab.test.tsx，壁纸素材库窗口本身在
 * components/library/wallpaper-library-window.test.tsx。
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
import type { SlotInfo } from "@/lib/extensions";
import { FLOW_THEME_STORAGE_KEY } from "@/lib/flow-theme";
import { m } from "@/paraglide/messages";
import Page from "./page";

afterEach(() => {
  window.localStorage.clear();
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

/** 音乐页签固定用的音乐播放器 Slot。 */
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

/** 白噪音页签固定用的白噪音 Slot。 */
const NOISE_SLOT: SlotInfo = {
  id: "noise-controller",
  name: "白噪音",
  description: "选择白噪音界面",
  category: "audio",
  status: "stopped",
  selected: "noise",
  defaultProvider: "noise",
  providers: [
    {
      id: "noise",
      name: "白噪音",
      version: "1.1.0",
      origin: "bundled",
      enabled: true,
      eligible: true,
      selected: true,
      active: false,
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

/**
 * 设置页在应用里始终挂在 WindowShell 的 ThemeProvider 下（黑白样式要用它），
 * 单独渲染页面时补齐同一层上下文。
 */
function renderSettingsPage() {
  return render(
    <ThemeProvider>
      <Page />
    </ThemeProvider>,
  );
}

test("Page renders in browser mode (no tauri)", () => {
  renderSettingsPage();
  expect(screen.getByRole("main")).toBeDefined();
});

test("设置页签按 偏好 / 壁纸 / 音乐 / 白噪音 / 游戏 / 扩展 / 关于 排列，壁纸与噪音内容不再内嵌", () => {
  renderSettingsPage();

  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "偏好",
    "壁纸",
    "音乐",
    "白噪音",
    "游戏",
    "扩展",
    "关于",
  ]);
  expect(
    screen.getByRole("tab", { name: "偏好" }).getAttribute("aria-selected"),
  ).toBe("true");
  // 壁纸面板首次进入才挂载（懒挂载后常驻），关于也不在默认偏好页签里。
  expect(screen.queryByTestId("settings-wallpaper-pane")).toBeNull();
  expect(screen.queryByText("关于 Lull")).toBeNull();
});

test("音乐页承载曲库分类，白噪音页承载会话控制、预设与音轨", () => {
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "音乐" }));

  const music = screen.getByTestId("settings-music-pane");
  expect(
    within(music).getByText("曲库浏览、收藏、队列与歌单都在这里管理。"),
  ).toBeDefined();
  expect(within(music).getByRole("heading", { name: "音乐" })).toBeDefined();
  // 卡片里只有该库窗口那一行开关。
  expect(
    within(music).getAllByRole("button", { name: /库窗口$/ }),
  ).toHaveLength(1);
  // 音乐库窗口的六个页签在这里变成二级分类标签。
  for (const label of [
    "全部歌曲",
    "我的收藏",
    "队列",
    "歌单",
    "最近添加",
    "最近播放",
  ]) {
    expect(within(music).getByRole("button", { name: label })).toBeDefined();
  }
  // 内容区是唯一滚动条：父级链带 min-h-0，卡片不会被内容撑高。
  expect(screen.getByTestId("music-browser-content").className).toContain(
    "overflow-y-auto",
  );

  fireEvent.click(screen.getByRole("tab", { name: "白噪音" }));

  const noise = screen.getByTestId("settings-noise-pane");
  expect(
    within(noise).getByText(
      "调节主音量、静音与睡眠定时，选择预设并应用到当前混音；素材导入与预设管理在白噪音库中完成。",
    ),
  ).toBeDefined();
  expect(within(noise).queryByText("功能开发中，后续版本补充。")).toBeNull();
  // 会话控制 + 预设下拉 + 当前混音音轨都在这里；保存/导出只留在白噪音库窗口。
  expect(within(noise).getByTestId("noise-settings-panel")).toBeDefined();
  const sessionControls = within(noise).getByTestId("noise-session-controls");
  expect(
    within(sessionControls).getByRole("slider", { name: "主音量" }),
  ).toBeDefined();
  expect(
    within(sessionControls).getByRole("switch", { name: "静音" }),
  ).toBeDefined();
  expect(
    within(sessionControls).getByRole("combobox", { name: "睡眠定时（分钟）" }),
  ).toBeDefined();
  const noisePreset = within(noise).getByRole("combobox", {
    name: "白噪音预设",
  });
  // 主音量 / 静音 / 睡眠定时整体位于「白噪音预设」之上。
  expect(
    sessionControls.compareDocumentPosition(noisePreset) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(noise).getByRole("button", { name: "应用" })).toBeDefined();
  expect(within(noise).getByTestId("noise-session-tracks")).toBeDefined();
  expect(
    within(noise).getAllByRole("button", { name: /库窗口$/ }),
  ).toHaveLength(1);
  expect(
    screen.getByTestId("settings-preferences-pane").getAttribute("aria-hidden"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));
  const wallpaper = screen.getByTestId("settings-wallpaper-pane");
  expect(within(wallpaper).getByTestId("wallpaper-panel")).toBeDefined();
  expect(
    within(wallpaper).queryByText("功能开发中，后续版本补充。"),
  ).toBeNull();
  expect(
    screen.getByTestId("settings-preferences-pane").getAttribute("aria-hidden"),
  ).toBe("true");
  // 白噪音页首次进入后常驻（切走只隐藏，保留预设选择与音轨状态）。
  expect(
    screen.getByTestId("settings-noise-pane").getAttribute("aria-hidden"),
  ).toBe("true");
});

test("关于页签展示版本与扩展模型", () => {
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "关于" }));

  // 与其它页签同一套面板：absolute inset-0 的 settings-about-pane。
  const pane = screen.getByTestId("settings-about-pane");
  expect(
    within(pane).getByRole("heading", { name: "关于 Lull" }),
  ).toBeDefined();
  expect(within(pane).getByText(/版本 .*GPL-3.0-or-later/)).toBeDefined();
  expect(within(pane).getByText(/扩展模型/)).toBeDefined();
  expect(screen.queryByTestId("settings-preferences-card")).toBeNull();
});

test("窗口全局开关读取并保存 taskbarAndMinimize", async () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    window_prefs_set: (args) => ({
      taskbarAndMinimize: (args as { taskbarAndMinimize: boolean })
        .taskbarAndMinimize,
    }),
  });
  renderSettingsPage();

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

test("三个库窗口开关分别位于壁纸 / 音乐 / 白噪音页签，并能打开对应窗口", async () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [
      { kind: "library", visible: false },
      { kind: "backdrop", visible: false },
      { kind: "noise-library", visible: false },
    ],
    widget_open: () => null,
    widget_close: () => null,
    extensions_list: () => [],
    extensions_slots: () => [],
  });
  renderSettingsPage();

  // 库窗口入口已迁出偏好页：默认页签里三个按钮都不在。
  for (const name of ["壁纸素材库窗口", "音乐库窗口", "白噪音库窗口"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }

  const cases = [
    { label: "壁纸", testId: "settings-wallpaper-pane", kind: "backdrop" },
    { label: "音乐", testId: "settings-music-pane", kind: "library" },
    { label: "白噪音", testId: "settings-noise-pane", kind: "noise-library" },
  ] as const;

  for (const item of cases) {
    fireEvent.click(screen.getByRole("tab", { name: item.label }));

    const pane = screen.getByTestId(item.testId);
    const toggles = within(pane).getAllByRole("button", {
      name: /库窗口$/,
    });
    expect(toggles).toHaveLength(1);

    const toggle = toggles[0] as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("打开");

    // 行在面板（或占位卡片）下方。
    const heading = within(pane).getByRole("heading", { name: item.label });
    expect(
      heading.compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // widget_states 读回来后按钮才可点。
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("widget_open", { kind: item.kind });
    });
  }
});

test("库窗口已显示时按钮显示「关闭」，点击后关闭窗口", async () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [{ kind: "backdrop", visible: true }],
    widget_open: () => null,
    widget_close: () => null,
    extensions_list: () => [],
    extensions_slots: () => [],
  });
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "壁纸" }));

  const pane = screen.getByTestId("settings-wallpaper-pane");
  const toggle = within(pane).getByRole("button", {
    name: "壁纸素材库窗口",
  }) as HTMLButtonElement;

  await waitFor(() => {
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
  expect(toggle.textContent).toBe("关闭");

  fireEvent.click(toggle);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("widget_close", { kind: "backdrop" });
  });
});

test("偏好页合并为一张卡片，功能槽位位于窗口分区内", () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [],
    extensions_list: () => [],
    extensions_slots: () => [],
  });
  renderSettingsPage();

  const card = screen.getByTestId("settings-preferences-card");
  for (const title of ["语言", "主题流光", "窗口"]) {
    expect(within(card).getByRole("heading", { name: title })).toBeDefined();
  }
  // 关于已拆成独立页签，不再在偏好卡片底部重复。
  expect(within(card).queryByText("关于 Lull")).toBeNull();
  // 库窗口开关与组件管理都已迁到各自页签，偏好卡片里不再有它们。
  const windowSection = within(card).getByTestId("settings-window-section");
  expect(
    within(windowSection).queryByTestId("settings-feature-slots"),
  ).toBeNull();
  expect(within(card).queryByRole("button", { name: /库窗口$/ })).toBeNull();
  expect(within(card).queryByTestId("slot-panel")).toBeNull();
});

test("音乐 / 白噪音页签各自只显示对应的功能槽位", async () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [],
    extensions_list: () => [],
    extensions_slots: () => [MUSIC_SLOT, NOISE_SLOT],
    extensions_slot_activate: (args) =>
      (args as { slot: string }).slot === "music-player"
        ? MUSIC_SLOT
        : NOISE_SLOT,
  });
  renderSettingsPage();

  // 音乐页签：只有音乐播放器槽位，且位于「组件管理」区块内。
  fireEvent.click(screen.getByRole("tab", { name: "音乐" }));

  const musicPane = screen.getByTestId("settings-music-pane");
  const musicPanel = await within(musicPane).findByTestId("slot-panel");
  expect(within(musicPanel).getByText("音乐播放器")).toBeDefined();
  expect(within(musicPanel).getByText("运行中")).toBeDefined();
  expect(within(musicPanel).getByText("播放器 1.1.0")).toBeDefined();
  expect(within(musicPanel).queryByTestId("slot-noise-controller")).toBeNull();

  const musicSlots = within(musicPane).getByTestId("settings-feature-slots");
  expect(musicSlots.contains(musicPanel)).toBe(true);
  // 标题（含说明）在组件管理之前，曲库分类列表在「音乐库」开关之后。
  expect(
    within(musicPane)
      .getByText("曲库浏览、收藏、队列与歌单都在这里管理。")
      .compareDocumentPosition(musicSlots) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(musicPane)
      .getByRole("button", { name: "音乐库窗口" })
      .compareDocumentPosition(screen.getByTestId("music-browser-categories")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(within(musicPanel).getByRole("button", { name: "打开" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_activate", {
      slot: "music-player",
    });
  });

  // 白噪音页签：只有白噪音槽位。
  fireEvent.click(screen.getByRole("tab", { name: "白噪音" }));

  const noisePane = screen.getByTestId("settings-noise-pane");
  const noisePanel = await within(noisePane).findByTestId("slot-panel");
  expect(within(noisePanel).getByText("白噪音")).toBeDefined();
  expect(within(noisePanel).queryByTestId("slot-music-player")).toBeNull();

  fireEvent.click(within(noisePanel).getByRole("button", { name: "打开" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_activate", {
      slot: "noise-controller",
    });
  });
});

test("扩展页不再重复渲染功能槽位面板", async () => {
  mockInvoke({
    extensions_list: () => [],
    extensions_slots: () => [MUSIC_SLOT],
    extensions_dev_state: () => ({ devMode: false, packages: [] }),
  });
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "音乐" }));
  expect(
    await within(screen.getByTestId("settings-music-pane")).findByTestId(
      "slot-panel",
    ),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));

  expect(await screen.findByText(/已安装 0 个/)).toBeDefined();
  // 扩展面板里不能再出现功能槽位。
  const extensionsPane = screen.getByTestId("settings-extensions-pane");
  expect(within(extensionsPane).queryByTestId("slot-panel")).toBeNull();
});

test("扩展页合并为单卡片，并保留偏好卡片作为高度基准", async () => {
  mockInvoke({
    extensions_list: () => [],
    extensions_slots: () => [],
    extensions_dev_state: () => ({ devMode: false, packages: [] }),
    content_trust_policy_get: () => ({ requireSignature: false }),
  });
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));

  const card = await screen.findByTestId("settings-extensions-card");
  expect(card.className).toContain("h-full");
  expect(within(card).getByTestId("settings-trust-policy")).toBeDefined();
  expect(
    within(card).getByRole("switch", { name: "仅允许已验签的扩展" }),
  ).toBeDefined();

  // 偏好卡片继续挂载并参与布局，但隐藏且不可交互。
  const preferencesPane = screen.getByTestId("settings-preferences-pane");
  expect(preferencesPane.getAttribute("aria-hidden")).toBe("true");
  expect(
    within(preferencesPane).getByTestId("settings-preferences-card"),
  ).toBeDefined();

  const extensionsPane = screen.getByTestId("settings-extensions-pane");
  expect(extensionsPane.contains(card)).toBe(true);
});

test("扩展页的「素材管理」打开壁纸素材库窗口", async () => {
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
    widget_open: () => null,
  });
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));
  fireEvent.click(await screen.findByRole("button", { name: "素材管理" }));

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("widget_open", { kind: "backdrop" });
  });
});

test("主题流光卡片切换全局主题并立即写入存储", () => {
  renderSettingsPage();

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

test("主题流光分区可切换黑白样式并写入 ui-theme", async () => {
  renderSettingsPage();

  const section = screen.getByTestId("settings-theme-section");
  expect(
    within(section).getByText(m.settings_theme_mode_title()),
  ).toBeDefined();
  const mode = within(section).getByTestId("settings-theme-mode");
  const light = within(mode).getByRole("radio", { name: "浅色模式" });
  const dark = within(mode).getByRole("radio", { name: "深色模式" });

  expect(light.getAttribute("aria-checked")).toBe("true");
  expect(dark.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(dark);

  await waitFor(() => {
    expect(dark.getAttribute("aria-checked")).toBe("true");
  });
  expect(light.getAttribute("aria-checked")).toBe("false");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.classList.contains("light")).toBe(false);
  expect(window.localStorage.getItem("ui-theme")).toBe("dark");

  fireEvent.click(light);

  await waitFor(() => {
    expect(light.getAttribute("aria-checked")).toBe("true");
  });
  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(window.localStorage.getItem("ui-theme")).toBe("light");
});

test("其他窗口的存储事件会同步主题流光", async () => {
  renderSettingsPage();

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
