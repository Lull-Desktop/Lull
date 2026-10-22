import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WidgetPluginShell } from "./widget-plugin-shell";

const CONTEXT = {
  v: 1,
  protocol: 1,
  hostApi: 1,
  id: "community-pomodoro",
  name: "番茄钟（示例）",
  version: "1.0.0",
  entryUrl: "http://lullwidget.localhost/community-pomodoro/index.html",
  requested: ["widget.theme", "widget.state"],
  granted: ["widget.theme", "widget.state"],
  minimizable: true,
  window: {
    width: 560,
    height: 680,
    minWidth: 520,
    minHeight: 620,
    resizable: false,
    transparent: true,
    chrome: "host" as const,
  },
};

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  window.__LULL_PLUGIN__ = CONTEXT;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  window.__LULL_PLUGIN__ = undefined;
  vi.unstubAllGlobals();
});

describe("WidgetPluginShell", () => {
  test("渲染宿主顶栏与 sandbox iframe", async () => {
    render(<WidgetPluginShell />);

    expect(await screen.findByText("番茄钟（示例）")).toBeDefined();
    const frame = screen.getByTitle(/番茄钟（示例）/);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(CONTEXT.entryUrl);
    expect(screen.getByLabelText("关闭窗口")).toBeDefined();
    expect(screen.getByLabelText("最小化")).toBeDefined();
    expect(
      document.querySelector("header")?.getAttribute("data-tauri-drag-region"),
    ).toBe("deep");
  });

  test("custom chrome 不渲染宿主顶栏", async () => {
    window.__LULL_PLUGIN__ = {
      ...CONTEXT,
      granted: [...CONTEXT.granted, "widget.chrome"],
      window: { ...CONTEXT.window, chrome: "custom" },
    };
    render(<WidgetPluginShell />);

    expect(await screen.findByTitle(/番茄钟（示例）/)).toBeDefined();
    expect(document.querySelector("header")).toBeNull();
  });

  test("没有注入上下文时给出错误提示", async () => {
    window.__LULL_PLUGIN__ = undefined;
    render(<WidgetPluginShell />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没有找到插件上下文");
  });
});
