import { describe, expect, test } from "vitest";
import { createShaderRenderer } from "../runtime/renderer";
import { createFakeContext, createFakeGl } from "../testing/fake-gl";
import { DEFAULT_SHADER_NAME, DEFAULT_SHADER_SOURCE } from "./default-source";

describe("default shader", () => {
  test("bundles the fixture source into the scene", () => {
    expect(DEFAULT_SHADER_NAME).toBe("The Drive Home");
    expect(DEFAULT_SHADER_SOURCE).toContain("void mainImage(");
    // 宿主的 `source` 参数上限 128 KiB；内置示例必须远小于它。
    expect(DEFAULT_SHADER_SOURCE.length).toBeLessThan(128 * 1024);
  });

  test("is a Shadertoy Image profile without pass markers", () => {
    // 单 Pass 直达 Image；出现分节标记会让解析器把它当成多 Pass。
    expect(DEFAULT_SHADER_SOURCE).not.toMatch(
      /^\/\/\s*[=*#+~-]+\s*(Common|Image|Buffer|Volume)/m,
    );

    expect(DEFAULT_SHADER_SOURCE).not.toContain("@pass");
  });

  test("loads as a single Image pass on WebGL1 and WebGL2", () => {
    for (const version of [1, 2] as const) {
      const fake = createFakeGl({});
      const renderer = createShaderRenderer({
        canvas: { width: 640, height: 360 } as HTMLCanvasElement,
        context: createFakeContext(fake.gl, { version }),
      });
      const result = renderer.load(DEFAULT_SHADER_SOURCE);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.passes).toEqual(["Image"]);
      // 默认示例不采样任何外部输入，因此不会触发占位通道提示。
      expect(result.channels).toEqual([]);
    }
  });
});
