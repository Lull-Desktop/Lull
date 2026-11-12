import { describe, expect, test } from "vitest";
import { createFakeContext, createFakeGl } from "../testing/fake-gl";
import { createShaderRenderer } from "./renderer";

const SOURCE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0);
}`;

function setup(options: { failCompile?: boolean; failLink?: boolean } = {}) {
  const fake = createFakeGl(options);
  const context = createFakeContext(fake.gl);
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
    if (!version.ok)
      expect(version.diagnostic.code).toBe("unsupported-version");

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
});
