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

function adaptEs3(source: string) {
  const result = adaptRawFragment(source, {
    derivativesSupported: false,
    dialect: 300,
  });
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

  test("maps ES1 gl_FragColor output when compiling as ES3", () => {
    const shader = adaptEs3(RAW);
    expect(shader.fragmentSource).toContain("out vec4 lullFragColor;");
    expect(shader.fragmentSource).toContain(
      "#define gl_FragColor lullFragColor",
    );
    expect(shader.vertexSource).toContain("#version 300 es");
  });

  test("maps gl_FragColor onto an existing ES3 out variable", () => {
    const shader = adaptEs3(`#version 300 es
out vec4 fragColor;
void main() { gl_FragColor = vec4(1.0); }`);
    expect(shader.fragmentSource).toContain("#define gl_FragColor fragColor");
    expect(shader.fragmentSource).not.toContain("out vec4 lullFragColor;");
  });

  test("keeps an explicit ES3 out variable without adding a second output", () => {
    const shader = adaptEs3(`#version 300 es
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }`);
    expect(shader.fragmentSource).toContain("out vec4 fragColor;");
    expect(shader.fragmentSource).not.toContain("out vec4 lullFragColor;");
    expect(shader.fragmentSource).not.toContain("#define gl_FragColor");
  });

  test("maps gl_FragData to a single ES3 output array", () => {
    const shader = adaptEs3("void main() { gl_FragData[0] = vec4(1.0); }");
    expect(shader.fragmentSource).toContain("out vec4 lullFragData[1];");
    expect(shader.fragmentSource).toContain("#define gl_FragData lullFragData");
  });

  test("ES3 lineOffset points at the first user source line", () => {
    const shader = adaptEs3(RAW);
    const lines = shader.fragmentSource.split("\n");
    expect(lines[shader.lineOffset]).toContain("void main()");
  });
});
