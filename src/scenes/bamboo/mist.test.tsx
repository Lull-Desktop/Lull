/**
 * 竹影的「雾浓度」参数：0 = 无雾、1 = 最浓，必须肉眼可辨。
 * 这条用例同时锁住「参数确实进到渲染」和「两端差异足够大」。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { SceneProps } from "@/sdk/scene";
import { BambooScene } from "./index";

function props(mist: number): SceneProps {
  return {
    mode: "mirror",
    layout: "viewport",
    sync: { enabled: false, epochMs: 0 },
    viewport: { w: 1920, h: 1080, dpr: 1 },
    canvas: null,
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    dpr: 1,
    params: { mist },
    reducedMotion: false,
    performance: null,
  } as unknown as SceneProps;
}

function opacityOf(element: HTMLElement): number {
  return Number(element.style.opacity);
}

describe("BambooScene 雾浓度", () => {
  test("mist=0 时不画雾层", () => {
    render(<BambooScene {...props(0)} />);

    expect(opacityOf(screen.getByTestId("bamboo-mist-veil"))).toBe(0);
    expect(opacityOf(screen.getByTestId("bamboo-mist-band-54"))).toBe(0);
  });

  test("mist=1 时雾层显著可见", () => {
    render(<BambooScene {...props(1)} />);

    expect(opacityOf(screen.getByTestId("bamboo-mist-veil"))).toBeGreaterThan(
      0.5,
    );
    expect(
      opacityOf(screen.getByTestId("bamboo-mist-band-54")),
    ).toBeGreaterThan(0.4);
  });

  test("中间值单调递增，且越界值被夹到 [0,1]", () => {
    const first = render(<BambooScene {...props(0.5)} />);
    const half = opacityOf(screen.getByTestId("bamboo-mist-veil"));
    first.unmount();

    const second = render(<BambooScene {...props(2)} />);
    const over = opacityOf(screen.getByTestId("bamboo-mist-veil"));
    expect(over).toBeCloseTo(0.62, 5);
    second.unmount();

    render(<BambooScene {...props(-1)} />);
    expect(opacityOf(screen.getByTestId("bamboo-mist-veil"))).toBe(0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(over);
  });
});
