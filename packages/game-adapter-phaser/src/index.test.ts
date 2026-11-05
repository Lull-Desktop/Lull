import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPhaserGameAdapter,
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
    state: { energy: 1 },
    revision: 3,
    simulationTimeMs: 30,
  },
): Fixture {
  const viewport = { width: 800, height: 600, dpr: 2 };
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

function phaserGame() {
  return {
    scale: { resize: vi.fn() },
    loop: { sleep: vi.fn(), wake: vi.fn() },
    destroy: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("phaser game adapter", () => {
  test("creates the game with the LULL viewport and applies snapshots", async () => {
    const data = fixture();
    const game = phaserGame();
    const create = vi.fn(async () => game);
    const applySnapshot = vi.fn();
    const adapter = createPhaserGameAdapter({
      game: data.game,
      create,
      applySnapshot,
      pollMs: 0,
    });

    await adapter.start();

    expect(create).toHaveBeenCalledWith({ width: 800, height: 600, dpr: 2 });
    expect(applySnapshot).toHaveBeenCalledWith(
      game,
      expect.objectContaining({ revision: 3 }),
    );
    expect(adapter.running).toBe(true);
    expect(adapter.engine).toBe(game);
    adapter.destroy();
  });

  test("sleeps on suspend and wakes on resume", async () => {
    const data = fixture();
    const game = phaserGame();
    const adapter = createPhaserGameAdapter({
      game: data.game,
      create: () => game,
      pollMs: 0,
    });
    await adapter.start();

    data.emitLifecycle({ state: "suspended" });
    expect(game.loop.sleep).toHaveBeenCalledTimes(1);
    expect(adapter.running).toBe(false);

    data.emitLifecycle({ state: "resumed" });
    expect(game.loop.wake).toHaveBeenCalledTimes(1);
    expect(adapter.running).toBe(true);

    data.emitLifecycle({ state: "failed" });
    expect(game.loop.sleep).toHaveBeenCalledTimes(2);
    adapter.destroy();
  });

  test("resizes when the render viewport changes", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const game = phaserGame();
    const adapter = createPhaserGameAdapter({
      game: data.game,
      create: () => game,
    });
    await adapter.start();
    expect(game.scale.resize).not.toHaveBeenCalled();

    data.viewport.width = 1920;
    data.viewport.height = 1080;
    data.viewport.dpr = 1.5;
    vi.advanceTimersByTime(600);

    expect(game.scale.resize).toHaveBeenCalledWith(1920, 1080);
    adapter.destroy();
  });

  test("dedupes repeated snapshots and forwards render state", async () => {
    const data = fixture();
    const game = phaserGame();
    const applySnapshot = vi.fn();
    const applyRenderState = vi.fn();
    const adapter = createPhaserGameAdapter({
      game: data.game,
      create: () => game,
      applySnapshot,
      applyRenderState,
      pollMs: 0,
    });
    await adapter.start();
    expect(applySnapshot).toHaveBeenCalledTimes(1);

    data.emitSnapshot({ state: {}, revision: 3, simulationTimeMs: 30 });
    expect(applySnapshot).toHaveBeenCalledTimes(1);

    data.emitSnapshot({ state: {}, revision: 4, simulationTimeMs: 40 });
    expect(applySnapshot).toHaveBeenCalledTimes(2);

    data.emitRender({ fps: 60 });
    expect(applyRenderState).toHaveBeenCalledWith(game, { fps: 60 });
    adapter.destroy();
  });

  test("destroy unsubscribes, destroys the game and survives create failure", async () => {
    const data = fixture();
    const game = phaserGame();
    const adapter = createPhaserGameAdapter({
      game: data.game,
      create: () => game,
      pollMs: 0,
    });
    await adapter.start();
    adapter.destroy();

    expect(data.unsubscribed()).toBe(3);
    expect(game.destroy).toHaveBeenCalledWith(true);
    expect(adapter.running).toBe(false);
    expect(adapter.engine).toBeNull();

    const onError = vi.fn();
    const failing = createPhaserGameAdapter({
      game: data.game,
      create: () => {
        throw new Error("webgl unavailable");
      },
      onError,
      pollMs: 0,
    });
    await failing.start();
    expect(onError).toHaveBeenCalled();
    expect(failing.running).toBe(false);
    failing.destroy();
  });
});
