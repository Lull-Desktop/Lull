/**
 * 窗口贴合高度测试：验证「顶栏 + 内容」基准值与最小/最大高度的夹取边界。
 */
import { expect, test } from "vitest";
import { fittedWindowHeight, MIN_WINDOW_HEIGHT, TOPBAR_HEIGHT } from "./fit";

test("窗口高度 = 顶栏 + 内容高度", () => {
  expect(fittedWindowHeight(302, 1080)).toBe(TOPBAR_HEIGHT + 302);
});

test("内容过短时不低于最小高度（避免窗口被压扁）", () => {
  expect(fittedWindowHeight(10, 1080)).toBe(MIN_WINDOW_HEIGHT);
});

test("内容超出屏幕时夹到可用高度上限（窗口内部滚动）", () => {
  expect(fittedWindowHeight(2000, 720)).toBe(720);
});

test("上限低于下限时优先保证最小高度，不产生负区间", () => {
  expect(fittedWindowHeight(2000, 200)).toBe(MIN_WINDOW_HEIGHT);
});
