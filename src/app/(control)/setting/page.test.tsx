/**
 * 设置页交互测试：七页签信息架构、窗口开关、功能槽位与主题偏好。
 *
 * 壁纸库窗口的交互测试在 components/library/wallpaper-library-window.test.tsx。
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
}));

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
  // 壁纸层/关于都不在默认偏好页签里。
  expect(screen.queryByText("壁纸层")).toBeNull();
  expect(screen.queryByText("关于 Lull")).toBeNull();
});

test("壁纸 / 音乐 / 白噪音三个页签是占位页，且沿用偏好卡片作高度基准", () => {
  renderSettingsPage();

  for (const [label, testId] of [
    ["壁纸", "settings-wallpaper-pane"],
    ["音乐", "settings-music-pane"],
    ["白噪音", "settings-noise-pane"],
  ] as const) {
    fireEvent.click(screen.getByRole("tab", { name: label }));

    const pane = screen.getByTestId(testId);
    expect(within(pane).getByText("功能开发中，后续版本补充。")).toBeDefined();
    // 页签标题同时是占位卡片的小标题。
    expect(within(pane).getByRole("heading", { name: label })).toBeDefined();
    expect(
      screen
        .getByTestId("settings-preferences-pane")
        .getAttribute("aria-hidden"),
    ).toBe("true");
  }
});

test("关于页签展示版本与扩展模型", () => {
  renderSettingsPage();

  fireEvent.click(screen.getByRole("tab", { name: "关于" }));

  expect(screen.getByRole("heading", { name: "关于 Lull" })).toBeDefined();
  expect(screen.getByText(/版本 .*GPL-3.0-or-later/)).toBeDefined();
  expect(screen.getByText(/扩展模型/)).toBeDefined();
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

test("工具窗开关按当前显示状态渲染，并能打开三个库窗口", async () => {
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

  for (const name of ["音乐库窗口", "壁纸库窗口", "白噪音库窗口"]) {
    const toggle = (await screen.findByRole("button", {
      name,
    })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("打开");
  }

  // 三个库窗口按 manifest order 展示：壁纸库 → 音乐库 → 白噪音库。
  expect(
    screen
      .getAllByRole("button", { name: /库窗口$/ })
      .map((toggle) => toggle.getAttribute("aria-label")),
  ).toEqual(["壁纸库窗口", "音乐库窗口", "白噪音库窗口"]);

  fireEvent.click(screen.getByRole("button", { name: "壁纸库窗口" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("widget_open", { kind: "backdrop" });
  });

  fireEvent.click(screen.getByRole("button", { name: "白噪音库窗口" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("widget_open", {
      kind: "noise-library",
    });
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
  // 功能槽位内容并入「窗口」分区，不再有独立卡片。
  const windowSection = within(card).getByTestId("settings-window-section");
  expect(
    within(windowSection).getByTestId("settings-feature-slots"),
  ).toBeDefined();
});

test("功能槽位面板迁到偏好页的窗口设置下方，并能打开当前实现", async () => {
  mockInvoke({
    window_prefs_get: () => ({ taskbarAndMinimize: true }),
    widget_states: () => [],
    extensions_list: () => [],
    extensions_slots: () => [MUSIC_SLOT],
    extensions_slot_activate: () => MUSIC_SLOT,
  });
  renderSettingsPage();

  const panel = await screen.findByTestId("slot-panel");
  expect(within(panel).getByText("音乐播放器")).toBeDefined();
  expect(within(panel).getByText("运行中")).toBeDefined();
  expect(within(panel).getByText("播放器 1.1.0")).toBeDefined();

  // 功能槽位内容位于「窗口」标题下方，与窗口设置同一分区。
  const windowSection = screen.getByTestId("settings-window-section");
  const slotsBlock = within(windowSection).getByTestId(
    "settings-feature-slots",
  );
  expect(slotsBlock.contains(panel)).toBe(true);
  expect(
    screen.getByText("窗口").compareDocumentPosition(slotsBlock) &
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
  renderSettingsPage();
  expect(await screen.findByTestId("slot-panel")).toBeDefined();

  fireEvent.click(screen.getByRole("tab", { name: "扩展" }));

  expect(await screen.findByText(/已安装 0 个/)).toBeDefined();
  // 偏好面板保留为高度基准但已隐藏；可见的扩展面板里不能出现功能槽位。
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

test("扩展页的「壁纸设置」打开壁纸库窗口", async () => {
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
  fireEvent.click(await screen.findByRole("button", { name: "壁纸设置" }));

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
