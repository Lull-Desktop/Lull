import { describe, expect, test } from "vitest";
import { WIDGET_CAPABILITIES } from "@/sdk/widget";
import { BUILTIN_WIDGETS, WINDOW_MANIFESTS, widgetById } from "./registry";

describe("builtin widget registry", () => {
  test("工具清单按 order 从 manifest 派生，设置外壳单独归类", () => {
    expect(BUILTIN_WIDGETS.map((widget) => widget.id)).toEqual([
      "library",
      "backdrop",
      "noise-library",
    ]);
    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.role).toBe("tool");
    }
    expect(WINDOW_MANIFESTS).toHaveLength(4);
    expect(WINDOW_MANIFESTS[0]?.role).toBe("shell");
  });

  test("ids, labels and routes are unique", () => {
    const ids = BUILTIN_WIDGETS.map((widget) => widget.id);
    const labels = BUILTIN_WIDGETS.map((widget) => widget.window.label);
    const routes = BUILTIN_WIDGETS.map((widget) => widget.window.route);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("only declared capabilities are used", () => {
    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.builtin).toBe(true);
      for (const capability of widget.capabilities) {
        expect(WIDGET_CAPABILITIES).toContain(capability);
      }
    }
  });

  test("三个库窗口沿用音乐库的尺寸与窗口策略", () => {
    for (const id of ["library", "backdrop", "noise-library"]) {
      const widget = widgetById(id);
      expect(widget?.window.width).toBe(1080);
      expect(widget?.window.height).toBe(760);
      expect(widget?.window.minWidth).toBe(900);
      expect(widget?.window.minHeight).toBe(600);
      expect(widget?.window.transparent).toBe(false);
      expect(widget?.window.resizable).toBe(true);
    }
    expect(widgetById("pomodoro")).toBeNull();
  });

  test("lookup by id is stable", () => {
    expect(widgetById("library")?.window.label).toBe("library");
    expect(widgetById("backdrop")?.window.label).toBe("backdrop");
    expect(widgetById("noise-library")?.window.label).toBe("noise-library");
    expect(widgetById("missing")).toBeNull();
  });
});
