import { describe, expect, test } from "vitest";
import { WIDGET_CAPABILITIES } from "@/sdk/widget";
import { BUILTIN_WIDGETS, WINDOW_MANIFESTS, widgetById } from "./registry";

describe("builtin widget registry", () => {
  test("工具清单按 order 从 manifest 派生，设置外壳单独归类", () => {
    expect(BUILTIN_WIDGETS.map((widget) => widget.id)).toEqual(["library"]);
    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.role).toBe("tool");
    }
    expect(WINDOW_MANIFESTS).toHaveLength(2);
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

  test("library is the only built-in tool and stays resizable/opaque", () => {
    const library = widgetById("library");
    expect(library?.window.transparent).toBe(false);
    expect(library?.window.resizable).toBe(true);
    expect(widgetById("pomodoro")).toBeNull();
  });

  test("lookup by id is stable", () => {
    expect(widgetById("library")?.window.label).toBe("library");
    expect(widgetById("missing")).toBeNull();
  });
});
