import { describe, expect, test } from "vitest";
import { WIDGET_CAPABILITIES } from "@/sdk/widget";
import { BUILTIN_WIDGETS, widgetById } from "./registry";

describe("builtin widget registry", () => {
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

  test("immersive tools stay transparent and fixed-size", () => {
    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.window.transparent).toBe(true);
      expect(widget.window.resizable).toBe(false);
      expect(widget.window.minWidth).toBeLessThanOrEqual(widget.window.width);
      expect(widget.window.minHeight).toBeLessThanOrEqual(widget.window.height);
    }
  });

  test("lookup by id is stable", () => {
    expect(widgetById("player")?.window.label).toBe("player");
    expect(widgetById("missing")).toBeNull();
  });
});
