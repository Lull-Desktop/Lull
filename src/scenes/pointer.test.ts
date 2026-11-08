import { describe, expect, test } from "vitest";
import type { SceneFrame } from "@/sdk/scene";
import {
  type DesktopPointerSample,
  isDesktopPointerSample,
  pointerForFrame,
} from "./pointer";

function frame(overrides: Partial<SceneFrame> = {}): SceneFrame {
  return {
    mode: "mirror",
    layout: "viewport",
    sync: { enabled: false, epochMs: 0 },
    viewport: { w: 1920, h: 1080, dpr: 1 },
    canvas: null,
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    dpr: 1,
    params: {},
    reducedMotion: false,
    performance: null,
    ...overrides,
  };
}

function sample(
  overrides: Partial<DesktopPointerSample> = {},
): DesktopPointerSample {
  return { x: 100, y: 200, overDesktop: true, moving: true, ...overrides };
}

describe("桌面坐标 → 场景本地坐标", () => {
  test("viewport 布局以本屏左上角为原点", () => {
    expect(pointerForFrame(frame(), sample())).toEqual({
      x: 100,
      y: 200,
      inside: true,
      moving: true,
    });
  });

  test("按 dpr 换算为 CSS 像素", () => {
    const pointer = pointerForFrame(
      frame({
        viewport: { w: 1280, h: 720, dpr: 1.5 },
        view: { x: 0, y: 0, w: 1920, h: 1080 },
        dpr: 1.5,
      }),
      sample({ x: 300, y: 450 }),
    );
    expect(pointer).toEqual({ x: 200, y: 300, inside: true, moving: true });
  });

  test("支持负坐标的副屏矩形", () => {
    const pointer = pointerForFrame(
      frame({ view: { x: -2560, y: 0, w: 2560, h: 1440 } }),
      sample({ x: -2500, y: 100 }),
    );
    expect(pointer).toEqual({ x: 60, y: 100, inside: true, moving: true });
  });

  test("span 画布以 canvas 原点换算，其他屏上的画布点也算 inside", () => {
    const canvasFrame = frame({
      mode: "span",
      layout: "canvas",
      canvas: { x: -2560, y: 0, w: 4480, h: 1440 },
      viewport: { w: 4480, h: 1440, dpr: 1 },
      view: { x: 0, y: 0, w: 1920, h: 1080 },
    });
    expect(pointerForFrame(canvasFrame, sample({ x: 0, y: 100 }))).toEqual({
      x: 2560,
      y: 100,
      inside: true,
      moving: true,
    });
  });

  test("光标不在桌面层时 inside/moving 都为 false", () => {
    expect(
      pointerForFrame(frame(), sample({ overDesktop: false, moving: true })),
    ).toEqual({ x: 100, y: 200, inside: false, moving: false });
  });

  test("落在视口外时 inside=false，但坐标保留供淡出使用", () => {
    expect(pointerForFrame(frame(), sample({ x: 2000, y: 100 }))).toEqual({
      x: 2000,
      y: 100,
      inside: false,
      moving: true,
    });
  });

  test("缺少几何信息时丢弃样本", () => {
    expect(pointerForFrame(frame({ view: null, canvas: null }), sample())).toBe(
      null,
    );
  });
});

describe("Tauri 事件载荷校验", () => {
  test("接受完整样本", () => {
    expect(isDesktopPointerSample(sample())).toBe(true);
  });

  test("拒绝缺字段、NaN 与非布尔状态", () => {
    expect(isDesktopPointerSample(null)).toBe(false);
    expect(isDesktopPointerSample({ x: 1, y: 2, overDesktop: true })).toBe(
      false,
    );
    expect(
      isDesktopPointerSample({
        x: Number.NaN,
        y: 2,
        overDesktop: true,
        moving: true,
      }),
    ).toBe(false);
    expect(
      isDesktopPointerSample({
        x: 1,
        y: 2,
        overDesktop: true,
        moving: "yes",
      }),
    ).toBe(false);
  });
});
