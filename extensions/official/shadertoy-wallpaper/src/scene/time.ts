/**
 * Shader 时间源（RFC §7.3）。
 *
 * 精度约束：`iTime` 是 float32 uniform。若把「自某个固定日期起的墙钟秒」直接
 * 传进去，量级到 1e7 秒以上时 ulp 已经是秒级，动画会变成台阶式跳变。
 *
 * 语义：
 * - sync 开启（mirror 同步 / span）：使用「本地当日 00:00 起的秒数」。
 *   所有窗口共享同一相位，量级 ≤ 86400 秒、ulp ≈ 8ms。跨本地午夜时相位回卷
 *   一次（已知限制，见 README）；暂停时长会从相位里扣除，跨午夜暂停也不会
 *   出现负时间。
 * - sync 关闭（independent）：从 0 起单调累计，暂停冻结、恢复不跳变。
 */
import type { SceneSync } from "@lull/scene-sdk";

export type ClockFrame = {
  time: number;
  delta: number;
  frame: number;
  frameRate: number;
};

export type ShaderClock = {
  /** 新 Program 生效：独立模式归零，同步模式回到当前墙钟相位。 */
  restart(): void;
  setSync(enabled: boolean): void;
  setPaused(paused: boolean): void;
  /** 每个渲染帧调用一次。 */
  tick(): ClockFrame;
  /** 读取最近一帧的时间值（暂停时按需重绘用）。 */
  peek(): ClockFrame;
};

export type ShaderClockOptions = {
  now?: () => number;
  perfNow?: () => number;
};

const DAY_SECONDS = 86_400;

function midnightMs(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function syncEnabled(sync: SceneSync | undefined): boolean {
  return sync?.enabled === true;
}

export function createShaderClock(
  options: ShaderClockOptions = {},
): ShaderClock {
  const now = options.now ?? (() => Date.now());
  const perfNow = options.perfNow ?? (() => performance.now());

  let synced = false;
  let paused = false;
  let pauseStartedAtMs = 0;
  let pausedSeconds = 0;
  let elapsedSeconds = 0;
  let lastPerfMs: number | null = null;
  let frames = 0;
  let frameRate = 0;
  let cached: ClockFrame = { time: 0, delta: 0, frame: 0, frameRate: 0 };

  const wallSeconds = (): number => {
    const current = now();
    return (current - midnightMs(current)) / 1000;
  };

  const sharedPhase = (): number => {
    const value = (wallSeconds() - pausedSeconds) % DAY_SECONDS;
    return value < 0 ? value + DAY_SECONDS : value;
  };

  const currentTime = (): number => (synced ? sharedPhase() : elapsedSeconds);

  const refresh = (advance: boolean): ClockFrame => {
    // 暂停期间即使被误调用也不能推进时间（同步模式的墙钟相位会随真实时间前进）。
    if (paused) {
      cached = { ...cached, delta: 0 };
      return cached;
    }
    let delta = 0;
    if (advance) {
      const perf = perfNow();
      if (lastPerfMs !== null) {
        delta = Math.min(0.5, Math.max(0, (perf - lastPerfMs) / 1000));
        if (delta > 0) {
          const instant = 1 / delta;
          frameRate =
            frameRate === 0 ? instant : frameRate * 0.9 + instant * 0.1;
          elapsedSeconds += delta;
        }
      }
      lastPerfMs = perf;
      frames += 1;
    }
    cached = {
      time: currentTime(),
      delta,
      frame: frames,
      frameRate,
    };
    return cached;
  };

  return {
    restart() {
      pausedSeconds = 0;
      elapsedSeconds = 0;
      frames = 0;
      frameRate = 0;
      lastPerfMs = null;
      if (paused) pauseStartedAtMs = now();
      cached = {
        time: currentTime(),
        delta: 0,
        frame: 0,
        frameRate: 0,
      };
    },
    setSync(enabled) {
      if (enabled === synced) return;
      if (enabled) {
        synced = true;
        pausedSeconds = 0;
        if (paused) pauseStartedAtMs = now();
      } else {
        elapsedSeconds = sharedPhase();
        synced = false;
      }
      lastPerfMs = null;
      cached = { time: currentTime(), delta: 0, frame: frames, frameRate };
    },
    setPaused(next) {
      if (next === paused) return;
      if (next) {
        paused = true;
        pauseStartedAtMs = now();
        return;
      }
      paused = false;
      const pausedFor = Math.max(0, (now() - pauseStartedAtMs) / 1000);
      if (synced) pausedSeconds += pausedFor;
      lastPerfMs = null;
    },
    tick() {
      return refresh(true);
    },
    peek() {
      return cached;
    },
  };
}
