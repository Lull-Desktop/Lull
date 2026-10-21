/**
 * Vitest 全局测试环境：补齐 jsdom 缺失的浏览器 API，并清理每个用例的渲染结果。
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

// Radix Select 在 jsdom 的最小桩：scrollIntoView 未实现（调用即抛），pointer capture 系列同理。
(
  Element.prototype as unknown as { scrollIntoView: () => void }
).scrollIntoView = () => {};
(
  HTMLElement.prototype as unknown as {
    hasPointerCapture: (id: number) => boolean;
  }
).hasPointerCapture = () => false;
(
  HTMLElement.prototype as unknown as {
    setPointerCapture: (id: number) => void;
  }
).setPointerCapture = () => {};
(
  HTMLElement.prototype as unknown as {
    releasePointerCapture: (id: number) => void;
  }
).releasePointerCapture = () => {};

// vitest 未开 globals，testing-library 不会自动清理——显式卸载，避免测试间 DOM 残留。
afterEach(() => {
  cleanup();
});
