import { describe, expect, test } from "vitest";
import { parsePassSource } from "./pass-source";

const SINGLE = `void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`;

const MULTI = `//---- Common ----
float helper(float x) { return x * 2.0; }

//---- Buffer A ----
void mainImage(out vec4 c, in vec2 p) { c = vec4(helper(p.x)); }

//---- Image ----
void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }

//---- Bindings ----
Image.iChannel0 = BufferA
`;

function parseOk(source: string) {
  const result = parsePassSource(source);
  expect(result.ok, result.ok ? "" : result.diagnostic.message).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value;
}

describe("parsePassSource", () => {
  test("keeps a source without markers as a single Image pass", () => {
    const parsed = parseOk(SINGLE);
    expect(parsed.mode).toBe("single");
    expect(parsed.passes).toHaveLength(1);
    expect(parsed.passes[0]?.name).toBe("Image");
    expect(parsed.passes[0]?.source).toBe(SINGLE);
  });

  test("parses Common, buffers, Image and bindings", () => {
    const parsed = parseOk(MULTI);
    expect(parsed.mode).toBe("multipass");
    expect(parsed.common).toContain("helper");
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "BufferA",
      "Image",
    ]);
    expect(parsed.bindings.Image?.[0]).toBe("BufferA");
  });

  test("supports spaced and equals markers", () => {
    const parsed = parseOk(`// ==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
// ==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "BufferA",
      "Image",
    ]);
  });

  test("accepts Noise and Black targets", () => {
    const parsed = parseOk(`//---- Image ----
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//---- Bindings ----
Image.iChannel0 = Noise
Image.iChannel1 = Black`);
    expect(parsed.bindings.Image?.[0]).toBe("Noise");
    expect(parsed.bindings.Image?.[1]).toBe("Black");
  });

  test("supports decorative marker variants and @pass", () => {
    const parsed = parseOk(`//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
// @pass Image
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "BufferA",
      "Image",
    ]);
  });

  test("supports short markers, decorative styles and @bindings", () => {
    const parsed = parseOk(`//== Buffer A
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//**** Image ****
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
// @bindings
Image.iChannel0 = Noise`);
    expect(parsed.bindings.Image?.[0]).toBe("Noise");
  });

  test("orders passes A-D then Image regardless of marker order", () => {
    const parsed = parseOk(`//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Buffer B ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "BufferA",
      "BufferB",
      "Image",
    ]);
  });

  test("does not treat plain comments as section markers", () => {
    const parsed = parseOk(`// Buffer A is used here\n${SINGLE}`);
    expect(parsed.mode).toBe("single");
  });

  test("rejects code before the first marker", () => {
    const result = parsePassSource(`void mainImage(out vec4 c, in vec2 p) {}
//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}`);
    expect(result.ok).toBe(false);
  });

  test("allows a comment-only header before the first marker", () => {
    const parsed = parseOk(`// Title: my shader
/* license
   header */
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.mode).toBe("multipass");
    expect(parsed.passes.map((pass) => pass.name)).toEqual(["Image"]);
  });

  test("rejects multipass without Image", () => {
    const result = parsePassSource(`//---- Buffer A ----
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.message).toContain("Image");
  });

  test("rejects duplicate sections", () => {
    const result = parsePassSource(`//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}
//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}`);
    expect(result.ok).toBe(false);
  });

  test("rejects empty sections", () => {
    const result = parsePassSource(`//---- Buffer A ----

//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}`);
    expect(result.ok).toBe(false);
  });

  test("rejects invalid bindings", () => {
    const result = parsePassSource(`//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}
//---- Bindings ----
Image.iChannel0 = BufferB`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.message).toContain("BufferB");
  });

  test("rejects Image as a channel target", () => {
    const result = parsePassSource(`//---- Buffer A ----
void mainImage(out vec4 c, in vec2 p) {}
//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}
//---- Bindings ----
BufferA.iChannel0 = Image`);
    expect(result.ok).toBe(false);
  });

  test("parses Volume A and Image A markers with bindings", () => {
    const parsed = parseOk(`//==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(v, 1.0); }
//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, vec3(p, 0.5)); }
//==== Image A ====
void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }
//==== Bindings ====
BufferA.iChannel0 = VolumeA
ImageA.iChannel0 = BufferA`);
    expect(parsed.mode).toBe("multipass");
    expect(parsed.displayPass).toBe("ImageA");
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "VolumeA",
      "BufferA",
      "ImageA",
    ]);
    expect(parsed.bindings.BufferA?.[0]).toBe("VolumeA");
    expect(parsed.bindings.ImageA?.[0]).toBe("BufferA");
  });

  test("orders Volume A-D before Buffer A-D before Image A-D before Image", () => {
    const parsed = parseOk(`//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image B ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Volume B ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }
//==== Image A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }`);
    expect(parsed.displayPass).toBe("Image");
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "VolumeA",
      "VolumeB",
      "BufferA",
      "ImageA",
      "ImageB",
      "Image",
    ]);
  });

  test("falls back to the last Image A-D when Image is missing", () => {
    const parsed = parseOk(`//==== Buffer A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image C ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.displayPass).toBe("ImageC");
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "BufferA",
      "ImageA",
      "ImageC",
    ]);
  });

  test("accepts spaced Volume / Image A markers and @pass aliases", () => {
    const parsed = parseOk(`// ==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }
// @pass Image A
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }`);
    expect(parsed.passes.map((pass) => pass.name)).toEqual([
      "VolumeA",
      "ImageA",
    ]);
    expect(parsed.displayPass).toBe("ImageA");
  });

  test("parses volume size bindings and validates the range", () => {
    const parsed = parseOk(`//==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Bindings ====
VolumeA.size = 64`);
    expect(parsed.volumeSizes.VolumeA).toBe(64);

    const tooBig = parsePassSource(`//==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Bindings ====
VolumeA.size = 512`);
    expect(tooBig.ok).toBe(false);
  });

  test("rejects volume size for a missing pass", () => {
    const result = parsePassSource(`//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Bindings ====
VolumeA.size = 64`);
    expect(result.ok).toBe(false);
  });

  test("rejects multipass with only volumes and no display pass", () => {
    const result = parsePassSource(`//==== Volume A ====
void mainVolume(out vec4 o, vec3 v) { o = vec4(1.0); }`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.message).toContain("Image");
  });

  test("allows Image A-D as channel targets but not Image", () => {
    const parsed = parseOk(`//==== Image A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Bindings ====
Image.iChannel0 = ImageA`);
    expect(parsed.bindings.Image?.[0]).toBe("ImageA");

    const bad = parsePassSource(`//==== Image A ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Image ====
void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }
//==== Bindings ====
ImageA.iChannel0 = Image`);
    expect(bad.ok).toBe(false);
  });
});
