import { beforeEach, describe, expect, test, vi } from "vitest";
import { type CanvasGameSource, createCanvasGameRenderer } from "./index.js";

type Snapshot = {
  state: unknown;
  revision: number;
  simulationTimeMs: number;
};

let rafCallback: ((timestamp: number) => void) | null = null;

function installRaf(): void {
  rafCallback = null;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafCallback = callback as (timestamp: number) => void;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    rafCallback = null;
  }) as typeof cancelAnimationFrame;
}

function canvasWithContext(): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

function source(
  initial: Snapshot = {
    state: { water: 1 },
    revision: 1,
    simulationTimeMs: 10,
  },
): {
  game: CanvasGameSource;
  emitSnapshot(snapshot: Snapshot): void;
  emitRender(state: unknown): void;
  emitLifecycle(state: string): void;
  unsubscribed(): number;
} {
  let snapshotListener: ((snapshot: Snapshot) => void) | null = null;
  let renderListener: ((state: unknown) => void) | null = null;
  let lifecycleListener: ((event: { state: string }) => void) | null = null;
  let unsubscribes = 0;
  return {
    game: {
      render: { viewport: { width: 800, height: 600, dpr: 2 } },
      getSnapshot: async () => initial,
      onSnapshot(listener) {
        snapshotListener = listener;
        return () => {
          unsubscribes += 1;
        };
      },
      onRenderState(listener) {
        renderListener = listener;
        return () => {
          unsubscribes += 1;
        };
      },
      onLifecycle(listener) {
        lifecycleListener = listener;
        return () => {
          unsubscribes += 1;
        };
      },
    },
    emitSnapshot(snapshot) {
      snapshotListener?.(snapshot);
    },
    emitRender(state) {
      renderListener?.(state);
    },
    emitLifecycle(state) {
      lifecycleListener?.({ state });
    },
    unsubscribed() {
      return unsubscribes;
    },
  };
}

beforeEach(() => {
  installRaf();
});

describe("canvas game adapter", () => {
  test("sizes backing store by viewport dpr and draws snapshots", async () => {
    const { canvas, context } = canvasWithContext();
    const fake = source();
    const draw = vi.fn();
    const renderer = createCanvasGameRenderer({
      canvas,
      game: fake.game,
      draw,
    });

    renderer.start();
    await Promise.resolve();
    rafCallback?.(0);
    fake.emitSnapshot({
      state: { water: 2 },
      revision: 2,
      simulationTimeMs: 20,
    });
    rafCallback?.(100);

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(draw).toHaveBeenCalled();
    const last = draw.mock.calls.at(-1)?.[0] as {
      state: unknown;
      revision: number;
      width: number;
    };
    expect(last.state).toEqual({ water: 2 });
    expect(last.revision).toBe(2);
    expect(last.width).toBe(800);
    renderer.destroy();
  });

  test("stops drawing while suspended and resumes on resumed", async () => {
    const { canvas } = canvasWithContext();
    const fake = source();
    const draw = vi.fn();
    const renderer = createCanvasGameRenderer({
      canvas,
      game: fake.game,
      draw,
    });
    renderer.start();
    await Promise.resolve();
    rafCallback?.(100);
    const before = draw.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    fake.emitLifecycle("suspended");
    rafCallback?.(100);
    expect(draw.mock.calls.length).toBe(before);
    expect(renderer.running).toBe(false);

    fake.emitLifecycle("resumed");
    rafCallback?.(200);
    expect(draw.mock.calls.length).toBeGreaterThan(before);
    expect(renderer.running).toBe(true);
    renderer.destroy();
  });

  test("destroy unsubscribes and ignores later frames", async () => {
    const { canvas } = canvasWithContext();
    const fake = source();
    const draw = vi.fn();
    const renderer = createCanvasGameRenderer({
      canvas,
      game: fake.game,
      draw,
    });
    renderer.start();
    await Promise.resolve();
    rafCallback?.(0);
    const drawn = draw.mock.calls.length;
    renderer.destroy();
    expect(fake.unsubscribed()).toBe(3);
    rafCallback?.(100);
    expect(draw.mock.calls.length).toBe(drawn);
  });

  test("clamps maxFps and rejects missing context", () => {
    const { canvas } = canvasWithContext();
    const fake = source();
    const renderer = createCanvasGameRenderer({
      canvas,
      game: fake.game,
      draw: vi.fn(),
      maxFps: 1000,
    });
    expect(renderer.running).toBe(false);
    renderer.destroy();

    const noContext = {
      width: 1,
      height: 1,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(() =>
      createCanvasGameRenderer({
        canvas: noContext,
        game: fake.game,
        draw: vi.fn(),
      }),
    ).toThrow(/Canvas2D/);
  });
});
