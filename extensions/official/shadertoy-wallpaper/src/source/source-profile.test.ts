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

  test("marks #version 300 es as an ES3 shader", () => {
    const result = detectShaderProfile(`#version 300 es\n${SAMPLE}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(300);
      expect(result.declaredVersion).toBe(300);
    }
  });

  test("accepts #version 100", () => {
    const result = detectShaderProfile(`#version 100\n${SAMPLE}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(100);
      expect(result.declaredVersion).toBe(100);
    }
  });

  test("rejects versions other than 100 / 300 es", () => {
    const result = detectShaderProfile(`#version 310 es\n${SAMPLE}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-version");
  });

  test("marks texelFetch as requiring ES3", () => {
    const result = detectShaderProfile(`void mainImage(out vec4 c, in vec2 p) {
      c = texelFetch(iChannel0, ivec2(0), 0);
    }`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(300);
      expect(result.es3Features).toContain("texelFetch");
    }
  });

  test("detects integer arrays, bit operations, and switch", () => {
    const result = detectShaderProfile(`const int[] font = int[](1, 2);
    void mainImage(out vec4 c, in vec2 p) {
      switch (int(p.x)) { default: break; }
      c = vec4(float((font[0] >> 1) & 1));
    }`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(300);
      expect(result.es3Features).toEqual(
        expect.arrayContaining(["整数数组", "位运算", "switch"]),
      );
    }
  });

  test("marks derivatives for the ES3 path", () => {
    const result = detectShaderProfile(
      `${SAMPLE}\nvec4 d = vec4(fwidth(fragCoord.x));`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usesDerivatives).toBe(true);
      expect(result.dialect).toBe(100);
    }
  });

  test("marks explicit LOD sampling for the ES3 path", () => {
    const result = detectShaderProfile(
      `${SAMPLE}\nvec4 d = textureLod(iChannel0, vec2(0.5), 0.0);`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usesTextureLod).toBe(true);
      expect(result.dialect).toBe(100);
    }
  });

  test("marks unsigned integers and global out declarations as ES3", () => {
    const result = detectShaderProfile(`out vec4 fragColor;
void main() { uint x = 1u; fragColor = vec4(float(x)); }`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(300);
      expect(result.es3Features).toEqual(
        expect.arrayContaining(["无符号整数", "全局 in/out"]),
      );
    }
  });

  test("does not flag logical && as a bit operation", () => {
    const result = detectShaderProfile(
      `${SAMPLE}\nbool b = (1.0 > 0.0) && (2.0 > 1.0);`,
    );
    expect(result.ok).toBe(true);
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

  test("accepts a mainVolume shader as the volume profile (ES3)", () => {
    const result = detectShaderProfile(
      "void mainVolume(out vec4 O, vec3 V) { O = vec4(V, 1.0); }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toBe("shadertoy-volume");
      expect(result.dialect).toBe(300);
    }
  });

  test("rejects mainVolume combined with mainImage or main", () => {
    const volume = "void mainVolume(out vec4 O, vec3 V) { O = vec4(1.0); }";
    for (const extra of [SAMPLE, "void main() {}"]) {
      const result = detectShaderProfile(`${volume}\n${extra}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
    }
  });

  test("detects ES3 array constructors and round()", () => {
    const result = detectShaderProfile(`${SAMPLE}
const vec4 K[2] = vec4[2](vec4(0.0), vec4(1.0));
float r = round(1.5);`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dialect).toBe(300);
      expect(result.es3Features).toContain("数组构造器");
      expect(result.es3Features).toContain("round");
    }
  });
});
