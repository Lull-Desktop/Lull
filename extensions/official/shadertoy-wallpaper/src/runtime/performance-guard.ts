/**
 * 性能护栏（RFC §8.5）。
 *
 * WebGL 没有可靠的指令超时机制，因此只能观察帧耗时并逐级降级：
 * 先自动降低有效渲染比例一次，仍然过慢就停止渲染并给出可见状态。
 */

export type GuardLevel = "ok" | "degrade" | "stop";

export type GuardSample = {
  level: GuardLevel;
  averageMs: number;
};

export type PerformanceGuard = {
  sample(deltaSeconds: number): GuardSample;
  reset(): void;
  readonly scaleFactor: number;
};

export type PerformanceGuardOptions = {
  /** 平均帧耗时超过该值时视为偏慢（毫秒）。 */
  warnMs?: number;
  /** 平均帧耗时超过该值时视为不可接受（毫秒）。 */
  stopMs?: number;
  /** 持续偏慢多久后降一档（秒）。 */
  warnAfterSeconds?: number;
  /** 持续过慢多久后停止（秒）。 */
  stopAfterSeconds?: number;
  degradeFactor?: number;
};

export function createPerformanceGuard(
  options: PerformanceGuardOptions = {},
): PerformanceGuard {
  const warnMs = options.warnMs ?? 80;
  const stopMs = options.stopMs ?? 250;
  const warnAfter = options.warnAfterSeconds ?? 2;
  const stopAfter = options.stopAfterSeconds ?? 3;
  const degradeFactor = options.degradeFactor ?? 0.75;

  let averageMs = 0;
  let overWarnSeconds = 0;
  let overStopSeconds = 0;
  let degraded = false;
  let stopped = false;
  let scaleFactor = 1;

  return {
    sample(deltaSeconds) {
      if (stopped) return { level: "stop", averageMs };
      const delta =
        Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
      if (delta > 0) {
        averageMs =
          averageMs === 0 ? delta * 1000 : averageMs * 0.9 + delta * 100;
        overWarnSeconds = averageMs > warnMs ? overWarnSeconds + delta : 0;
        overStopSeconds = averageMs > stopMs ? overStopSeconds + delta : 0;
      }
      if (!degraded && overWarnSeconds >= warnAfter) {
        degraded = true;
        scaleFactor = degradeFactor;
        overWarnSeconds = 0;
        return { level: "degrade", averageMs };
      }
      if (overStopSeconds >= stopAfter) {
        stopped = true;
        return { level: "stop", averageMs };
      }
      return { level: "ok", averageMs };
    },
    reset() {
      averageMs = 0;
      overWarnSeconds = 0;
      overStopSeconds = 0;
      degraded = false;
      stopped = false;
      scaleFactor = 1;
    },
    get scaleFactor() {
      return scaleFactor;
    },
  };
}
