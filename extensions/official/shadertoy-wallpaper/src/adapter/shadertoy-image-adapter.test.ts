import { describe, expect, test } from "vitest";
import { adaptShadertoyImage } from "./shadertoy-image-adapter";

const SAMPLE = `uniform vec3 iResolution;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}`;

function adaptOk(source: string, derivativesSupported = false) {
  const result = adaptShadertoyImage(source, { derivativesSupported });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.shader;
}

describe("adaptShadertoyImage", () => {
  test("wraps mainImage and injects the supported uniforms", () => {
    const shader = adaptOk(SAMPLE);
    expect(shader.vertexSource).toContain("attribute vec2 aPosition");
    expect(shader.fragmentSource).toContain("uniform vec3  iResolution;");
    expect(shader.fragmentSource).toContain("uniform float iTime;");
    expect(shader.fragmentSource).toContain("uniform vec4  iMouse;");
    expect(shader.fragmentSource).toContain("uniform sampler2D iChannel0;");
    expect(shader.fragmentSource).toContain(
      "uniform vec3  iChannelResolution[4];",
    );
    expect(shader.fragmentSource).toContain(
      "mainImage(lullColor, gl_FragCoord.xy);",
    );
    expect(shader.fragmentSource).toContain("gl_FragColor = lullColor;");
    expect(shader.fragmentSource).toContain("#define texture texture2D");
  });

  test("strips #version 100 and duplicate built-in uniform declarations", () => {
    const shader = adaptOk(`#version 100\n${SAMPLE}`);
    expect(shader.fragmentSource).not.toContain("#version");
    // 只有模板里的那一份声明。
    expect(
      shader.fragmentSource.match(/uniform vec3 {2}iResolution;/g),
    ).toHaveLength(1);
    expect(shader.warnings.join(" ")).toContain("#version");
    expect(shader.warnings.join(" ")).toContain("uniform");
  });

  test("strips user-declared channel uniforms", () => {
    const shader = adaptOk(`uniform sampler2D iChannel0;\n${SAMPLE}`);
    expect(
      shader.fragmentSource.match(/uniform sampler2D iChannel0;/g),
    ).toHaveLength(1);
    expect(shader.warnings.join(" ")).toContain("uniform");
  });

  test("hoists user #extension lines above declarations", () => {
    const shader = adaptOk(
      `#extension GL_OES_standard_derivatives : enable\n${SAMPLE}`,
    );
    const extensionIndex = shader.fragmentSource.indexOf("#extension");
    const uniformIndex = shader.fragmentSource.indexOf(
      "uniform vec3  iResolution;",
    );
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    expect(extensionIndex).toBeLessThan(uniformIndex);
    expect(shader.fragmentSource.match(/#extension/g)).toHaveLength(1);
  });

  test("adds the derivatives extension when the context supports it", () => {
    const shader = adaptOk(
      `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
        fragColor = vec4(fwidth(fragCoord.x));
      }`,
      true,
    );
    expect(shader.fragmentSource).toContain("GL_OES_standard_derivatives");
  });

  test("reports derivatives without extension support", () => {
    const result = adaptShadertoyImage(
      `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
        fragColor = vec4(fwidth(fragCoord.x));
      }`,
      { derivativesSupported: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-feature");
  });

  test("lineOffset points at the first user source line", () => {
    const shader = adaptOk(SAMPLE);
    const lines = shader.fragmentSource.split("\n");
    expect(lines[shader.lineOffset]).toContain("void mainImage");
  });

  test("rejects sources without mainImage", () => {
    const result = adaptShadertoyImage("void main() {}", {
      derivativesSupported: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
  });

  test("warns about textureLod degradation", () => {
    const shader = adaptOk(
      `uniform sampler2D tex;
       void mainImage(out vec4 fragColor, in vec2 fragCoord) {
         fragColor = textureLod(tex, fragCoord, 0.0);
       }`,
    );
    expect(shader.warnings.join(" ")).toContain("textureLod");
  });
});
