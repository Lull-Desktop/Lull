/**
 * 渲染循环：单一 rAF、暂停/恢复、暂停时按需重绘一帧。
 *
 * 不创建第二套计时器；时间推进由 `scene/time.ts` 负责。
 */

export type RenderLoop = {
  start(): void;
  stop(): void;
  /** 暂停状态下请求重绘一帧（尺寸/参数变化时使用）。 */
  requestFrame(): void;
  readonly running: boolean;
  dispose(): void;
};

export type RenderLoopOptions = {
  onFrame: (timestamp: number) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const request =
    options.requestAnimationFrame ??
    ((callback: FrameRequestCallback) =>
      window.requestAnimationFrame(callback));
  const cancel =
    options.cancelAnimationFrame ??
    ((handle: number) => window.cancelAnimationFrame(handle));

  let handle: number | null = null;
  let running = false;
  let disposed = false;

  const schedule = (): void => {
    if (disposed || handle !== null) return;
    handle = request((timestamp) => {
      handle = null;
      if (disposed) return;
      options.onFrame(timestamp);
      if (running) schedule();
    });
  };

  return {
    start() {
      if (disposed || running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
    requestFrame() {
      if (disposed || running) return;
      schedule();
    },
    get running() {
      return running;
    },
    dispose() {
      disposed = true;
      running = false;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
  };
}
