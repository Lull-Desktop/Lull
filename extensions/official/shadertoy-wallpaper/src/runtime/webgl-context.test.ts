import { describe, expect, test } from "vitest";
import { createWebglContext } from "./webgl-context";

function fakeGl(
  extensions: Record<string, unknown> = {},
): WebGLRenderingContext {
  return {
    getExtension: (name: string) => extensions[name] ?? null,
    isContextLost: () => false,
  } as unknown as WebGLRenderingContext;
}

function fakeCanvas(resolve: (type: string) => unknown): {
  canvas: HTMLCanvasElement;
  calls: string[];
} {
  const calls: string[] = [];
  const canvas = {
    getContext: (type: string) => {
      calls.push(type);
      return resolve(type);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

describe("createWebglContext", () => {
  test("prefers WebGL2 when it is available", () => {
    const gl2 = fakeGl();
    const { canvas, calls } = fakeCanvas((type) =>
      type === "webgl2" ? gl2 : null,
    );
    const result = createWebglContext(canvas);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.version).toBe(2);
      expect(result.context.derivativesSupported).toBe(false);
      result.context.destroy();
    }
    expect(calls).toEqual(["webgl2"]);
  });

  test("falls back to WebGL1 and enables derivatives when available", () => {
    const gl1 = fakeGl({ OES_standard_derivatives: {} });
    const { canvas, calls } = fakeCanvas((type) =>
      type === "webgl" ? gl1 : null,
    );
    const result = createWebglContext(canvas);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.version).toBe(1);
      expect(result.context.derivativesSupported).toBe(true);
      result.context.destroy();
    }
    expect(calls).toEqual(["webgl2", "webgl"]);
  });

  test("reports unavailable WebGL", () => {
    const { canvas } = fakeCanvas(() => null);
    const result = createWebglContext(canvas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("webgl-unavailable");
    }
  });
});
