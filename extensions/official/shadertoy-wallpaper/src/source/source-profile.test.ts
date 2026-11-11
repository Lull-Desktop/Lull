import { describe, expect, test } from "vitest";
import { MAX_SOURCE_CHARS } from "./source-model";
import {
  detectShaderProfile,
  findExternalInputs,
  normalizeSource,
  stripGlslComments,
} from "./source-profile";

const SAMPLE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / iResolution.xy, 0.0, 1.0);
}`;

describe("normalizeSource", () => {
  test("strips BOM and normalizes CRLF", () => {
    expect(normalizeSource("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("stripGlslComments", () => {
  test("drops line and block comments but keeps line count", () => {
    const source =
      "void main() {\n  // iChannel0\n  /* block\n  iChannel1 */\n  x;\n}";
    const stripped = stripGlslComments(source);
    expect(stripped).not.toContain("iChannel");
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  });
});

describe("findExternalInputs", () => {
  test("finds channel uniforms but ignores comments", () => {
    const source =
      "// uses iChannel0 in the comments\nvec4 a = texture2D(iChannel0, uv);\nfloat b = iSampleRate;";
    expect(findExternalInputs(source).sort()).toEqual([
      "iChannel0",
      "iSampleRate",
    ]);
  });
});

describe("detectShaderProfile", () => {
  test("accepts a mainImage shader", () => {
    const result = detectShaderProfile(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile).toBe("shadertoy-image");
  });

  test("rejects empty source", () => {
    const result = detectShaderProfile("  \n\t ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("source-empty");
  });

  test("rejects oversized source", () => {
    const result = detectShaderProfile(
      `void mainImage(out vec4 c, in vec2 p){}\n${"x".repeat(MAX_SOURCE_CHARS)}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("source-too-large");
  });

  test("rejects web demos with multiple shader blocks", () => {
    const demo = `<html><body>
<script type="x-shader/x-fragment" id="feedback">void main() {}</script>
<script type="x-shader/x-fragment" id="image">void main() {}</script>
</body></html>`;
    const result = detectShaderProfile(demo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("unsupported-source");
      expect(result.diagnostic.message).toContain("2 个");
      expect(result.diagnostic.detail).toContain("feedback");
    }
  });

  test("rejects JavaScript pasted without shader blocks", () => {
    const result = detectShaderProfile(
      "const a = [1, 2, 3];\nconst f = (x) => x;",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-source");
  });

  test("rejects plain HTML without shader blocks", () => {
    const result = detectShaderProfile("<html><body>hello</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-source");
  });

  test("does not flag GLSL const declarations", () => {
    const result = detectShaderProfile(`const float k = 1.0;\n${SAMPLE}`);
    expect(result.ok).toBe(true);
  });

  test("rejects non-ES1 #version", () => {
    const result = detectShaderProfile(`#version 300 es\n${SAMPLE}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-version");
  });

  test("accepts #version 100", () => {
    expect(detectShaderProfile(`#version 100\n${SAMPLE}`).ok).toBe(true);
  });

  test("accepts a raw fragment with custom main()", () => {
    const result = detectShaderProfile(
      "void main() { gl_FragColor = vec4(1.0); }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile).toBe("raw-fragment");
  });

  test("rejects both mainImage and main", () => {
    const result = detectShaderProfile(`${SAMPLE}\nvoid main() {}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
  });

  test("rejects missing entry", () => {
    const result = detectShaderProfile("float f(float x) { return x; }");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
  });

  test("accepts external inputs and reports them for placeholder binding", () => {
    const result = detectShaderProfile(
      `${SAMPLE}\nvec4 c = texture2D(iChannel0, vec2(0.5));`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(findExternalInputs(result.source)).toEqual(["iChannel0"]);
    }
  });

  test("ignores iChannel mentions inside comments", () => {
    const result = detectShaderProfile(
      `// iChannel0 is not used here\n${SAMPLE}`,
    );
    expect(result.ok).toBe(true);
  });

  test("rejects #include", () => {
    const result = detectShaderProfile(`#include "common.glsl"\n${SAMPLE}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-input");
  });
});
