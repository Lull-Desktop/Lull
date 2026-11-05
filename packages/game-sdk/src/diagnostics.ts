/**
 * 运行时稳定性探针（P3 报告工具）。
 *
 * 在隐藏 Authority / Replica 页面里 start()，定期采样帧率、长帧、WebGL
 * context lost/restored、页面可见性与（Chromium）JS 堆；stop() 后 summary()
 * 得到可直接写入报告的 JSON。
 *
 * 探针只观测，不修改游戏状态、不发命令、不接管 canvas。
 */

export type PerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
};

export type StabilitySample = {
  atMs: number;
  fps: number;
  longFrames: number;
  usedHeapBytes: number | null;
};

export type StabilitySummary = {
  elapsedMs: number;
  frames: number;
  avgFrameMs: number;
  worstFrameMs: number;
  longFrames: number;
  contextLost: number;
  contextRestored: number;
  visibilityChanges: number;
  hiddenMs: number;
  memoryGrowthBytes: number | null;
  samples: StabilitySample[];
};

export type StabilityProbeOptions = {
  /** 有 canvas 时监听 webglcontextlost / webglcontextrestored。 */
  canvas?: HTMLCanvasElement | null;
  /** 采样间隔，默认 1000ms。 */
  sampleIntervalMs?: number;
  /** 超过该帧间隔记为长帧，默认 50ms。 */
  longFrameMs?: number;
  /** 最多保留的采样条数，默认 600。 */
  maxSamples?: number;
  /** 测试注入；默认 performance.now()。 */
  now?: () => number;
  /** 测试注入；默认读取 (performance as any).memory。 */
  readMemory?: () => PerformanceMemory | null;
  /** 测试注入。 */
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (handle: number) => void;
};

export type StabilityProbe = {
  start(): void;
  stop(): void;
  summary(): StabilitySummary;
  reset(): void;
};

function defaultMemory(): PerformanceMemory | null {
  const memory = (
    globalThis.performance as Performance & {
      memory?: PerformanceMemory;
    }
  ).memory;
  if (!memory) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
  };
}

export function createStabilityProbe(
  options: StabilityProbeOptions = {},
): StabilityProbe {
  const now = options.now ?? (() => performance.now());
  const requestFrame =
    options.requestFrame ??
    (typeof requestAnimationFrame === "function"
      ? requestAnimationFrame.bind(globalThis)
      : null);
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame.bind(globalThis)
      : null);
  const sampleIntervalMs = Math.max(100, options.sampleIntervalMs ?? 1_000);
  const longFrameMs = Math.max(16, options.longFrameMs ?? 50);
  const maxSamples = Math.max(10, options.maxSamples ?? 600);
  const readMemory = options.readMemory ?? defaultMemory;

  let started = false;
  let frameHandle: number | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  let frames = 0;
  let frameCount = 0;
  let frameSum = 0;
  let worstFrameMs = 0;
  let longFrames = 0;
  let lastFrameAt: number | null = null;
  let contextLost = 0;
  let contextRestored = 0;
  let visibilityChanges = 0;
  let hiddenSince: number | null = null;
  let hiddenMs = 0;
  let firstHeap: number | null = null;
  let lastHeap: number | null = null;
  const samples: StabilitySample[] = [];
  let lastSampleAt = 0;
  let lastSampleFrames = 0;
  const cleanups: Array<() => void> = [];

  const onFrame = (timestamp: number): void => {
    frameHandle = null;
    if (!started) return;
    frames += 1;
    if (lastFrameAt !== null) {
      const delta = timestamp - lastFrameAt;
      if (delta > 0) {
        frameCount += 1;
        frameSum += delta;
        worstFrameMs = Math.max(worstFrameMs, delta);
        if (delta > longFrameMs) longFrames += 1;
      }
    }
    lastFrameAt = timestamp;
    if (requestFrame) frameHandle = requestFrame(onFrame);
  };

  const sample = (): void => {
    if (!started) return;
    const atMs = now();
    const elapsed = atMs - lastSampleAt;
    const deltaFrames = frames - lastSampleFrames;
    const fps =
      elapsed > 0 ? Math.round((deltaFrames * 1000 * 10) / elapsed) / 10 : 0;
    lastSampleAt = atMs;
    lastSampleFrames = frames;
    const memory = readMemory();
    if (memory) {
      if (firstHeap === null) firstHeap = memory.usedJSHeapSize;
      lastHeap = memory.usedJSHeapSize;
    }
    samples.push({
      atMs,
      fps,
      longFrames,
      usedHeapBytes: memory?.usedJSHeapSize ?? null,
    });
    if (samples.length > maxSamples)
      samples.splice(0, samples.length - maxSamples);
  };

  const start = (): void => {
    if (started) return;
    started = true;
    startedAt = now();
    lastSampleAt = startedAt;
    lastSampleFrames = 0;
    if (requestFrame) frameHandle = requestFrame(onFrame);
    sampleTimer = setInterval(sample, sampleIntervalMs);

    const canvas = options.canvas;
    if (canvas) {
      const onLost = (): void => {
        contextLost += 1;
      };
      const onRestored = (): void => {
        contextRestored += 1;
      };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
      cleanups.push(() => {
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
      });
    }

    if (typeof document !== "undefined") {
      const onVisibility = (): void => {
        visibilityChanges += 1;
        if (document.visibilityState === "hidden") {
          hiddenSince = now();
        } else if (hiddenSince !== null) {
          hiddenMs += now() - hiddenSince;
          hiddenSince = null;
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() =>
        document.removeEventListener("visibilitychange", onVisibility),
      );
    }
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    if (frameHandle !== null && cancelFrame) cancelFrame(frameHandle);
    frameHandle = null;
    if (sampleTimer !== null) clearInterval(sampleTimer);
    sampleTimer = null;
    if (hiddenSince !== null) {
      hiddenMs += now() - hiddenSince;
      hiddenSince = null;
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
  };

  const summary = (): StabilitySummary => {
    return {
      elapsedMs: startedAt === 0 ? 0 : Math.max(0, now() - startedAt),
      frames,
      avgFrameMs:
        frameCount === 0 ? 0 : Math.round((frameSum / frameCount) * 100) / 100,
      worstFrameMs: Math.round(worstFrameMs * 100) / 100,
      longFrames,
      contextLost,
      contextRestored,
      visibilityChanges,
      hiddenMs,
      memoryGrowthBytes:
        firstHeap !== null && lastHeap !== null ? lastHeap - firstHeap : null,
      samples: samples.map((item) => ({ ...item })),
    };
  };

  const reset = (): void => {
    frames = 0;
    frameCount = 0;
    frameSum = 0;
    worstFrameMs = 0;
    longFrames = 0;
    lastFrameAt = null;
    contextLost = 0;
    contextRestored = 0;
    visibilityChanges = 0;
    hiddenMs = 0;
    firstHeap = null;
    lastHeap = null;
    samples.length = 0;
    startedAt = started ? now() : 0;
    lastSampleAt = startedAt;
    lastSampleFrames = 0;
  };

  return { start, stop, summary, reset };
}
