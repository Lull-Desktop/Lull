import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionInfo, ExtensionPreview } from "@/lib/extensions";
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
  dev: false,
  capabilities: ["wallpaper.viewport"],
  entryUrl: "/content/scenes/mist/index.html",
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
  warnings: [],
};

function mockCommands(
  overrides: Record<string, (args?: unknown) => unknown> = {},
): void {
  const handlers: Record<string, (args?: unknown) => unknown> = {
    extensions_list: () => [widget, scene],
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

test("lists both kinds with counts and filter chips", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  expect(await screen.findByText("番茄钟")).toBeDefined();
  expect(screen.getByText("雾岚")).toBeDefined();
  expect(screen.getByText("已安装 2 个（工具 1 / 壁纸 1）")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "壁纸" }));
  expect(screen.queryByText("番茄钟")).toBeNull();
  expect(screen.getByText("雾岚")).toBeDefined();
});

test("enable asks for permission confirmation before invoking", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "启用 番茄钟" }));
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

test("uninstall requires a second click", async () => {
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={vi.fn()} />);

  const remove = await screen.findByRole("button", { name: "卸载 番茄钟" });
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

test("scene action hands off to wallpaper settings", async () => {
  const onOpenWallpaperSettings = vi.fn();
  mockCommands();
  render(<ExtensionsPanel onOpenWallpaperSettings={onOpenWallpaperSettings} />);

  fireEvent.click(await screen.findByRole("button", { name: "壁纸设置" }));
  expect(onOpenWallpaperSettings).toHaveBeenCalledTimes(1);
});
