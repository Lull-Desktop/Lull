import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPixiGameAdapter,
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
    state: { level: 0.4 },
    revision: 2,
    simulationTimeMs: 20,
  },
): Fixture {
  const viewport = { width: 1024, height: 768, dpr: 1 };
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

function pixiApp() {
  return {
    renderer: { resize: vi.fn() },
    ticker: { start: vi.fn(), stop: vi.fn() },
    destroy: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pixi game adapter", () => {
  test("accepts an async application factory and applies snapshots", async () => {
    const data = fixture();
    const app = pixiApp();
    const create = vi.fn(async () => {
      await Promise.resolve();
      return app;
    });
    const applySnapshot = vi.fn();
    const adapter = createPixiGameAdapter({
      game: data.game,
      create,
      applySnapshot,
      pollMs: 0,
    });

    await adapter.start();

    expect(create).toHaveBeenCalledWith({ width: 1024, height: 768, dpr: 1 });
    expect(applySnapshot).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ revision: 2 }),
    );
    expect(adapter.running).toBe(true);
    adapter.destroy();
  });

  test("stops the ticker while suspended and restarts it on resume", async () => {
    const data = fixture();
    const app = pixiApp();
    const adapter = createPixiGameAdapter({
      game: data.game,
      create: () => app,
      pollMs: 0,
    });
    await adapter.start();

    data.emitLifecycle({ state: "suspended" });
    expect(app.ticker.stop).toHaveBeenCalledTimes(1);
    data.emitLifecycle({ state: "running" });
    expect(app.ticker.start).toHaveBeenCalledTimes(1);
    expect(adapter.running).toBe(true);
    adapter.destroy();
  });

  test("resizes the renderer with the device pixel ratio", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const app = pixiApp();
    const adapter = createPixiGameAdapter({
      game: data.game,
      create: () => app,
    });
    await adapter.start();

    data.viewport.width = 2048;
    data.viewport.height = 1152;
    data.viewport.dpr = 2;
    vi.advanceTimersByTime(600);

    expect(app.renderer.resize).toHaveBeenCalledWith(2048, 1152, 2);
    adapter.destroy();
  });

  test("destroys the application and ignores snapshots after destroy", async () => {
    const data = fixture();
    const app = pixiApp();
    const applySnapshot = vi.fn();
    const adapter = createPixiGameAdapter({
      game: data.game,
      create: () => app,
      applySnapshot,
      pollMs: 0,
    });
    await adapter.start();
    const applied = applySnapshot.mock.calls.length;
    adapter.destroy();
    data.emitSnapshot({ state: {}, revision: 9, simulationTimeMs: 90 });

    expect(applySnapshot.mock.calls.length).toBe(applied);
    expect(data.unsubscribed()).toBe(3);
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.engine).toBeNull();
  });

  test("reports create failures without starting", async () => {
    const data = fixture();
    const onError = vi.fn();
    const adapter = createPixiGameAdapter({
      game: data.game,
      create: async () => {
        throw new Error("webgl context lost during init");
      },
      onError,
      pollMs: 0,
    });
    await adapter.start();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(adapter.running).toBe(false);
    adapter.destroy();
  });
});
