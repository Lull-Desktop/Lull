/**
 * 壁纸参数测试：覆盖哈希解析、同步规则与跨屏坐标变换。
 */
import { expect, test } from "vitest";
import {
  canvasTransform,
  DEFAULT_PARAMS,
  DEFAULT_SCENE_ID,
  parseWallpaperParams,
  resolveSync,
} from "./params";

test("parses full span hash with negative canvas coords", () => {
  const p = parseWallpaperParams(
    "#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=0,0,1920,1080",
  );
  expect(p).toEqual({
    mode: "span",
    sync: true,
    scene: "lull.bamboo",
    canvas: { x: -2560, y: 0, w: 4480, h: 1440 },
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    params: {},
  });
  expect(DEFAULT_PARAMS.scene).toBe(DEFAULT_SCENE_ID);
});

test("empty or garbage hash falls back to defaults without crashing", () => {
  expect(parseWallpaperParams("")).toEqual(DEFAULT_PARAMS);
  expect(parseWallpaperParams("#canvas=garbage&mode=SPAN")).toEqual(
    DEFAULT_PARAMS,
  );
  const partial = parseWallpaperParams("#mode=span&canvas=1,2,3"); // 非 4 元组
  expect(partial.mode).toBe("span");
  expect(partial.canvas).toBeNull();
});

test("duplicate keys last-wins, scene trimmed", () => {
  const p = parseWallpaperParams("#scene=lull.aurora&scene=%20lull.bamboo%20");
  expect(p.scene).toBe("lull.bamboo");
  const q = parseWallpaperParams("#sync=0&sync=1");
  expect(q.sync).toBe(true);
});

test("resolveSync forces true only for span", () => {
  expect(resolveSync("span", false)).toBe(true);
  expect(resolveSync("mirror", false)).toBe(false);
  // spec §6.3：independent 恒不同步（各自以加载时刻起跑），与配置无关。
  expect(resolveSync("independent", true)).toBe(false);
});

test("canvasTransform numbers across dpr values and single-screen span", () => {
  const canvas = { x: -2560, y: 0, w: 4480, h: 1440 };
  // view 在桌面 (0,0)：相对画布原点偏移 +2560 → 容器左移 -2560 才对齐本屏区域。
  expect(canvasTransform(canvas, { x: 0, y: 0, w: 1920, h: 1080 }, 1)).toEqual({
    width: 4480,
    height: 1440,
    left: -2560,
    top: 0,
  });
  expect(
    canvasTransform(canvas, { x: -2560, y: 0, w: 2560, h: 1440 }, 1.25),
  ).toEqual({
    width: 3584,
    height: 1152,
    left: 0,
    top: 0,
  });
  expect(
    canvasTransform(
      { x: 0, y: 0, w: 1920, h: 1080 },
      { x: 0, y: 0, w: 1920, h: 1080 },
      1.5,
    ),
  ).toEqual({
    width: 1280,
    height: 720,
    left: 0,
    top: 0,
  });
});

test("parses percent-encoded scene params and ignores non-string values", () => {
  const params = JSON.stringify({ density: "0.6", enabled: "true", bad: 3 });
  const p = parseWallpaperParams(
    `#scene=lull.bamboo&params=${encodeURIComponent(params)}`,
  );
  expect(p.params).toEqual({ density: "0.6", enabled: "true" });
});

test("invalid params payload falls back to empty object", () => {
  expect(parseWallpaperParams("#params=%7Bbad")?.params).toEqual({});
  expect(parseWallpaperParams("#params=%5B1%2C2%5D")?.params).toEqual({});
});
