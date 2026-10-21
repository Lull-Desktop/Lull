/**
 * 滑块回归测试：受控值变化时必须复用同一个拇指节点。
 * 历史 bug：拇指 key 用当前值，拖动中每次值变化都会重建节点，pointer capture 丢失，拖一下就断。
 */
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Slider } from "./slider";

test("受控值变化不会重建滑块拇指（拖动可连续）", () => {
  const { rerender } = render(<Slider value={[10]} />);
  const thumb = document.querySelector('[data-slot="slider-thumb"]');
  expect(thumb).not.toBeNull();

  rerender(<Slider value={[55]} />);
  expect(document.querySelector('[data-slot="slider-thumb"]')).toBe(thumb);
});
