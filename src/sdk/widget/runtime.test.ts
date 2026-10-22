import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  hosted: false,
  alignPlayerWindow: vi.fn(async () => {}),
  hideWindow: vi.fn(async () => {}),
  isWindowMinimizable: vi.fn(async () => true),
  minimizeWindow: vi.fn(async () => {}),
  onWindowPrefsChanged: vi.fn(() => () => {}),
  setWindowResizable: vi.fn(async () => {}),
  setWindowWidth: vi.fn(async () => {}),
  startWindowDrag: vi.fn(async () => {}),
}));

vi.mock("@/core/window/controls", () => ({
  alignPlayerWindow: harness.alignPlayerWindow,
  hideWindow: harness.hideWindow,
  isDesktopWindow: () => harness.hosted,
  isWindowMinimizable: harness.isWindowMinimizable,
  minimizeWindow: harness.minimizeWindow,
  onWindowPrefsChanged: harness.onWindowPrefsChanged,
  setWindowResizable: harness.setWindowResizable,
  setWindowWidth: harness.setWindowWidth,
  startWindowDrag: harness.startWindowDrag,
}));

import {
  getWidgetContext,
  hasWidgetCapability,
  isWidgetAudioAvailable,
  isWidgetMediaAvailable,
  onWidgetPrefsChanged,
  readWidgetStorage,
  requireWidgetCapability,
  resetWidgetRuntimeForTests,
  WidgetCapabilityError,
  widgetAlignPlayer,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetResizeWidth,
  widgetStorageKey,
  writeWidgetStorage,
} from "./runtime";

const PLAYER_CONTEXT = {
  schemaVersion: 1,
  hostApi: 1,
  id: "player",
  capabilities: [
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.media",
    "widget.chrome",
  ],
  window: {
    label: "player",
    route: "player",
    title: "Lull 播放器",
    width: 880,
    height: 552,
    minWidth: 500,
    minHeight: 520,
    resizable: false,
    transparent: true,
  },
};

beforeEach(() => {
  window.localStorage.clear();
  window.__LULL_WIDGET__ = undefined;
  harness.hosted = false;
  vi.clearAllMocks();
  resetWidgetRuntimeForTests();
});

describe("widget runtime", () => {
  test("浏览器预览没有宿主上下文时按开发环境放行", () => {
    expect(hasWidgetCapability("widget.state")).toBe(true);
    expect(writeWidgetStorage("player", "v1", '{"a":1}')).toBe(true);
    expect(window.localStorage.getItem("lull:player:v1")).toBe('{"a":1}');
    expect(readWidgetStorage("player", "v1")).toBe('{"a":1}');
  });

  test("宿主上下文限定能力与状态命名空间", () => {
    window.__LULL_WIDGET__ = PLAYER_CONTEXT;
    resetWidgetRuntimeForTests();

    expect(getWidgetContext()?.id).toBe("player");
    expect(hasWidgetCapability("widget.chrome")).toBe(true);
    expect(widgetStorageKey("player", "v1")).toBe("lull:player:v1");
    expect(() => widgetStorageKey("pomodoro", "v1")).toThrow(/命名空间/);
  });

  test("未声明的能力被忽略：状态不落盘、窗口操作不执行", async () => {
    window.__LULL_WIDGET__ = { ...PLAYER_CONTEXT, capabilities: ["widget.ui"] };
    resetWidgetRuntimeForTests();

    expect(readWidgetStorage("player", "v1")).toBeNull();
    expect(writeWidgetStorage("player", "v1", "x")).toBe(false);
    expect(window.localStorage.getItem("lull:player:v1")).toBeNull();
    expect(isWidgetAudioAvailable()).toBe(false);
    expect(isWidgetMediaAvailable()).toBe(false);
    expect(() => requireWidgetCapability("widget.audio")).toThrow(
      WidgetCapabilityError,
    );

    await widgetHideWindow();
    expect(harness.hideWindow).not.toHaveBeenCalled();
  });

  test("chrome 宽度按清单声明的上下限夹取", async () => {
    window.__LULL_WIDGET__ = PLAYER_CONTEXT;
    resetWidgetRuntimeForTests();

    await widgetResizeWidth(2000);
    expect(harness.setWindowWidth).toHaveBeenLastCalledWith(880, "left");

    await widgetResizeWidth(100, "right");
    expect(harness.setWindowWidth).toHaveBeenLastCalledWith(500, "right");

    await widgetAlignPlayer("left", "right", 2000, 287);
    expect(harness.alignPlayerWindow).toHaveBeenLastCalledWith(
      "left",
      "right",
      880,
      287,
    );
  });

  test("chrome 查询与偏好订阅透传宿主", async () => {
    window.__LULL_WIDGET__ = PLAYER_CONTEXT;
    resetWidgetRuntimeForTests();

    await expect(widgetIsMinimizable()).resolves.toBe(true);
    const stop = onWidgetPrefsChanged(() => {});
    expect(harness.onWindowPrefsChanged).toHaveBeenCalledOnce();
    stop();
  });

  test("Tauri 里缺少注入上下文时失败关闭", () => {
    harness.hosted = true;
    resetWidgetRuntimeForTests();

    expect(hasWidgetCapability("widget.ui")).toBe(false);
    expect(readWidgetStorage("player", "v1")).toBeNull();
    expect(() => requireWidgetCapability("widget.ui")).toThrow(
      WidgetCapabilityError,
    );
  });
});
