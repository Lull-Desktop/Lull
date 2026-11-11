import { describe, expect, test } from "vitest";
import { createFakeGl } from "../testing/fake-gl";
import { compileProgram } from "./shader-compiler";

const INPUT = {
  vertexSource:
    "attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }",
  fragmentSource: "void main() { gl_FragColor = vec4(1.0); }",
  lineOffset: 12,
};

describe("compileProgram", () => {
  test("links a program on success", () => {
    const { gl, state } = createFakeGl();
    const result = compileProgram(gl, INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.program).toBeDefined();
    expect(state.failCompile).toBe(false);
  });

  test("reports fragment compiler logs with the line offset", () => {
    const { gl } = createFakeGl({ failFragmentCompile: true });
    const result = compileProgram(gl, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("compile-failed");
      expect(result.diagnostic.detail).toContain("unknownFunction");
      expect(result.diagnostic.lineOffset).toBe(12);
    }
  });

  test("reports link failures separately", () => {
    const { gl } = createFakeGl({ failLink: true });
    const result = compileProgram(gl, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("link-failed");
      expect(result.diagnostic.detail).toContain("varying mismatch");
    }
  });

  test("refuses to compile while the context is lost", () => {
    const { gl } = createFakeGl({ lost: true });
    const result = compileProgram(gl, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("context-lost");
  });
});
