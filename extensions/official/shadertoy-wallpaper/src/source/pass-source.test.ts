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

  test("rejects code before the first marker", () => {
    const result = parsePassSource(`void mainImage(out vec4 c, in vec2 p) {}
//---- Image ----
void mainImage(out vec4 c, in vec2 p) {}`);
    expect(result.ok).toBe(false);
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
});
