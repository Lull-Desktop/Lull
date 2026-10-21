/**
 * 液态番茄钟的纯计时模型：阶段轮转、时长刻度换算、周期珍珠状态。
 * 这里不碰 DOM / 计时器 / 存储，方便在单元测试里直接验证轮转规则。
 */

/** 一个完整番茄循环里的专注轮数，对应底部 4 颗珍珠微光珠。 */
export const CYCLE_BEADS = 4;

/** 专注时长可调范围（分钟）。外圈刻度盘与滚轮共用这两个边界。 */
export const FOCUS_MIN_MINUTES = 5;
export const FOCUS_MAX_MINUTES = 60;

export const DEFAULT_FOCUS_MINUTES = 25;
export const DEFAULT_SHORT_BREAK_MINUTES = 5;
export const DEFAULT_LONG_BREAK_MINUTES = 15;

/** 专注 / 短休 / 长休。长休只在完成第 4 颗珍珠后出现。 */
export type Phase = "focus" | "shortBreak" | "longBreak";

/** 右侧两张弹出卡片的语义：专注与休息（休息卡会自动指向短休或长休）。 */
export type PhaseCard = "focus" | "break";

export type TimerPrefs = {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
};

/** 一颗周期珍珠的视觉状态：已注满 / 正在注能 / 空心。 */
export type BeadState = "full" | "charging" | "empty";

/** 把数值收进 5–60 分钟并取整；NaN 退回默认专注时长。 */
export function clampFocusMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FOCUS_MINUTES;
  return Math.min(
    FOCUS_MAX_MINUTES,
    Math.max(FOCUS_MIN_MINUTES, Math.round(value)),
  );
}

/** 秒数 → `MM:SS`，向上取整保证 25:00 在开始时完整显示。 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

/** 当前阶段的完整秒数。 */
export function phaseSeconds(phase: Phase, prefs: TimerPrefs): number {
  if (phase === "focus") return clampFocusMinutes(prefs.focusMinutes) * 60;
  if (phase === "shortBreak") {
    return Math.max(1, Math.round(prefs.shortBreakMinutes)) * 60;
  }
  return Math.max(1, Math.round(prefs.longBreakMinutes)) * 60;
}

/** 当前阶段的展示名。 */
export function phaseLabel(phase: Phase): string {
  if (phase === "focus") return "专注";
  if (phase === "longBreak") return "长休";
  return "短休";
}

/**
 * 一个阶段结束后的轮转：
 * - 专注结束 → 完成数 +1；第 4 次专注后进入长休，否则短休；
 * - 短休结束 → 回到专注，完成数不变；
 * - 长休结束 → 清空本轮 4 颗珍珠，回到专注。
 */
export function advancePhase(
  phase: Phase,
  completedFocus: number,
): { phase: Phase; completedFocus: number } {
  if (phase === "focus") {
    const done = Math.min(CYCLE_BEADS, completedFocus + 1);
    return {
      phase: done >= CYCLE_BEADS ? "longBreak" : "shortBreak",
      completedFocus: done,
    };
  }
  if (phase === "longBreak") {
    return { phase: "focus", completedFocus: 0 };
  }
  return { phase: "focus", completedFocus };
}

/** 手动切换卡片时该进入哪个阶段；完成 4 轮后休息卡指向长休。 */
export function phaseForCard(card: PhaseCard, completedFocus: number): Phase {
  if (card === "focus") return "focus";
  return completedFocus >= CYCLE_BEADS ? "longBreak" : "shortBreak";
}

/** 指针相对球心的角度：12 点方向为 0°，顺时针 0–360°。 */
export function dialAngleAt(
  centerX: number,
  centerY: number,
  pointX: number,
  pointY: number,
): number {
  const radians = Math.atan2(pointY - centerY, pointX - centerX);
  return (radians * 180) / Math.PI + 90 + 360;
}

export function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** 圆盘角度 → 分钟。整圈对应 60 分钟，12 点即 60 分，最小值收到 5 分。 */
export function minutesForDialAngle(angle: number): number {
  return clampFocusMinutes((normalizeAngle(angle) / 360) * 60);
}

/** 分钟 → 圆盘角度（0–360，从 12 点顺时针）。 */
export function dialAngleForMinutes(minutes: number): number {
  return (clampFocusMinutes(minutes) / 60) * 360;
}

/** 液态球内的液面高度（占球高百分比）。满格保留顶部空腔，数字与玻璃高光才可读。 */
export function liquidFillPercent(
  secondsLeft: number,
  totalSeconds: number,
): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, secondsLeft / totalSeconds));
  return fraction * 64;
}

/** 本轮专注进行到多少（0–1），用于当前珍珠的注能进度。 */
export function focusProgress(
  secondsLeft: number,
  totalSeconds: number,
): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - secondsLeft / totalSeconds));
}

/**
 * 4 颗珍珠各自的状态。
 * 专注中：已完成的是 full，当前那颗 charging，其余 empty；
 * 休息中：已完成的是 full，其余 empty（长休时 4 颗全满）。
 */
export function beadStates(
  completedFocus: number,
  phase: Phase,
  progress: number,
): BeadState[] {
  return Array.from({ length: CYCLE_BEADS }, (_, index) => {
    if (index < completedFocus) return "full";
    if (phase === "focus" && index === completedFocus && progress > 0) {
      return "charging";
    }
    return "empty";
  });
}

/** 单颗珍珠里的液面高度；当前那颗随专注进度缓慢注入。 */
export function beadFillPercent(state: BeadState, progress: number): number {
  if (state === "full") return 100;
  if (state === "charging") return Math.max(6, Math.min(100, progress * 100));
  return 0;
}

/** 当前进行到循环里的第几轮（用于「第 3 / 4 轮」文案）。 */
export function currentRound(completedFocus: number): number {
  return Math.min(CYCLE_BEADS, completedFocus + 1);
}
