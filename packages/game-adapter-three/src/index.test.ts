import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createThreeGameAdapter,
  type EngineGameSource,
  type EngineLifecycleEvent,
  type EngineSnapshot,
} from "./index.js";

type Fixture = {
  game: EngineGameSource;
  viewport: { width: number; height: number; dpr: number };
  emitSnapshot(snapshot: EngineSnapshot): void;
  emitRender(state: unknown): void;
  emitLifecycle(event: EngineLifecycleEvent): void;
  unsubscribed(): number;
};

function fixture(
  initial: EngineSnapshot = {
    state: { drift: 0.2 },
    revision: 5,
    simulationTimeMs: 50,
  },
): Fixture {
  const viewport = { width: 640, height: 480, dpr: 2 };
  let snapshotListener: ((snapshot: EngineSnapshot) => void) | null = null;
  let renderListener: ((state: unknown) => void) | null = null;
  let lifecycleListener: ((event: EngineLifecycleEvent) => void) | null = null;
  let unsubscribes = 0;
  const game: EngineGameSource = {
    get render() {
      return { viewport };
    },
    getSnapshot: async () => initial,
    onSnapshot(listener) {
      snapshotListener = listener;
      listener(initial);
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
  };
  return {
    game,
    viewport,
    emitSnapshot(snapshot) {
      snapshotListener?.(snapshot);
    },
    emitRender(state) {
      renderListener?.(state);
    },
    emitLifecycle(event) {
      lifecycleListener?.(event);
    },
    unsubscribed() {
      return unsubscribes;
    },
  };
}

function threeEngine() {
  return {
    renderer: {
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    },
    scene: { name: "scene" },
    camera: { name: "camera" },
  };
}

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

function frame(timestamp: number): void {
  const callback = rafCallback;
  rafCallback = null;
  callback?.(timestamp);
}

beforeEach(() => {
  installRaf();
});

describe("three game adapter", () => {
  test("drives the renderer with the LULL viewport and snapshot", async () => {
    const data = fixture();
    const engine = threeEngine();
    const create = vi.fn(() => engine);
    const applySnapshot = vi.fn();
    const adapter = createThreeGameAdapter({
      game: data.game,
      create,
      applySnapshot,
    });

    await adapter.start();
    frame(100);

    expect(create).toHaveBeenCalledWith({ width: 640, height: 480, dpr: 2 });
    expect(engine.renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(engine.renderer.setSize).toHaveBeenCalledWith(640, 480, false);
    expect(engine.renderer.render).toHaveBeenCalledWith(
      engine.scene,
      engine.camera,
    );
    expect(applySnapshot).toHaveBeenCalledWith(
      engine,
      expect.objectContaining({ revision: 5 }),
    );
    expect(adapter.running).toBe(true);
    adapter.destroy();
  });

  test("pauses the loop on suspend and resumes on resume", async () => {
    const data = fixture();
    const engine = threeEngine();
    const adapter = createThreeGameAdapter({
      game: data.game,
      create: () => engine,
    });
    await adapter.start();
    frame(100);
    const drawn = engine.renderer.render.mock.calls.length;

    data.emitLifecycle({ state: "suspended" });
    expect(adapter.running).toBe(false);
    frame(200);
    expect(engine.renderer.render.mock.calls.length).toBe(drawn);

    data.emitLifecycle({ state: "resumed" });
    expect(adapter.running).toBe(true);
    frame(300);
    expect(engine.renderer.render.mock.calls.length).toBeGreaterThan(drawn);
    adapter.destroy();
  });

  test("throttles frames to maxFps and updates the size on viewport changes", async () => {
    const data = fixture();
    const engine = threeEngine();
    const adapter = createThreeGameAdapter({
      game: data.game,
      create: () => engine,
      maxFps: 10,
    });
    await adapter.start();
    frame(100);
    frame(150);
    expect(engine.renderer.render).toHaveBeenCalledTimes(1);
    frame(250);
    expect(engine.renderer.render).toHaveBeenCalledTimes(2);

    data.viewport.width = 800;
    data.viewport.height = 600;
    data.viewport.dpr = 1.5;
    frame(400);
    expect(engine.renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(engine.renderer.setSize).toHaveBeenLastCalledWith(800, 600, false);
    adapter.destroy();
  });

  test("runs the onFrame hook before rendering", async () => {
    const data = fixture();
    const engine = threeEngine();
    const order: string[] = [];
    const adapter = createThreeGameAdapter({
      game: data.game,
      create: () => engine,
      onFrame: () => {
        order.push("frame");
      },
      render: () => {
        order.push("render");
      },
    });
    await adapter.start();
    frame(100);

    expect(order).toEqual(["frame", "render"]);
    adapter.destroy();
  });

  test("stops the loop and disposes the renderer on destroy", async () => {
    const data = fixture();
    const engine = threeEngine();
    const adapter = createThreeGameAdapter({
      game: data.game,
      create: () => engine,
    });
    await adapter.start();
    frame(100);
    adapter.destroy();

    expect(data.unsubscribed()).toBe(3);
    expect(engine.renderer.dispose).toHaveBeenCalledTimes(1);
    expect(rafCallback).toBeNull();
    expect(adapter.engine).toBeNull();
  });

  test("stops rendering after a render error", async () => {
    const data = fixture();
    const engine = threeEngine();
    engine.renderer.render.mockImplementation(() => {
      throw new Error("gl lost");
    });
    const onError = vi.fn();
    const adapter = createThreeGameAdapter({
      game: data.game,
      create: () => engine,
      onError,
    });
    await adapter.start();
    frame(100);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(adapter.running).toBe(false);
    adapter.destroy();
  });
});
