import { describe, expect, test } from "vitest";
import { adaptShadertoyVolume } from "./shadertoy-volume-adapter";

const VOLUME = `void mainVolume(out vec4 O, vec3 V) {
  O = texelFetch(iChannel0, ivec3(V), 0);
}`;

function adaptOk(
  source: string,
  channelKinds: ("2d" | "3d")[] = ["3d", "2d", "2d", "2d"],
) {
  const result = adaptShadertoyVolume(source, { channelKinds });
  expect(result.ok, result.ok ? "" : result.diagnostic.message).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.shader;
}

describe("adaptShadertoyVolume", () => {
  test("wraps mainVolume with the slice uniform and ES3 output", () => {
    const shader = adaptOk(VOLUME);
    expect(shader.fragmentSource).toContain("#version 300 es");
    expect(shader.fragmentSource).toContain("precision highp sampler3D;");
    expect(shader.fragmentSource).toContain("out vec4 lullFragColor;");
    expect(shader.fragmentSource).toContain("uniform float uLullVolumeSlice;");
    expect(shader.fragmentSource).toContain(
      "mainVolume(lullColor, vec3(gl_FragCoord.xy, uLullVolumeSlice + 0.5));",
    );
    expect(shader.fragmentSource).toContain("lullFragColor = lullColor;");
    expect(shader.vertexSource).toContain("#version 300 es");
    expect(shader.vertexSource).toContain("in vec2 aPosition");
  });

  test("declares volume channels as sampler3D and others as sampler2D", () => {
    const shader = adaptOk(VOLUME, ["3d", "2d", "3d", "2d"]);
    expect(shader.fragmentSource).toContain("uniform sampler3D iChannel0;");
    expect(shader.fragmentSource).toContain("uniform sampler2D iChannel1;");
    expect(shader.fragmentSource).toContain("uniform sampler3D iChannel2;");
    expect(shader.fragmentSource).toContain("uniform sampler2D iChannel3;");
  });

  test("rejects a volume section without mainVolume", () => {
    const result = adaptShadertoyVolume(
      "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }",
      { channelKinds: ["2d", "2d", "2d", "2d"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
  });

  test("strips a declared #version and redeclared built-in uniforms", () => {
    const shader = adaptOk(`#version 300 es
uniform sampler3D iChannel0;
${VOLUME}`);
    expect(shader.fragmentSource.match(/#version 300 es/g)).toHaveLength(1);
    expect(
      shader.fragmentSource.match(/uniform sampler3D iChannel0;/g),
    ).toHaveLength(1);
    expect(shader.warnings.join(" ")).toContain("#version");
  });

  test("maps gl_FragColor onto the ES3 output when used", () => {
    const shader = adaptOk(`void mainVolume(out vec4 O, vec3 V) {
      O = vec4(1.0);
      gl_FragColor = O;
    }`);
    expect(shader.fragmentSource).toContain(
      "#define gl_FragColor lullFragColor",
    );
  });

  test("keeps ES3 texture functions and array constructors intact", () => {
    const shader = adaptOk(`const vec4 K[2] = vec4[2](vec4(0.0), vec4(1.0));
void mainVolume(out vec4 O, vec3 V) {
  O = texture(iChannel0, V / 128.0) + K[0];
}`);
    expect(shader.fragmentSource).toContain("vec4[2](vec4(0.0), vec4(1.0))");
    expect(shader.fragmentSource).toContain("texture(iChannel0, V / 128.0)");
    expect(shader.fragmentSource).toContain("#define texture2D texture");
  });
});
