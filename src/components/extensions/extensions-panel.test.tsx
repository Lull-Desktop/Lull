import { invoke } from "@tauri-apps/api/core";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ExtensionInfo,
  ExtensionPreview,
  SlotInfo,
} from "@/lib/extensions";
import { ExtensionsPanel } from "./extensions-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const widget: ExtensionInfo = {
  kind: "widget",
  id: "community-pomodoro",
  name: "番茄钟",
  version: "1.2.0",
  description: "专注计时",
  author: "Lull",
  license: "MIT",
  status: "ready",
  verified: "computed",
  signature: {
    status: "verified",
    decision: "allow",
    keyId: "279aff591d2627ed",
    keyLabel: "Lull Community",
  },
  dev: false,
  enabled: false,
  running: false,
  visible: false,
  capabilities: ["widget.state", "widget.audio"],
  granted: [],
  network: [],
  window: { width: 560, height: 680, chrome: "custom" },
  lifecycle: "background",
};

const scene: ExtensionInfo = {
  kind: "scene",
  id: "community.mist",
  name: "雾岚",
  version: "1.0.0",
  license: "CC-BY-4.0",
  status: "ready",
  verified: "declared",
  signature: {
    status: "unsigned",
    decision: "warn",
    reason: "signature-file-missing",
  },
  dev: false,
  capabilities: ["wallpaper.viewport"],
  entryUrl: "/content/scenes/mist/index.html",
};

const game: ExtensionInfo = {
  kind: "game",
  id: "community.living-world",
  name: "Living World",
  version: "1.2.0",
  description: "一盆会自己生长的植物",
  status: "ready",
  verified: "declared",
  signature: {
    status: "unsigned",
    decision: "allow",
    reason: "official-bundle",
  },
  dev: false,
  origin: "user",
  enabled: true,
  running: false,
  capabilities: ["game.state.read", "game.state.write"],
  granted: ["game.state.read", "game.state.write"],
};

const officialScene: ExtensionInfo = {
  kind: "scene",
  id: "lull.bamboo",
  name: "竹影",
  version: "1.2.0",
  license: "GPL-3.0-or-later",
  status: "ready",
  verified: "declared",
  signature: {
    status: "unsigned",
    decision: "warn",
    reason: "official-bundle",
  },
  dev: false,
  origin: "bundled",
  capabilities: ["wallpaper.viewport", "wallpaper.script"],
  entryUrl: "http://lullcontent.localhost/lull.bamboo/scenes/bamboo/index.html",
};

const preview: ExtensionPreview = {
  kind: "widget",
  id: "community-pomodoro",
  name: "雾岚番茄钟",
  version: "1.0.0",
  author: "Lull Community",
  license: "MIT",
  capabilities: ["widget.state", "widget.theme"],
  network: [],
  fileCount: 3,
  bytes: 12_345,
  sourceDigest: "a".repeat(64),
  packageDigest: "c".repeat(64),
  signature: {
    status: "verified",
    decision: "allow",
    keyId: "279aff591d2627ed",
    keyLabel: "Lull Community",
  },
  warnings: [],
};

const scenePreview: ExtensionPreview = {
  kind: "scene",
  id: "community.mist",
  name: "雾岚",
  version: "1.1.0",
  license: "CC-BY-4.0",
  capabilities: ["wallpaper.viewport"],
  network: [],
  fileCount: 2,
  bytes: 2_048,
  sourceDigest: "b".repeat(64),
  packageDigest: "d".repeat(64),
  signature: {
    status: "verified",
    decision: "allow",
    keyId: "279aff591d2627ed",
    keyLabel: "Lull Community",
  },
  warnings: [],
};

function mockCommands(
  overrides: Record<string, (args?: unknown) => unknown> = {},
): void {
  const handlers: Record<string, (args?: unknown) => unknown> = {
    extensions_list: () => [widget, scene],
    extensions_slots: () => [],
    extensions_set_enabled: (args) => ({
      ...widget,
      enabled: (args as { enabled: boolean }).enabled,
    }),
    extensions_install: () => widget,
    extensions_remove: () => undefined,
    extensions_pick: () => null,
    ...overrides,
  };
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) =>
    Promise.resolve(handlers[cmd]?.(args))) as typeof invoke);
}

afterEach(() => {
  vi.clearAllMocks();
});

test("lists tools and wallpapers with counts and filter chips", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  expect(await screen.findByText("番茄钟")).toBeDefined();
  expect(screen.getByText("雾岚")).toBeDefined();
  expect(
    screen.getByText("已安装 2 个（工具 1 / 壁纸 1 / 游戏 0）"),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "工具" })).toBeDefined();
  expect(screen.getByRole("button", { name: "壁纸" })).toBeDefined();
  expect(screen.getByRole("button", { name: "游戏" })).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "壁纸" }));
  expect(screen.queryByText("番茄钟")).toBeNull();
  expect(screen.getByText("雾岚")).toBeDefined();
});

test("games have their own category filter and badge", async () => {
  mockCommands({ extensions_list: () => [widget, scene, game] });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  expect(
    await screen.findByText("已安装 3 个（工具 1 / 壁纸 1 / 游戏 1）"),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "游戏" }));
  expect(screen.queryByText("番茄钟")).toBeNull();
  expect(screen.queryByText("雾岚")).toBeNull();
  const name = screen.getByText("Living World");
  expect(name).toBeDefined();
  const card = name.closest("article");
  expect(card).not.toBeNull();
  if (!card) return;
  expect(within(card).getByText("游戏")).toBeDefined();
  expect(within(card).getByText("已启用")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "壁纸" }));
  expect(screen.queryByText("Living World")).toBeNull();
  expect(screen.getByText("雾岚")).toBeDefined();
});

test("category filter shows an empty state when nothing matches", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "游戏" }));
  expect(await screen.findByTestId("extensions-filter-empty")).toBeDefined();
  expect(screen.queryByText("番茄钟")).toBeNull();
  expect(screen.queryByText("雾岚")).toBeNull();
});

test("扩展条目用紧凑两行合并说明、作者与许可", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const name = await screen.findByText("番茄钟");
  const card = name.closest("article");
  expect(card).not.toBeNull();
  if (!card) return;

  expect(card.className).toContain("py-2");
  const summary = within(card).getByText("专注计时 · 作者 Lull · MIT");
  expect(summary.getAttribute("title")).toBe("专注计时 · 作者 Lull · MIT");
  expect(summary.className).toContain("truncate");
});

test("签名策略并入扩展卡片并可切换", async () => {
  mockCommands({
    content_trust_policy_get: () => ({ requireSignature: false }),
    content_trust_policy_set: (args) => ({
      requireSignature: (args as { requireSignature: boolean })
        .requireSignature,
    }),
  });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const card = await screen.findByTestId("settings-extensions-card");
  expect(within(card).getByTestId("settings-trust-policy")).toBeDefined();
  const toggle = within(card).getByRole("switch", {
    name: "仅允许已验签的扩展",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(toggle);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("content_trust_policy_set", {
      requireSignature: true,
    });
  });
  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

test("列表在卡片内部滚动，开发模式固定在滚动区之外", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const card = await screen.findByTestId("settings-extensions-card");
  const list = within(card).getByTestId("extensions-list-scroll");
  const devMode = within(card).getByTestId("extensions-dev-mode");

  expect(list.className).toContain("overflow-y-auto");
  expect(list.contains(devMode)).toBe(false);
  expect(
    list.compareDocumentPosition(devMode) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("enable asks for permission confirmation before invoking", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "启用：番茄钟" }));
  expect(await screen.findByText("启用 番茄钟")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "确认启用" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_set_enabled", {
      id: "community-pomodoro",
      enabled: true,
    });
  });
});

test("install previews the package and submits the source digest", async () => {
  mockCommands({
    extensions_pick: () => ({ path: "C:\\tmp\\demo.zip", preview }),
  });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "从文件安装" }));
  expect(await screen.findByText("确认安装 雾岚番茄钟")).toBeDefined();
  expect(screen.getByText("a".repeat(64))).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_install", {
      path: "C:\\tmp\\demo.zip",
      sourceDigest: preview.sourceDigest,
    });
  });
});

test("scene update preview shows installed version and updates", async () => {
  mockCommands({
    extensions_pick: () => ({
      path: "C:\\tmp\\mist-1.1.0.zip",
      preview: scenePreview,
    }),
  });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "从文件安装" }));
  expect(await screen.findByText("确认更新 雾岚")).toBeDefined();
  expect(screen.getByText(/已安装 1\.0\.0/)).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_install", {
      path: "C:\\tmp\\mist-1.1.0.zip",
      sourceDigest: scenePreview.sourceDigest,
    });
  });
});

test("uninstall requires a second click", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const remove = await screen.findByRole("button", { name: "卸载：番茄钟" });
  fireEvent.click(remove);
  expect(invoke).not.toHaveBeenCalledWith(
    "extensions_remove",
    expect.anything(),
  );
  fireEvent.click(remove);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_remove", {
      kind: "widget",
      id: "community-pomodoro",
    });
  });
});

test("dev mode toggles through the dedicated command", async () => {
  mockCommands({
    extensions_dev_state: () => ({ devMode: true, packages: [] }),
    extensions_dev_set_enabled: () => ({ devMode: false, packages: [] }),
  });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const toggle = await screen.findByRole("switch", { name: "开发模式" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_dev_set_enabled", {
      enabled: false,
    });
  });
});

test("scene action hands off to the asset library", async () => {
  const onOpenWallpaperSettings = vi.fn();
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={onOpenWallpaperSettings} />);

  fireEvent.click(await screen.findByRole("button", { name: "素材管理" }));
  expect(onOpenWallpaperSettings).toHaveBeenCalledTimes(1);
});

test("详情抽屉的能力授权列表为紧凑单行", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "详情：番茄钟" }));
  const list = await screen.findByTestId("extension-capability-list");
  const row = within(list).getByText("widget.state").closest("li");
  expect(row).not.toBeNull();
  expect(row?.className).toContain("py-1.5");
  // 单行结构：能力名称、级别与 capability id 同行，不再上下堆叠。
  expect(row?.querySelector("p")).toBeNull();
});

test("provider 未选中时使用 Slot 命令而不是直接打开", async () => {
  const provider: ExtensionInfo = {
    ...widget,
    id: "music-vinyl",
    name: "Vinyl Player",
    enabled: true,
    provides: [{ slot: "music-player", version: 1 }],
    capabilities: ["widget.media", "media.player.read", "media.player.control"],
    granted: ["widget.media", "media.player.read", "media.player.control"],
  };
  const slot: SlotInfo = {
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
      {
        id: "music-vinyl",
        name: "Vinyl Player",
        version: "1.0.0",
        origin: "user",
        enabled: true,
        eligible: true,
        selected: false,
        active: false,
      },
    ],
  };
  mockCommands({
    extensions_list: () => [provider],
    extensions_slots: () => [slot],
    extensions_slot_use: () => ({ ...slot, selected: provider.id }),
  });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const card = (await screen.findByText("Vinyl Player")).closest("article");
  expect(card).not.toBeNull();
  if (!card) return;
  fireEvent.click(
    within(card).getByRole("button", { name: "使用：Vinyl Player" }),
  );
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_use", {
      slot: "music-player",
      id: "music-vinyl",
    });
  });
  expect(invoke).not.toHaveBeenCalledWith("extensions_open", {
    kind: "widget",
    id: "music-vinyl",
  });
});

test("官方场景显示官方徽章，不显示未验签与卸载", async () => {
  mockCommands({ extensions_list: () => [officialScene] });
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const name = await screen.findByText("竹影");
  const card = name.closest("article");
  expect(card).not.toBeNull();
  if (!card) return;
  expect(within(card).getByText("官方")).toBeDefined();
  expect(within(card).queryByText("未验签")).toBeNull();
  expect(within(card).queryByRole("button", { name: /卸载：竹影/ })).toBeNull();
  expect(within(card).getByRole("button", { name: "素材管理" })).toBeDefined();
});
