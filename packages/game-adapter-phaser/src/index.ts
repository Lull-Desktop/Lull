/**
 * Phaser 渲染适配器（P4）。
 *
 * 零运行时依赖：Phaser 由游戏包自己 import 并打包，宿主不加载本包。
 * 适配器只做三件事：
 * - 用 LULL 的渲染几何创建游戏，并在显示器几何/DPI 变化时同步 Scale Manager；
 * - 把宿主生命周期（suspended/stopped/failed → 暂停，resumed/running → 恢复）
 *   映射到 Phaser 的 `game.loop.sleep()/wake()`；
 * - 把只读快照 / 渲染态分发给 `applySnapshot` / `applyRenderState`。
 *
 * 它不写权威状态、不发命令、不碰窗口。
 */

export type EngineViewport = {
  width: number;
  height: number;
  dpr: number;
};

export type EngineSnapshot = {
  state: unknown;
  revision: number;
  simulationTimeMs: number;
};

export type EngineLifecycleEvent = {
  state: string;
  reason?: string;
  offlineMs?: number;
};

/**
 * 只读游戏来源。`@lull/game-sdk/scene` 的 `LullGameRenderClient` 直接满足该结构。
 * 约定：`onSnapshot` 在订阅时回放当前快照（SDK 行为），适配器会按 revision 去重。
 */
export type EngineGameSource = {
  readonly render: {
    viewport: EngineViewport;
  } | null;
  getSnapshot(): Promise<EngineSnapshot | null>;
  onSnapshot(listener: (snapshot: EngineSnapshot) => void): () => void;
  onRenderState(listener: (state: unknown) => void): () => void;
  onLifecycle(listener: (event: EngineLifecycleEvent) => void): () => void;
};

/** 适配器实际用到的 Phaser.Game 结构；不引入 Phaser 类型依赖。 */
export type PhaserGameLike = {
  scale: {
    resize(width: number, height: number): void;
  };
  loop: {
    sleep(): void;
    wake(): void;
  };
  destroy(removeCanvas?: boolean, noReturn?: boolean): void;
};

export type PhaserAdapterOptions<T extends PhaserGameLike> = {
  /** 只读游戏来源，通常是 `await connectLullGameRender()`。 */
  game: EngineGameSource;
  /**
   * 创建 Phaser.Game。示例：
   * `({ width, height }) => new Phaser.Game({ type: Phaser.AUTO, parent: "stage", width, height, scene: [...] })`
   */
  create: (context: {
    width: number;
    height: number;
    dpr: number;
  }) => T | Promise<T>;
  applySnapshot?: (engine: T, snapshot: EngineSnapshot) => void;
  applyRenderState?: (engine: T, renderState: unknown) => void;
  /** 默认 `engine.loop.sleep()`。 */
  pause?: (engine: T) => void;
  /** 默认 `engine.loop.wake()`。 */
  resume?: (engine: T) => void;
  /** 默认 `engine.scale.resize(width, height)`；Phaser 3 以 CSS 像素为基准。 */
  resize?: (engine: T, viewport: EngineViewport) => void;
  /** 默认 `engine.destroy(true)`。 */
  destroy?: (engine: T) => void;
  onError?: (error: unknown) => void;
  /** 视口变化轮询间隔，默认 500ms；传 0 关闭。 */
  pollMs?: number;
};

export type PhaserAdapter<T extends PhaserGameLike> = {
  start(): Promise<void>;
  destroy(): void;
  readonly running: boolean;
  readonly engine: T | null;
};

const PAUSED_STATES = new Set(["suspended", "stopped", "failed"]);
const DEFAULT_POLL_MS = 500;

function report(error: unknown, onError?: (error: unknown) => void): void {
  if (onError) {
    onError(error);
    return;
  }
  console.error("[lull/phaser] adapter error", error);
}

function readViewport(game: EngineGameSource): EngineViewport {
  const viewport = game.render?.viewport;
  const dpr =
    viewport && Number.isFinite(viewport.dpr) && viewport.dpr > 0
      ? viewport.dpr
      : (globalThis.devicePixelRatio ?? 1);
  const width = viewport && viewport.width > 0 ? viewport.width : 1;
  const height = viewport && viewport.height > 0 ? viewport.height : 1;
  return { width, height, dpr };
}

function sameViewport(left: EngineViewport, right: EngineViewport): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.dpr === right.dpr
  );
}

export function createPhaserGameAdapter<T extends PhaserGameLike>(
  options: PhaserAdapterOptions<T>,
): PhaserAdapter<T> {
  const { game } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  let engine: T | null = null;
  let started = false;
  let destroyed = false;
  let paused = false;
  let lastRevision = -1;
  let applied: EngineViewport | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const unsubscribers: Array<() => void> = [];

  const fail = (error: unknown): void => report(error, options.onError);

  const syncViewport = (): void => {
    if (!engine || destroyed) return;
    const viewport = readViewport(game);
    if (applied && sameViewport(applied, viewport)) return;
    applied = viewport;
    try {
      if (options.resize) {
        options.resize(engine, viewport);
      } else {
        engine.scale.resize(
          Math.max(1, Math.round(viewport.width)),
          Math.max(1, Math.round(viewport.height)),
        );
      }
    } catch (error) {
      fail(error);
    }
  };

  const applySnapshot = (snapshot: EngineSnapshot): void => {
    if (!engine || destroyed) return;
    if (snapshot.revision <= lastRevision) return;
    lastRevision = snapshot.revision;
    try {
      options.applySnapshot?.(engine, snapshot);
    } catch (error) {
      fail(error);
    }
  };

  const applyLifecycle = (event: EngineLifecycleEvent): void => {
    if (!engine || destroyed) return;
    if (PAUSED_STATES.has(event.state)) {
      paused = true;
      try {
        if (options.pause) options.pause(engine);
        else engine.loop.sleep();
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (!paused) return;
    paused = false;
    try {
      if (options.resume) options.resume(engine);
      else engine.loop.wake();
    } catch (error) {
      fail(error);
    }
  };

  const start = async (): Promise<void> => {
    if (started || destroyed) return;
    started = true;
    applied = readViewport(game);
    let created: T;
    try {
      created = await Promise.resolve(options.create({ ...applied }));
    } catch (error) {
      started = false;
      fail(error);
      return;
    }
    if (destroyed) {
      try {
        created.destroy(true);
      } catch {
        // 已在销毁流程中，忽略二次销毁异常。
      }
      return;
    }
    engine = created;
    unsubscribers.push(
      game.onSnapshot((snapshot) => applySnapshot(snapshot)),
      game.onRenderState((state) => {
        if (!engine || destroyed) return;
        try {
          options.applyRenderState?.(engine, state);
        } catch (error) {
          fail(error);
        }
      }),
      game.onLifecycle((event) => applyLifecycle(event)),
    );
    if (paused) {
      try {
        if (options.pause) options.pause(created);
        else created.loop.sleep();
      } catch (error) {
        fail(error);
      }
    }
    const initial = await game.getSnapshot().catch(() => null);
    if (initial) applySnapshot(initial);
    if (pollMs > 0 && !destroyed) {
      timer = setInterval(() => syncViewport(), pollMs);
    }
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    started = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        fail(error);
      }
    }
    const current = engine;
    engine = null;
    if (!current) return;
    try {
      if (options.destroy) options.destroy(current);
      else current.destroy(true);
    } catch (error) {
      fail(error);
    }
  };

  return {
    start,
    destroy,
    get running() {
      return started && !paused && !destroyed && engine !== null;
    },
    get engine() {
      return engine;
    },
  };
}
