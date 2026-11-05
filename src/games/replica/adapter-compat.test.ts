/**
 * 类型契约：真实的 @lull/game-sdk/scene 客户端必须能直接传给 Canvas 适配器。
 * 这里只做编译期检查，不实际创建 canvas。
 */
import { describe, expect, test } from "vitest";
import type { createCanvasGameRenderer } from "../../../packages/game-adapter-canvas/src/index";
import type { LullGameRenderClient } from "../../../packages/game-sdk/src/scene";

function acceptsGameClient(game: LullGameRenderClient): void {
  const options: Parameters<typeof createCanvasGameRenderer>[0] = {
    canvas: undefined as never,
    game,
    draw: () => {},
  };
  void options;
}

describe("canvas adapter type contract", () => {
  test("accepts LullGameRenderClient", () => {
    expect(typeof acceptsGameClient).toBe("function");
  });
});
