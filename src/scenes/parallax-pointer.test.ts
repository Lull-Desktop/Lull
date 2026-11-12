/**
 * Parallax.js（community.parallax-js）适配层指针门控的回归测试。
 *
 * 宿主 30Hz 采样器把同一份桌面坐标发给每扇壁纸窗
 * （src-tauri/src/wallpaper/pointer.rs），顶层页面换算成本屏本地坐标并标记
 * `inside`（见 pointerForFrame）。适配层必须与 Triangles & Light 一样只转发
 * `inside && moving` 的样本，否则复制模式下两屏视差会跟着同一个鼠标一起漂移。
 *
 * 测试放在宿主测试树：extensions/bundled 是预构建包，构建会把包内整棵目录
 * 原样复制进发布产物，测试文件不能进包。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenePointer } from "@/sdk/scene";

const hooks = vi.hoisted(() => ({
  pointer: [] as Array<(pointer: ScenePointer) => void>,
  visibility: [] as Array<(visible: boolean) => void>,
}));

vi.mock(
  "../../extensions/bundled/parallax-js/scenes/parallax-js/vendor/scene-sdk/index.js",
  () => ({
    connectLullScene: async () => ({
      onPointer(listener: (pointer: ScenePointer) => void) {
        hooks.pointer.push(listener);
        return () => {};
      },
      onVisibility(listener: (visible: boolean) => void) {
        hooks.visibility.push(listener);
        return () => {};
      },
    }),
  }),
);

function sample(overrides: Partial<ScenePointer> = {}): ScenePointer {
  return { x: 120, y: 80, inside: true, moving: true, ...overrides };
}

describe("Parallax.js 适配层：只响应本屏鼠标", () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  let feed: (pointer: ScenePointer) => void;
  let setVisible: (visible: boolean) => void;

  beforeAll(async () => {
    await import(
      "../../extensions/bundled/parallax-js/scenes/parallax-js/main.js"
    );
    feed = hooks.pointer[0];
    setVisible = hooks.visibility[0];
  });

  beforeEach(() => {
    dispatch.mockClear();
    setVisible(true);
  });

  it("inside && moving 的样本转发为合成 mousemove，坐标为本屏本地 CSS 像素", () => {
    feed(sample({ x: 123.5, y: 456 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]?.[0] as MouseEvent;
    expect(event.type).toBe("mousemove");
    expect(event.clientX).toBe(123.5);
    expect(event.clientY).toBe(456);
  });

  it("光标在另一屏（inside=false）的样本不转发", () => {
    feed(sample({ x: -2000, y: 300, inside: false }));
    feed(sample({ x: 4000, y: 300, inside: false }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("静止样本（moving=false）不转发", () => {
    feed(sample({ moving: false }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("光标离开本屏后视差停在最后位置（与 Triangles & Light 光斑一致）", () => {
    feed(sample({ x: 10, y: 20 }));
    feed(sample({ x: 2500, y: 20, inside: false }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]?.[0] as MouseEvent;
    expect(event.clientX).toBe(10);
    expect(event.clientY).toBe(20);
  });

  it("壁纸隐藏时不转发，恢复可见后继续", () => {
    setVisible(false);
    feed(sample());
    expect(dispatch).not.toHaveBeenCalled();
    setVisible(true);
    feed(sample());
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
