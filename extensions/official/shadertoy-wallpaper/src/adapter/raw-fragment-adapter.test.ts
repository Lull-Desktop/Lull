import { describe, expect, test } from "vitest";
import { adaptRawFragment } from "./raw-fragment-adapter";

const RAW = `void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  gl_FragColor = vec4(uv, 0.5, 1.0);
}`;

function adaptOk(source: string, derivativesSupported = false) {
  const result = adaptRawFragment(source, { derivativesSupported });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.shader;
}

describe("adaptRawFragment", () => {
  test("keeps main() and injects uniforms without wrapping mainImage", () => {
    const shader = adaptOk(RAW);
    expect(shader.fragmentSource).toContain("void main()");
    expect(shader.fragmentSource).not.toContain("mainImage");
    expect(shader.fragmentSource).toContain("uniform vec3  iResolution;");
    expect(shader.fragmentSource).toContain("uniform sampler2D iChannel0;");
    expect(shader.fragmentSource).toContain("precision highp float;");
    expect(shader.vertexSource).toContain("varying vec2 vUv;");
  });

  test("strips #version and duplicate built-in uniform declarations", () => {
    const shader = adaptOk(`#version 100\nuniform vec3 iResolution;\n${RAW}`);
    expect(shader.fragmentSource).not.toContain("#version");
    expect(
      shader.fragmentSource.match(/uniform vec3 {2}iResolution;/g),
    ).toHaveLength(1);
    expect(shader.warnings.join(" ")).toContain("#version");
    expect(shader.warnings.join(" ")).toContain("uniform");
  });

  test("lineOffset points at the first user source line", () => {
    const shader = adaptOk(RAW);
    const lines = shader.fragmentSource.split("\n");
    expect(lines[shader.lineOffset]).toContain("void main()");
  });

  test("rejects sources without main()", () => {
    const result = adaptRawFragment("float f(float x) { return x; }", {
      derivativesSupported: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
  });

  test("adds the derivatives extension when the context supports it", () => {
    const shader = adaptOk(
      "void main() { gl_FragColor = vec4(fwidth(gl_FragCoord.x)); }",
      true,
    );
    expect(shader.fragmentSource).toContain("GL_OES_standard_derivatives");
  });

  test("reports derivatives without extension support", () => {
    const result = adaptRawFragment(
      "void main() { gl_FragColor = vec4(fwidth(gl_FragCoord.x)); }",
      { derivativesSupported: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-feature");
  });

  test("warns about textureLod degradation", () => {
    const shader = adaptOk(
      "void main() { gl_FragColor = textureLod(iChannel0, vec2(0.5), 0.0); }",
    );
    expect(shader.warnings.join(" ")).toContain("textureLod");
  });
});
