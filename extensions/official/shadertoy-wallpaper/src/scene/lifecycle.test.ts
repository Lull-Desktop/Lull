import { describe, expect, test } from "vitest";
import { readRuntimeParams, resolveSource, shouldPause } from "./lifecycle";

describe("readRuntimeParams", () => {
  test("applies defaults for missing or invalid values", () => {
    expect(readRuntimeParams({})).toEqual({
      source: "",
      renderScale: 1,
      animation: true,
    });
    expect(
      readRuntimeParams({
        source: 3 as unknown as string,
        "render-scale": Number.NaN,
        animation: false,
      }),
    ).toEqual({ source: "", renderScale: 1, animation: false });
  });

  test("keeps the source text verbatim", () => {
    const source =
      "void mainImage(out vec4 c, in vec2 p) {\n c = vec4(1.0);\n}";
    expect(readRuntimeParams({ source }).source).toBe(source);
  });
});

describe("resolveSource", () => {
  const fallback = "void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }";

  test("falls back to the built-in source when nothing was provided", () => {
    expect(resolveSource("", fallback)).toBe(fallback);
    expect(resolveSource("   \n\t ", fallback)).toBe(fallback);
  });

  test("keeps user source verbatim, including leading whitespace", () => {
    const source = "\n// my shader\nvoid mainImage(out vec4 c, in vec2 p) {}";
    expect(resolveSource(source, fallback)).toBe(source);
    expect(resolveSource("  x", fallback)).toBe("  x");
  });
});

describe("shouldPause", () => {
  const ready = {
    animation: true,
    visible: true,
    documentVisible: true,
    hasProgram: true,
    stopped: false,
  };

  test("runs only when everything is ready", () => {
    expect(shouldPause(ready)).toBe(false);
  });

  test("pauses for any hold condition", () => {
    expect(shouldPause({ ...ready, animation: false })).toBe(true);
    expect(shouldPause({ ...ready, visible: false })).toBe(true);
    expect(shouldPause({ ...ready, documentVisible: false })).toBe(true);
    expect(shouldPause({ ...ready, hasProgram: false })).toBe(true);
    expect(shouldPause({ ...ready, stopped: true })).toBe(true);
  });
});
