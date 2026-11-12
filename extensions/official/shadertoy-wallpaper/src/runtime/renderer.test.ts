import { describe, expect, test } from "vitest";
import { createFakeContext, createFakeGl } from "../testing/fake-gl";
import { createShaderRenderer } from "./renderer";

const SOURCE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0);
}`;

function setup(
  options: {
    failCompile?: boolean;
    failLink?: boolean;
    version?: 1 | 2;
    derivativesSupported?: boolean;
    floatColorBuffer?: boolean;
  } = {},
) {
  const fake = createFakeGl({
    failCompile: options.failCompile,
    failLink: options.failLink,
    floatColorBuffer: options.floatColorBuffer,
  });
  const context = createFakeContext(fake.gl, {
    version: options.version,
    derivativesSupported: options.derivativesSupported,
  });
  const canvas = { width: 300, height: 150 } as HTMLCanvasElement;
  const renderer = createShaderRenderer({ canvas, context });
  return { fake, context, canvas, renderer };
}

const UNIFORMS = {
  resolution: [640, 360] as const,
  time: 1,
  timeDelta: 0.016,
  frame: 2,
  frameRate: 60,
  mouse: [0, 0, 0, 0] as const,
  date: [2026, 10, 11, 0] as const,
};

describe("createShaderRenderer", () => {
  test("loads a shader, draws it, and applies the draw size", () => {
    const { fake, renderer, canvas } = setup();
    expect(renderer.load(SOURCE).ok).toBe(true);
    expect(renderer.hasProgram()).toBe(true);

    renderer.resize({ width: 640, height: 360 });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);

    renderer.render(UNIFORMS);
    expect(fake.state.calls).toContain("drawArrays");
    expect(fake.state.calls).toContain("uniform3f");
    expect(fake.state.calls).toContain("uniform4f");
  });

  test("rejects a source without an entry point", () => {
    const { renderer } = setup();
    const result = renderer.load("float f(float x) { return x; }");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("unsupported-entry");
    expect(renderer.hasProgram()).toBe(false);
  });

  test("rejects unsupported #version but accepts placeholders for external inputs", () => {
    const { renderer } = setup();
    const version = renderer.load(
      `#version 300 es
       void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`,
    );
    expect(version.ok).toBe(false);
    if (!version.ok) {
      expect(version.diagnostic.code).toBe("unsupported-version");
      expect(version.diagnostic.message).toContain("WebGL2");
    }

    const channels = renderer.load(
      "void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }",
    );
    expect(channels.ok).toBe(true);
    if (channels.ok) {
      expect(channels.channels).toEqual(["iChannel0"]);
      expect(channels.warnings.join(" ")).toContain("占位");
    }
    expect(renderer.hasProgram()).toBe(true);
  });

  test("rejects ES3-only features with a WebGL2 diagnostic on WebGL1", () => {
    const { renderer } = setup();
    const result = renderer.load(`void mainImage(out vec4 c, in vec2 p) {
      c = texelFetch(iChannel0, ivec2(0), 0);
    }`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("unsupported-feature");
      expect(result.diagnostic.message).toContain("WebGL2");
      expect(result.diagnostic.detail).toContain("texelFetch");
    }
  });

  test("compiles ES3 shaders on WebGL2 with the ES3 vertex template", () => {
    const { fake, renderer } = setup({ version: 2 });
    const result = renderer.load(`#version 300 es
void mainImage(out vec4 c, in vec2 p) {
  c = texelFetch(iChannel0, ivec2(p), 0);
}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passes).toEqual(["Image"]);

    const fragment = fake.state.shaderSources.find((source) =>
      source.includes("// ---- user source ----"),
    );
    const vertex = fake.state.shaderSources.find((source) =>
      source.includes("in vec2 aPosition"),
    );
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toContain("out vec4 lullFragColor;");
    expect(fragment).toContain("#define texture2D texture");
    expect(vertex).toContain("#version 300 es");
    expect(vertex).not.toContain("attribute vec2 aPosition");
  });

  test("keeps ES1 shaders on the ES1 path in a WebGL2 context", () => {
    const { fake, renderer } = setup({ version: 2 });
    expect(renderer.load(SOURCE).ok).toBe(true);
    expect(
      fake.state.shaderSources.some((source) =>
        source.includes("#version 300 es"),
      ),
    ).toBe(false);
    expect(
      fake.state.shaderSources.some((source) =>
        source.includes("attribute vec2 aPosition"),
      ),
    ).toBe(true);
  });

  test("compiles derivative shaders as ES3 on WebGL2", () => {
    const { fake, renderer } = setup({ version: 2 });
    const result = renderer.load(`void mainImage(out vec4 c, in vec2 p) {
      c = vec4(fwidth(p.x));
    }`);
    expect(result.ok).toBe(true);
    const fragment = fake.state.shaderSources.find((source) =>
      source.includes("// ---- user source ----"),
    );
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toContain("fwidth");
    expect(fragment).not.toContain("GL_OES_standard_derivatives");
  });

  test("compiles textureLod shaders as ES3 on WebGL2", () => {
    const { fake, renderer } = setup({ version: 2 });
    const result = renderer.load(`void mainImage(out vec4 c, in vec2 p) {
      c = textureLod(iChannel0, p / iResolution.xy, 0.0);
    }`);
    expect(result.ok).toBe(true);
    const fragment = fake.state.shaderSources.find((source) =>
      source.includes("// ---- user source ----"),
    );
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toContain("textureLod");
    expect(fragment).not.toContain("textureLod(s, uv, lod)");
  });

  test("loads a raw ES3 fragment with its own out variable", () => {
    const { fake, renderer } = setup({ version: 2 });
    const result = renderer.load(`#version 300 es
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }`);
    expect(result.ok).toBe(true);
    const fragment = fake.state.shaderSources.find((source) =>
      source.includes("// ---- user source ----"),
    );
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toContain("out vec4 fragColor;");
    expect(fragment).not.toContain("out vec4 lullFragColor;");
    expect(fragment).not.toContain("#define gl_FragColor");
  });

  test("uploads and binds placeholder channel textures while drawing", () => {
    const { fake, renderer } = setup();
    expect(renderer.load(SOURCE).ok).toBe(true);
    fake.state.calls.length = 0;
    renderer.render(UNIFORMS);
    expect(fake.state.texImages).toEqual([
      { width: 256, height: 256 },
      { width: 1, height: 1 },
    ]);
    expect(
      fake.state.calls.filter((call) => call === "activeTexture"),
    ).toHaveLength(4);
    expect(fake.state.calls).toContain("uniform3fv");
    expect(fake.state.calls).toContain("uniform1fv");
    expect(fake.state.calls).toContain("drawArrays");
    renderer.unload();
    expect(fake.state.deletedTextures).toBe(2);
  });

  test("loads a raw fragment with a custom main()", () => {
    const { renderer } = setup();
    const result = renderer.load(
      "void main() { gl_FragColor = vec4(gl_FragCoord.xy, 0.0, 1.0); }",
    );
    expect(result.ok).toBe(true);
    expect(renderer.hasProgram()).toBe(true);
  });

  test("loads and renders a multipass pipeline with feedback", () => {
    const { fake, renderer } = setup();
    renderer.resize({ width: 8, height: 8 });
    const result = renderer.load(`//---- Buffer A ----
void mainImage(out vec4 c, in vec2 p) {
  c = vec4(p / iResolution.xy, 0.0, 1.0);
}

//---- Image ----
void mainImage(out vec4 c, in vec2 p) {
  c = texture2D(iChannel0, p / iResolution.xy);
}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passes).toEqual(["BufferA", "Image"]);
    }
    expect(renderer.hasProgram()).toBe(true);

    fake.state.calls.length = 0;
    renderer.render(UNIFORMS);
    expect(
      fake.state.calls.filter((call) => call === "drawArrays"),
    ).toHaveLength(2);
    expect(fake.state.calls).toContain("bindFramebuffer");
    expect(fake.state.calls).toContain("framebufferTexture2D");

    renderer.unload();
    expect(renderer.hasProgram()).toBe(false);
  });

  test("rejects a multipass source without Image", () => {
    const { renderer } = setup();
    const result = renderer.load(`//---- Buffer A ----
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.message).toContain("Image");
  });

  test("keeps the previous program when a new shader fails to compile", () => {
    const { fake, renderer } = setup();
    expect(renderer.load(SOURCE).ok).toBe(true);
    fake.state.failFragmentCompile = true;

    const result = renderer.load(SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("compile-failed");
    expect(renderer.hasProgram()).toBe(true);

    fake.state.calls.length = 0;
    renderer.render(UNIFORMS);
    expect(fake.state.calls).toContain("drawArrays");
  });

  test("unload disposes the program and stops drawing", () => {
    const { fake, renderer } = setup();
    expect(renderer.load(SOURCE).ok).toBe(true);
    renderer.unload();
    expect(renderer.hasProgram()).toBe(false);
    fake.state.calls.length = 0;
    renderer.render(UNIFORMS);
    expect(fake.state.calls).not.toContain("drawArrays");
  });

  test("refuses to load while the context is lost", () => {
    const { context, renderer } = setup();
    context.lose();
    const result = renderer.load(SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("context-lost");
  });

  const VOLUME_PIPELINE = `//==== Volume A ====
void mainVolume(out vec4 O, vec3 V) {
  O = texelFetch(iChannel0, ivec3(V), 0) + vec4(0.01);
}
//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) {
  c = texture(iChannel0, vec3(p / iResolution.xy, 0.5));
}
//==== Image A ====
void mainImage(out vec4 c, in vec2 p) {
  c = texture2D(iChannel0, p / iResolution.xy);
}
//==== Bindings ====
BufferA.iChannel0 = VolumeA
VolumeA.size = 8`;

  test("loads a volume pipeline on WebGL2 with sampler3D channels", () => {
    const { fake, renderer } = setup({ version: 2, floatColorBuffer: true });
    const result = renderer.load(VOLUME_PIPELINE);
    expect(result.ok, result.ok ? "" : result.diagnostic.message).toBe(true);
    if (result.ok) {
      expect(result.passes).toEqual(["VolumeA", "BufferA", "ImageA"]);
    }

    const volumeFragment = fake.state.shaderSources.find((source) =>
      source.includes("mainVolume(lullColor"),
    );
    expect(volumeFragment).toContain("uniform sampler3D iChannel0;");
    expect(volumeFragment).toContain("uniform float uLullVolumeSlice;");

    // Buffer A samples the volume, so its iChannel0 must also be sampler3D,
    // and it must compile as ES3 even without explicit ES3 syntax.
    const bufferFragment = fake.state.shaderSources.find(
      (source) =>
        source.includes("// ---- user source ----") &&
        source.includes("vec3(p / iResolution.xy, 0.5)"),
    );
    expect(bufferFragment).toContain("#version 300 es");
    expect(bufferFragment).toContain("uniform sampler3D iChannel0;");

    expect(fake.state.texImages3D).toEqual([
      { width: 8, height: 8, depth: 8 },
      { width: 8, height: 8, depth: 8 },
    ]);
  });

  test("hints at a Volume binding when a 2D pass fails on a texture overload", () => {
    const { fake, renderer } = setup({ version: 2, floatColorBuffer: true });
    fake.state.failFragmentCompile = true;
    // 没有 BufferA.iChannel0 = VolumeA 绑定：Buffer A 的 iChannel0 仍是 2D。
    const unbound = VOLUME_PIPELINE.replace(
      "BufferA.iChannel0 = VolumeA\n",
      "",
    );
    const result = renderer.load(unbound);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("compile-failed");
      expect(result.diagnostic.message).toContain("Bindings");
      expect(result.diagnostic.message).toContain(
        "BufferA.iChannel0 = VolumeA",
      );
    }
  });

  test("does not add the Volume hint for a plain single-pass compile failure", () => {
    const { fake, renderer } = setup();
    fake.state.failFragmentCompile = true;
    const result = renderer.load(SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.message).not.toContain("Bindings");
    }
  });

  test("renders every volume slice each frame and displays Image A", () => {
    const { fake, renderer } = setup({ version: 2, floatColorBuffer: true });
    expect(renderer.load(VOLUME_PIPELINE).ok).toBe(true);
    fake.state.calls.length = 0;
    fake.state.framebufferLayers.length = 0;

    renderer.render(UNIFORMS);

    // 8 volume slices + Buffer A + Image A = 10 draws.
    expect(
      fake.state.calls.filter((call) => call === "drawArrays"),
    ).toHaveLength(10);
    expect(fake.state.framebufferLayers).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fake.state.calls).toContain("framebufferTextureLayer");
    expect(fake.state.calls).toContain("uniform1f");
  });

  test("rejects volume passes on WebGL1 with a WebGL2 diagnostic", () => {
    const { renderer } = setup({ version: 1 });
    const result = renderer.load(VOLUME_PIPELINE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("unsupported-feature");
      expect(result.diagnostic.message).toContain("WebGL2");
      expect(result.diagnostic.message).toContain("VolumeA");
    }
  });

  test("rejects volume passes without EXT_color_buffer_float", () => {
    const { renderer } = setup({ version: 2, floatColorBuffer: false });
    const result = renderer.load(VOLUME_PIPELINE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("webgl-unavailable");
      expect(result.diagnostic.detail).toContain("EXT_color_buffer_float");
    }
  });

  test("rejects mainImage in a Volume section and mainVolume elsewhere", () => {
    const { renderer } = setup({ version: 2, floatColorBuffer: true });
    const wrongVolume = renderer.load(`//==== Volume A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(wrongVolume.ok).toBe(false);
    if (!wrongVolume.ok)
      expect(wrongVolume.diagnostic.code).toBe("unsupported-entry");

    const wrongBuffer = renderer.load(`//==== Buffer A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(wrongBuffer.ok).toBe(false);
    if (!wrongBuffer.ok)
      expect(wrongBuffer.diagnostic.code).toBe("unsupported-entry");
  });

  test("disposes volume textures on unload", () => {
    const { fake, renderer } = setup({ version: 2, floatColorBuffer: true });
    expect(renderer.load(VOLUME_PIPELINE).ok).toBe(true);
    const before = fake.state.deletedTextures;
    renderer.unload();
    // 2 volume textures + 2 Buffer A feedback textures + noise + black.
    expect(fake.state.deletedTextures - before).toBe(6);
    expect(renderer.hasProgram()).toBe(false);
  });
});
