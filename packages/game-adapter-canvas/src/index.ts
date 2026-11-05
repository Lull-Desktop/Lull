/**
 * Canvas2D 渲染适配器（P4）。
 *
 * 输入是 `@lull/game-sdk/scene` 提供的只读客户端；这里不依赖具体 SDK 类型，
 * 用结构化类型接收 `render` / `getSnapshot` / `onSnapshot` / `onRenderState` /
 * `onLifecycle`，方便测试与第三方引擎适配器复用。
 *
 * 适配器只负责：
 * - 按渲染上下文的 viewport/dpr 设置 canvas backing store；
 * - 用 requestAnimationFrame 驱动绘制并节流到 maxFps；
 * - 在 suspended/stopped/failed 时停帧，resumed/running/background 时恢复；
 * - 把最新 snapshot/renderState 交给 draw 回调。
 *
 * 它不写状态、不发命令、不创建窗口。
 */

export type CanvasViewport = {
  width: number;
  height: number;
  dpr: number;
};

export type CanvasGameSource = {
  readonly render: {
    viewport: CanvasViewport;
  } | null;
  getSnapshot(): Promise<{
    state: unknown;
    revision: number;
    simulationTimeMs: number;
  } | null>;
  onSnapshot(
    listener: (snapshot: {
      state: unknown;
      revision: number;
      simulationTimeMs: number;
    }) => void,
  ): () => void;
  onRenderState(listener: (state: unknown) => void): () => void;
  onLifecycle(listener: (event: { state: string }) => void): () => void;
};

export type CanvasGameFrame = {
  context: CanvasRenderingContext2D;
  /** CSS 像素尺寸；canvas.width/height 已按 dpr 放大。 */
  width: number;
  height: number;
  dpr: number;
  state: unknown;
  renderState: unknown;
  revision: number;
  simulationTimeMs: number;
  /** requestAnimationFrame 时间戳。 */
  timestamp: number;
};

export type CanvasGameRendererOptions = {
  canvas: HTMLCanvasElement;
  game: CanvasGameSource;
  draw: (frame: CanvasGameFrame) => void;
  /** 绘制上限，默认 30；clamp 1..=120。 */
  maxFps?: number;
  /** 每帧是否先 clearRect，默认 true。 */
  clear?: boolean;
  contextAttributes?: CanvasRenderingContext2DSettings;
};

export type CanvasGameRenderer = {
  start(): void;
  stop(): void;
  destroy(): void;
  readonly running: boolean;
  /** 请求一帧（事件驱动的即时重绘）；需先 start，不会启动循环。 */
  requestFrame(): void;
};

const DEFAULT_MAX_FPS = 30;

function clampFps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FPS;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function isPausedState(state: string): boolean {
  return state === "suspended" || state === "stopped" || state === "failed";
}

export function createCanvasGameRenderer(
  options: CanvasGameRendererOptions,
): CanvasGameRenderer {
  const { canvas, game, draw } = options;
  const context = canvas.getContext(
    "2d",
    options.contextAttributes,
  ) as CanvasRenderingContext2D | null;
  if (!context) {
    throw new Error("Canvas2D 上下文不可用");
  }

  const maxFps = clampFps(options.maxFps);
  const frameInterval = 1000 / maxFps;
  let frameId: number | null = null;
  let lastFrameAt = 0;
  let started = false;
  let subscribed = false;
  let destroyed = false;
  let paused = false;
  let state: unknown = null;
  let renderState: unknown = null;
  let revision = 0;
  let simulationTimeMs = 0;
  const unsubscribers: Array<() => void> = [];

  const applyViewport = (): void => {
    const viewport = game.render?.viewport;
    const dpr =
      viewport && Number.isFinite(viewport.dpr) && viewport.dpr > 0
        ? viewport.dpr
        : (globalThis.devicePixelRatio ?? 1);
    const width =
      viewport && viewport.width > 0
        ? viewport.width
        : canvas.clientWidth || canvas.width || 1;
    const height =
      viewport && viewport.height > 0
        ? viewport.height
        : canvas.clientHeight || canvas.height || 1;
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const paint = (timestamp: number): void => {
    frameId = null;
    if (!started || destroyed || paused) return;
    if (timestamp - lastFrameAt < frameInterval) {
      schedule();
      return;
    }
    lastFrameAt = timestamp;
    applyViewport();
    const viewport = game.render?.viewport;
    const width =
      viewport && viewport.width > 0
        ? viewport.width
        : canvas.clientWidth || canvas.width || 1;
    const height =
      viewport && viewport.height > 0
        ? viewport.height
        : canvas.clientHeight || canvas.height || 1;
    if (options.clear !== false) {
      context.clearRect(0, 0, width, height);
    }
    draw({
      context,
      width,
      height,
      dpr: viewport?.dpr ?? globalThis.devicePixelRatio ?? 1,
      state,
      renderState,
      revision,
      simulationTimeMs,
      timestamp,
    });
    schedule();
  };

  const schedule = (): void => {
    if (!started || destroyed || paused || frameId !== null) return;
    if (typeof requestAnimationFrame !== "function") return;
    frameId = requestAnimationFrame(paint);
  };

  const applySnapshot = (snapshot: {
    state: unknown;
    revision: number;
    simulationTimeMs: number;
  }): void => {
    state = snapshot.state;
    revision = snapshot.revision;
    simulationTimeMs = snapshot.simulationTimeMs;
    requestFrame();
  };

  const applyLifecycle = (event: { state: string }): void => {
    if (event.state === "stopped" || event.state === "failed") {
      paused = true;
      stopLoop();
      return;
    }
    if (isPausedState(event.state)) {
      paused = true;
      stopLoop();
      return;
    }
    if (paused) {
      paused = false;
      lastFrameAt = 0;
      schedule();
    }
  };

  const stopLoop = (): void => {
    if (frameId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
      frameId = null;
    }
  };

  const start = (): void => {
    if (started || destroyed) return;
    started = true;
    paused = false;
    if (!subscribed) {
      subscribed = true;
      unsubscribers.push(
        game.onSnapshot((snapshot) => applySnapshot(snapshot)),
        game.onRenderState((next) => {
          renderState = next;
          requestFrame();
        }),
        game.onLifecycle((event) => applyLifecycle(event)),
      );
      void game.getSnapshot().then((snapshot) => {
        if (snapshot && !destroyed) applySnapshot(snapshot);
      });
    }
    schedule();
  };

  const stop = (): void => {
    started = false;
    stopLoop();
  };

  const requestFrame = (): void => {
    if (destroyed || paused || !started) return;
    if (frameId === null) schedule();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    started = false;
    subscribed = false;
    stopLoop();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };

  return {
    start,
    stop,
    destroy,
    requestFrame,
    get running() {
      return started && !paused && !destroyed;
    },
  };
}
