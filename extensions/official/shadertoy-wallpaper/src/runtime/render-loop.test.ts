import { describe, expect, test, vi } from "vitest";
import { createRenderLoop } from "./render-loop";

function setup() {
  const queue: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  let nextId = 1;
  const onFrame = vi.fn();
  const loop = createRenderLoop({
    onFrame,
    requestAnimationFrame: (callback) => {
      queue.push(callback);
      return nextId++;
    },
    cancelAnimationFrame: (handle) => {
      cancelled.push(handle);
    },
  });
  return { loop, queue, cancelled, onFrame };
}

describe("createRenderLoop", () => {
  test("keeps rescheduling while running and cancels on stop", () => {
    const { loop, queue, cancelled, onFrame } = setup();
    loop.start();
    expect(loop.running).toBe(true);
    expect(queue).toHaveLength(1);

    queue.shift()?.(0);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);

    loop.stop();
    expect(loop.running).toBe(false);
    expect(cancelled).toHaveLength(1);
  });

  test("requestFrame draws exactly one frame when stopped", () => {
    const { loop, queue, onFrame } = setup();
    loop.requestFrame();
    expect(queue).toHaveLength(1);
    queue.shift()?.(0);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0);
  });

  test("requestFrame is a no-op while running", () => {
    const { loop, queue } = setup();
    loop.start();
    loop.requestFrame();
    expect(queue).toHaveLength(1);
  });

  test("dispose prevents further scheduling", () => {
    const { loop, queue } = setup();
    loop.dispose();
    loop.start();
    loop.requestFrame();
    expect(queue).toHaveLength(0);
    expect(loop.running).toBe(false);
  });
});
