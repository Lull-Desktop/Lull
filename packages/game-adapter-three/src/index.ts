/**
 * Three.js 渲染适配器（P4）。
 *
 * 零运行时依赖：Three.js 由游戏包自己 import 并打包，宿主不加载本包。
 * 与 Phaser / PixiJS 不同，Three.js 没有自带的主循环，所以适配器负责：
 * - 用 LULL 的渲染几何设置 `renderer.setSize` 与 `setPixelRatio`，
 *   并在显示器几何/DPI 变化时同步；
 * - 用 requestAnimationFrame 驱动 `renderer.render(scene, camera)`，按 `maxFps` 节流；
 * - 把宿主生命周期映射为"暂停/恢复循环"；
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

/** 适配器实际用到的 `THREE.WebGLRenderer` 结构；不引入 Three.js 类型依赖。 */
export type ThreeRendererLike = {
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio?(ratio: number): void;
  render(scene: object, camera: object): void;
  dispose(): void;
};

export type ThreeEngineLike = {
  renderer: ThreeRendererLike;
  scene: object;
  camera: object;
};

export type ThreeAdapterOptions<T extends ThreeEngineLike> = {
  /** 只读游戏来源，通常是 `await connectLullGameRender()`。 */
  game: EngineGameSource;
  /** 创建 renderer / scene / camera。 */
  create: (context: {
    width: number;
    height: number;
    dpr: number;
  }) => T | Promise<T>;
  applySnapshot?: (engine: T, snapshot: EngineSnapshot) => void;
  applyRenderState?: (engine: T, renderState: unknown) => void;
  /** 每帧在 render 之前调用（推进动画、更新 uniform）。 */
  onFrame?: (engine: T, timestamp: number) => void;
  /** 覆盖默认的 `engine.renderer.render(engine.scene, engine.camera)`。 */
  render?: (engine: T, timestamp: number) => void;
  /** 默认 `engine.renderer.dispose()`。 */
  destroy?: (engine: T) => void;
  /** 帧率上限，默认 30；clamp 1..=120。 */
  maxFps?: number;
  onError?: (error: unknown) => void;
};

export type ThreeAdapter<T extends ThreeEngineLike> = {
  start(): Promise<void>;
  destroy(): void;
  readonly running: boolean;
  readonly engine: T | null;
};

const PAUSED_STATES = new Set(["suspended", "stopped", "failed"]);
const DEFAULT_MAX_FPS = 30;

function clampFps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FPS;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function report(error: unknown, onError?: (error: unknown) => void): void {
  if (onError) {
    onError(error);
    return;
  }
  console.error("[lull/three] adapter error", error);
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

export function createThreeGameAdapter<T extends ThreeEngineLike>(
  options: ThreeAdapterOptions<T>,
): ThreeAdapter<T> {
  const { game } = options;
  const maxFps = clampFps(options.maxFps);
  const frameInterval = 1000 / maxFps;

  let engine: T | null = null;
  let started = false;
  let destroyed = false;
  let paused = false;
  let lastRevision = -1;
  let applied: EngineViewport | null = null;
  let frameId: number | null = null;
  let lastFrameAt = Number.NEGATIVE_INFINITY;
  const unsubscribers: Array<() => void> = [];

  const fail = (error: unknown): void => report(error, options.onError);

  const syncViewport = (target: T): void => {
    const viewport = readViewport(game);
    if (applied && sameViewport(applied, viewport)) return;
    applied = viewport;
    try {
      target.renderer.setPixelRatio?.(viewport.dpr);
      target.renderer.setSize(
        Math.max(1, Math.round(viewport.width)),
        Math.max(1, Math.round(viewport.height)),
        false,
      );
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
    if (destroyed) return;
    if (PAUSED_STATES.has(event.state)) {
      paused = true;
      stopLoop();
      return;
    }
    if (!paused) return;
    paused = false;
    lastFrameAt = 0;
    schedule();
  };

  const stopLoop = (): void => {
    if (frameId === null) return;
    if (typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(frameId);
    frameId = null;
  };

  const schedule = (): void => {
    if (!started || destroyed || paused || engine === null) return;
    if (frameId !== null) return;
    if (typeof requestAnimationFrame !== "function") return;
    frameId = requestAnimationFrame(paint);
  };

  const paint = (timestamp: number): void => {
    frameId = null;
    if (!started || destroyed || paused || !engine) return;
    if (timestamp - lastFrameAt < frameInterval) {
      schedule();
      return;
    }
    lastFrameAt = timestamp;
    syncViewport(engine);
    try {
      options.onFrame?.(engine, timestamp);
      if (options.render) options.render(engine, timestamp);
      else engine.renderer.render(engine.scene, engine.camera);
    } catch (error) {
      // 渲染连续失败时停帧，避免刷屏；恢复由上层重建/重连处理。
      paused = true;
      fail(error);
      return;
    }
    schedule();
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
        created.renderer.dispose();
      } catch {
        // 已在销毁流程中，忽略二次销毁异常。
      }
      return;
    }
    engine = created;
    applied = null;
    syncViewport(created);
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
    const initial = await game.getSnapshot().catch(() => null);
    if (initial) applySnapshot(initial);
    schedule();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    started = false;
    stopLoop();
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
      else current.renderer.dispose();
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
