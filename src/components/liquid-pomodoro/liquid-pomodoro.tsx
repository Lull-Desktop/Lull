/**
 * LiquidPomodoro（液态番茄钟）：以太之泡系列的专注计时窗。
 *
 * 左侧是玻璃舱里的 Time Orb：冰蓝液态光能随剩余时间平滑下降，数字从液体里折射出来；
 * 外圈细刻度光轨既是进度环，也是专注时长的圆盘滑杆（拖动 / 滚轮调节）。
 * 右侧两张 Pop-out 卡片切换专注与休息；底部 4 颗珍珠记录一轮 4 个番茄的进度。
 *
 * 阶段结束按「排空 → 脉冲 → 涟漪 → 蜕变」四拍播放，然后才真正切换阶段，
 * 让液体颜色与数字有一次完整的仪式感转场。
 */
"use client";

import {
  Hourglass,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hideWindow,
  isWindowMinimizable,
  minimizeWindow,
  onWindowPrefsChanged,
} from "@/core/window/controls";
import { useFlowTheme } from "@/hooks/use-flow-theme";
import { useWindowFit } from "@/hooks/use-window-fit";
import styles from "./liquid-pomodoro.module.css";
import {
  advancePhase,
  beadFillPercent,
  beadStates,
  clampFocusMinutes,
  currentRound,
  DEFAULT_FOCUS_MINUTES,
  DEFAULT_LONG_BREAK_MINUTES,
  DEFAULT_SHORT_BREAK_MINUTES,
  dialAngleAt,
  dialAngleForMinutes,
  focusProgress,
  formatClock,
  liquidFillPercent,
  minutesForDialAngle,
  type Phase,
  type PhaseCard,
  phaseForCard,
  phaseLabel,
  phaseSeconds,
  type TimerPrefs,
} from "./timer-model";

/** 阶段结束的四拍仪式；null 表示正常计时 / 待机。 */
type Ceremony = "drain" | "pulse" | "ripple" | "transform" | null;

type StoredPrefs = TimerPrefs & {
  autoStart: boolean;
  sound: boolean;
  completedFocus: number;
};

type BeadStyle = CSSProperties & {
  "--bead-fill": string;
};

/** 细刻度数量：120 格 = 每分钟两格，刻度足够细但仍清晰。 */
const TICK_COUNT = 120;
const TICKS = Array.from({ length: TICK_COUNT }, (_, index) => index);
const MOTES = Array.from({ length: 14 }, (_, index) => index);
const BURST = Array.from({ length: 12 }, (_, index) => index);
const CRYSTALS = [
  { x: 24, y: 34 },
  { x: 45, y: 52 },
  { x: 67, y: 40 },
  { x: 33, y: 72 },
  { x: 57, y: 80 },
  { x: 78, y: 63 },
  { x: 15, y: 60 },
] as const;
const BEAD_SLOTS = [1, 2, 3, 4] as const;

const STORAGE_KEY = "lull:pomodoro:v1";

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredPrefs(): Partial<StoredPrefs> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    const stored: Partial<StoredPrefs> = {};
    if (typeof value.focusMinutes === "number") {
      stored.focusMinutes = clampFocusMinutes(value.focusMinutes);
    }
    if (typeof value.shortBreakMinutes === "number") {
      stored.shortBreakMinutes = clampInteger(value.shortBreakMinutes, 1, 30);
    }
    if (typeof value.longBreakMinutes === "number") {
      stored.longBreakMinutes = clampInteger(value.longBreakMinutes, 5, 45);
    }
    if (typeof value.autoStart === "boolean") {
      stored.autoStart = value.autoStart;
    }
    if (typeof value.sound === "boolean") stored.sound = value.sound;
    if (typeof value.completedFocus === "number") {
      stored.completedFocus = clampInteger(value.completedFocus, 0, 4);
    }
    return stored;
  } catch {
    return {};
  }
}

function persistPrefs(prefs: StoredPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用时只影响下次启动的默认值，不影响本次计时。
  }
}

/** 到点提示音：两声清亮短音，需要用户手势阶段提前准备 AudioContext。 */
function playChime(context: AudioContext | null): void {
  if (!context) return;
  if (context.state === "suspended") void context.resume();
  const now = context.currentTime;
  for (const offset of [0, 0.3]) {
    const start = now + offset;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046.5, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.24, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(start);
    osc.stop(start + 0.55);
  }
}

function vibrate(): void {
  try {
    if ("vibrate" in navigator) navigator.vibrate(18);
  } catch {
    // 桌面 WebView 通常没有振动马达，忽略即可。
  }
}

/** 玻璃球里的一层液体；专注与休息各一层，用透明度交叉淡化完成颜色蜕变。 */
function LiquidLayer({ tone }: { tone: "focus" | "break" }) {
  return (
    <span className={styles.liquid} data-tone={tone} aria-hidden="true">
      <span className={styles.liquidDeep} />
      <span className={styles.liquidGlow} />
      <span className={styles.liquidCaustics} />
      <span className={styles.liquidSurface} />
      <span className={styles.liquidSurfaceAlt} />
      <span className={styles.motes}>
        {MOTES.map((index) => (
          <i
            key={`mote-${index}`}
            className={styles.mote}
            style={{ "--mote": index } as CSSProperties}
          />
        ))}
      </span>
      <span className={styles.crystals}>
        {CRYSTALS.map((crystal, index) => (
          <i
            key={`crystal-${crystal.x}-${crystal.y}`}
            className={styles.crystal}
            style={
              {
                "--cx": `${crystal.x}%`,
                "--cy": `${crystal.y}%`,
                "--crystal": index,
              } as CSSProperties
            }
          />
        ))}
      </span>
    </span>
  );
}

function TuningRing({
  progress,
  dialProgress,
  dialing,
}: {
  progress: number;
  dialProgress: number;
  dialing: boolean;
}) {
  const activeTicks = Math.round(progress * TICK_COUNT);
  const dialLength = Math.max(0, Math.min(1, dialProgress)) * 100;
  const dialAngle = dialAngleForMinutes(dialProgress * 60);
  return (
    <svg
      className={styles.ring}
      viewBox="0 0 120 120"
      data-dialing={dialing ? "true" : "false"}
      aria-hidden="true"
    >
      <circle className={styles.ringHalo} cx="60" cy="60" r="58.6" />
      <circle className={styles.ringTrack} cx="60" cy="60" r="52.2" />
      {TICKS.map((index) => {
        const major = index % 10 === 0;
        return (
          <line
            key={`tick-${index}`}
            x1="60"
            y1={major ? 2.6 : 3.6}
            x2="60"
            y2={major ? 6.2 : 5.3}
            transform={`rotate(${(index / TICK_COUNT) * 360} 60 60)`}
            data-major={major ? "true" : "false"}
            className={index < activeTicks ? styles.tickLit : styles.tickDim}
          />
        );
      })}
      <circle
        className={styles.progressTrack}
        cx="60"
        cy="60"
        r="48.6"
        pathLength={100}
      />
      <circle
        className={styles.progressArc}
        cx="60"
        cy="60"
        r="48.6"
        pathLength={100}
        strokeDasharray={`${Math.max(0, Math.min(1, progress)) * 100} 100`}
      />
      <circle
        className={styles.dialTrack}
        cx="60"
        cy="60"
        r="44"
        pathLength={100}
      />
      <circle
        className={styles.dialArc}
        cx="60"
        cy="60"
        r="44"
        pathLength={100}
        strokeDasharray={`${dialLength} 100`}
      />
      <g className={styles.dialKnob} transform={`rotate(${dialAngle} 60 60)`}>
        <circle className={styles.dialKnobHalo} cx="60" cy="16" r="4.6" />
        <circle className={styles.dialKnobCore} cx="60" cy="16" r="2.4" />
      </g>
    </svg>
  );
}

function PearlBeads({
  completed,
  phase,
  progress,
  justLit,
  ceremony,
}: {
  completed: number;
  phase: Phase;
  progress: number;
  justLit: number | null;
  ceremony: Ceremony;
}) {
  const states = beadStates(completed, phase, progress);
  return (
    <div className={styles.beadsBlock}>
      <div className={styles.beadsHead}>
        <span className={styles.beadsLabel}>珍珠微光珠</span>
        <span className={styles.beadsCount}>
          {String(completed).padStart(2, "0")}
          <em>/ 04</em>
        </span>
      </div>
      <div
        className={styles.beads}
        data-ripple={
          ceremony === "ripple" || ceremony === "transform" ? "true" : "false"
        }
        role="img"
        aria-label={`本轮已完成 ${completed} 个番茄，共 4 个`}
      >
        {BEAD_SLOTS.map((slot) => {
          const index = slot - 1;
          const state = states[index] ?? "empty";
          return (
            <span
              key={slot}
              className={styles.bead}
              data-state={state}
              data-just-lit={justLit === index ? "true" : "false"}
              style={
                {
                  "--bead-fill": `${beadFillPercent(state, progress)}%`,
                } as BeadStyle
              }
            >
              <span className={styles.beadLiquid} />
              <span className={styles.beadGlow} />
              <span className={styles.beadShine} />
              <span className={styles.beadSpark} />
            </span>
          );
        })}
        <span className={styles.beadSweep} aria-hidden="true" />
      </div>
    </div>
  );
}

type PhaseCardButtonProps = {
  card: PhaseCard;
  active: boolean;
  running: boolean;
  minutes: number;
  seconds: number;
  live: boolean;
  completed: number;
  busy: boolean;
  onSelect: (card: PhaseCard) => void;
};

function PhaseCardButton({
  card,
  active,
  running,
  minutes,
  seconds,
  live,
  completed,
  busy,
  onSelect,
}: PhaseCardButtonProps) {
  const total = Math.max(1, minutes * 60);
  const fill = live ? liquidFillPercent(seconds, total) : 64;
  const time = formatClock(live ? seconds : minutes * 60);
  const isFocus = card === "focus";
  const label = isFocus ? "专注" : completed >= 4 ? "长休" : "休息";
  const english = isFocus ? "FOCUS" : completed >= 4 ? "LONG BREAK" : "BREAK";
  const meta = active
    ? running
      ? "进行中"
      : "已就绪"
    : isFocus
      ? `${minutes} 分钟`
      : `${minutes} 分钟 · 第 ${Math.min(completed + 1, 4)} 轮后`;

  return (
    <button
      type="button"
      className={styles.phaseCard}
      data-active={active ? "true" : "false"}
      data-card={card}
      aria-pressed={active}
      disabled={busy}
      aria-label={`${label}，${time}${active ? "，当前阶段" : "，点击切换"}`}
      onClick={() => onSelect(card)}
      style={{ "--mini-fill": `${fill}%` } as CSSProperties}
    >
      <span className={styles.phaseTop}>
        <span className={styles.phaseName}>{label}</span>
        <span className={styles.phaseEnglish}>{english}</span>
        <span className={styles.phaseDot} aria-hidden="true" />
      </span>
      <span className={styles.miniOrb} aria-hidden="true">
        <span className={styles.miniLiquid} />
        <span className={styles.miniCaustic} />
        <span className={styles.miniTime}>{time}</span>
        <span className={styles.miniShine} />
      </span>
      <span className={styles.phaseMeta}>{meta}</span>
    </button>
  );
}

export function LiquidPomodoro() {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const finishingRef = useRef(false);
  const hydratedRef = useRef(false);
  const skipPersistRef = useRef(true);
  const ceremonyTimers = useRef<number[]>([]);
  const dialHideTimer = useRef<number | null>(null);
  const hintTimer = useRef<number | null>(null);
  const dialPointer = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("focus");
  const [focusMinutes, setFocusMinutes] = useState(DEFAULT_FOCUS_MINUTES);
  const [shortBreakMinutes, setShortBreakMinutes] = useState(
    DEFAULT_SHORT_BREAK_MINUTES,
  );
  const [longBreakMinutes, setLongBreakMinutes] = useState(
    DEFAULT_LONG_BREAK_MINUTES,
  );
  const [remaining, setRemaining] = useState(DEFAULT_FOCUS_MINUTES * 60);
  const [running, setRunning] = useState(false);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [completedFocus, setCompletedFocus] = useState(0);
  const [autoStart, setAutoStart] = useState(false);
  const [sound, setSound] = useState(true);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [justLit, setJustLit] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [canMinimize, setCanMinimize] = useState(false);
  const [dialPeek, setDialPeek] = useState<number | null>(null);
  const [dialing, setDialing] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // 面板外观跟随全局「主题流光」；球内液体仍由专注 / 休息的 accent 驱动。
  const { themeId: flowThemeId } = useFlowTheme();
  useWindowFit(rootRef);

  const prefs = useMemo<TimerPrefs>(
    () => ({ focusMinutes, shortBreakMinutes, longBreakMinutes }),
    [focusMinutes, shortBreakMinutes, longBreakMinutes],
  );
  const total = phaseSeconds(phase, prefs);
  const progress = Math.min(1, Math.max(0, remaining / total));
  const fill = liquidFillPercent(remaining, total);
  const dialMinutes = dialPeek ?? focusMinutes;
  const dialProgress = dialMinutes / 60;
  const dialActive = dialPeek !== null;
  const busy = ceremony !== null;
  const display = formatClock(remaining);
  const status = busy
    ? ceremony === "transform"
      ? "能量转化"
      : "完成仪式"
    : running
      ? phase === "focus"
        ? "专注中"
        : "休息中"
      : phase === "focus"
        ? "准备专注"
        : "准备休息";

  // 让 WebView 页面本身透明：窗口是隐藏创建的，等贴合完成后才显示。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lull-transparent-window");
    return () => root.classList.remove("lull-transparent-window");
  }, []);

  // 读取上次保存的偏好与周期进度；静态导出首帧不碰 localStorage。
  useEffect(() => {
    const stored = readStoredPrefs();
    const nextFocus = stored.focusMinutes ?? DEFAULT_FOCUS_MINUTES;
    if (stored.focusMinutes !== undefined) setFocusMinutes(stored.focusMinutes);
    if (stored.shortBreakMinutes !== undefined) {
      setShortBreakMinutes(stored.shortBreakMinutes);
    }
    if (stored.longBreakMinutes !== undefined) {
      setLongBreakMinutes(stored.longBreakMinutes);
    }
    if (stored.autoStart !== undefined) setAutoStart(stored.autoStart);
    if (stored.sound !== undefined) setSound(stored.sound);
    if (stored.completedFocus !== undefined) {
      setCompletedFocus(stored.completedFocus);
    }
    setRemaining(nextFocus * 60);
    // 首批状态在下一帧才落到 effect 依赖里；跳过紧接着的这一次写入，
    // 否则会用默认值覆盖刚读出来的存储。
    skipPersistRef.current = true;
    hydratedRef.current = true;
  }, []);

  // 首次手势里准备音频上下文；关闭提示音时不创建，避免占用输出设备。
  const ensureAudio = useCallback((): AudioContext | null => {
    if (!sound) return null;
    if (!audioRef.current) {
      try {
        audioRef.current = new AudioContext();
      } catch {
        audioRef.current = null;
      }
    }
    if (audioRef.current?.state === "suspended") {
      void audioRef.current.resume();
    }
    return audioRef.current;
  }, [sound]);

  // 在用户手势里打开提示音时顺手预热 AudioContext，避免之后才开声音的一轮没有提示音。
  const toggleSound = useCallback((): void => {
    const next = !sound;
    setSound(next);
    if (!next) return;
    try {
      audioRef.current ??= new AudioContext();
    } catch {
      audioRef.current = null;
    }
    if (audioRef.current?.state === "suspended") {
      void audioRef.current.resume();
    }
  }, [sound]);

  useEffect(
    () => () => {
      void audioRef.current?.close();
      audioRef.current = null;
      for (const timer of ceremonyTimers.current) {
        window.clearTimeout(timer);
      }
      if (dialHideTimer.current) window.clearTimeout(dialHideTimer.current);
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    persistPrefs({
      focusMinutes,
      shortBreakMinutes,
      longBreakMinutes,
      autoStart,
      sound,
      completedFocus,
    });
  }, [
    focusMinutes,
    shortBreakMinutes,
    longBreakMinutes,
    autoStart,
    sound,
    completedFocus,
  ]);

  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void isWindowMinimizable().then((value) => {
        if (alive) setCanMinimize(value);
      });
    };
    sync();
    const stop = onWindowPrefsChanged(sync);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // Escape 关闭设置浮层。
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [settingsOpen]);

  const clearCeremonyTimers = useCallback((): void => {
    for (const timer of ceremonyTimers.current) {
      window.clearTimeout(timer);
    }
    ceremonyTimers.current = [];
  }, []);

  const flashHint = useCallback((message: string): void => {
    setHint(message);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 1600);
  }, []);

  const beginCeremony = useCallback((): void => {
    clearCeremonyTimers();
    setCeremony("drain");
    const schedule = (delay: number, action: () => void): void => {
      ceremonyTimers.current.push(window.setTimeout(action, delay));
    };

    // 1. 排空后 0.5s：核心收缩再释放，提示音与轻微振动同时到达。
    schedule(500, () => {
      setCeremony("pulse");
      playChime(sound ? audioRef.current : null);
      vibrate();
    });

    // 2. 1.2s：三维涟漪从球心向外铺开。
    schedule(1200, () => setCeremony("ripple"));

    // 3. 2.0s：状态真正蜕变——换阶段、换数字、液能换色。
    schedule(2000, () => {
      const next = advancePhase(phase, completedFocus);
      setPhase(next.phase);
      setCompletedFocus(next.completedFocus);
      if (phase === "focus") setJustLit(next.completedFocus - 1);
      setRemaining(phaseSeconds(next.phase, prefs));
      setCeremony("transform");

      // 4. 3.2s：仪式收尾，按偏好决定是否自动开始下一阶段。
      schedule(1200, () => {
        setCeremony(null);
        setJustLit(null);
        finishingRef.current = false;
        if (autoStart) {
          const nextTotal = phaseSeconds(next.phase, prefs);
          setRemaining(nextTotal);
          setEndAt(Date.now() + nextTotal * 1000);
          setRunning(true);
        }
      });
    });
  }, [autoStart, clearCeremonyTimers, completedFocus, phase, prefs, sound]);

  // 计时用绝对结束时间，窗口被遮挡 / 最小化后恢复也不会漂移。
  const beginCeremonyRef = useRef(beginCeremony);
  useEffect(() => {
    beginCeremonyRef.current = beginCeremony;
  }, [beginCeremony]);

  useEffect(() => {
    if (!running || endAt === null) return;
    let disposed = false;
    const tick = (): void => {
      if (disposed) return;
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(left);
      if (left > 0 || finishingRef.current) return;
      finishingRef.current = true;
      setRunning(false);
      setEndAt(null);
      beginCeremonyRef.current();
    };
    tick();
    const timer = window.setInterval(tick, 200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [running, endAt]);

  // 非计时状态：液面跟随剩余时间；重置 / 换阶段时由 CSS 平滑过渡。
  useEffect(() => {
    if (running) return;
    stageRef.current?.style.setProperty("--liquid-fill", `${fill}%`);
  }, [fill, running]);

  // 计时状态：用 rAF 连续驱动液面，避免 200ms 跳变造成「阶梯式」下降。
  useEffect(() => {
    if (!running || endAt === null) return;
    const node = stageRef.current;
    if (!node) return;
    let frame = 0;
    const paint = (): void => {
      const left = Math.max(0, (endAt - Date.now()) / 1000);
      node.style.setProperty(
        "--liquid-fill",
        `${liquidFillPercent(left, total)}%`,
      );
      frame = window.requestAnimationFrame(paint);
    };
    paint();
    return () => window.cancelAnimationFrame(frame);
  }, [running, endAt, total]);

  const startTimer = useCallback((): void => {
    if (remaining <= 0) {
      setRemaining(phaseSeconds(phase, prefs));
      return;
    }
    ensureAudio();
    finishingRef.current = false;
    setEndAt(Date.now() + remaining * 1000);
    setRunning(true);
  }, [ensureAudio, phase, prefs, remaining]);

  const toggle = useCallback((): void => {
    if (busy) return;
    if (running) {
      setRunning(false);
      setEndAt(null);
      return;
    }
    startTimer();
  }, [busy, running, startTimer]);

  const reset = useCallback((): void => {
    clearCeremonyTimers();
    setCeremony(null);
    setJustLit(null);
    setRunning(false);
    setEndAt(null);
    setRemaining(phaseSeconds(phase, prefs));
    finishingRef.current = false;
  }, [clearCeremonyTimers, phase, prefs]);

  const selectPhase = useCallback(
    (card: PhaseCard): void => {
      clearCeremonyTimers();
      setCeremony(null);
      setJustLit(null);
      setRunning(false);
      setEndAt(null);
      const next = phaseForCard(card, completedFocus);
      setPhase(next);
      setRemaining(phaseSeconds(next, prefs));
      finishingRef.current = false;
    },
    [clearCeremonyTimers, completedFocus, prefs],
  );

  const showDial = useCallback((minutes: number, autoHide: boolean): void => {
    setDialPeek(minutes);
    if (dialHideTimer.current) window.clearTimeout(dialHideTimer.current);
    if (autoHide) {
      dialHideTimer.current = window.setTimeout(() => {
        setDialPeek(null);
      }, 1300);
    }
  }, []);

  const adjustFocusMinutes = useCallback(
    (value: number, autoHide = true): void => {
      if (running || busy) {
        flashHint("暂停后可调整专注时长");
        return;
      }
      const next = clampFocusMinutes(value);
      setFocusMinutes(next);
      if (phase === "focus") setRemaining(next * 60);
      showDial(next, autoHide);
    },
    [busy, flashHint, phase, running, showDial],
  );

  const adjustBreakMinutes = useCallback(
    (kind: "short" | "long", delta: number): void => {
      if (running || busy) {
        flashHint("暂停后可调整休息时长");
        return;
      }
      if (kind === "short") {
        const next = clampInteger(shortBreakMinutes + delta, 1, 30);
        setShortBreakMinutes(next);
        if (phase === "shortBreak") setRemaining(next * 60);
      } else {
        const next = clampInteger(longBreakMinutes + delta, 5, 45);
        setLongBreakMinutes(next);
        if (phase === "longBreak") setRemaining(next * 60);
      }
    },
    [busy, flashHint, longBreakMinutes, phase, running, shortBreakMinutes],
  );

  const resetCycle = useCallback((): void => {
    clearCeremonyTimers();
    setCompletedFocus(0);
    setPhase("focus");
    setRemaining(focusMinutes * 60);
    setRunning(false);
    setEndAt(null);
    setCeremony(null);
    setJustLit(null);
    setSettingsOpen(false);
    finishingRef.current = false;
  }, [clearCeremonyTimers, focusMinutes]);

  const wheelRing = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (running || busy) {
      flashHint("暂停后可调整专注时长");
      return;
    }
    const direction = event.deltaY < 0 ? 1 : -1;
    const step = event.shiftKey ? 5 : 1;
    adjustFocusMinutes(focusMinutes + direction * step);
  };

  const pointerAngle = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = ringRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return dialAngleAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      event.clientX,
      event.clientY,
    );
  };

  const ringPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (running || busy) {
      flashHint("暂停后可调整专注时长");
      return;
    }
    event.preventDefault();
    dialPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDialing(true);
    adjustFocusMinutes(minutesForDialAngle(pointerAngle(event)), false);
  };

  const ringPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dialPointer.current !== event.pointerId) return;
    adjustFocusMinutes(minutesForDialAngle(pointerAngle(event)), false);
  };

  const endRingPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dialPointer.current !== event.pointerId) return;
    dialPointer.current = null;
    setDialing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    showDial(clampFocusMinutes(focusMinutes), true);
  };

  const ringKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (running || busy) return;
    let delta = 0;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") delta = 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") delta = -1;
    else if (event.key === "PageUp") delta = 5;
    else if (event.key === "PageDown") delta = -5;
    else if (event.key === "Home") {
      event.preventDefault();
      adjustFocusMinutes(5);
      return;
    } else if (event.key === "End") {
      event.preventDefault();
      adjustFocusMinutes(60);
      return;
    }
    if (delta === 0) return;
    event.preventDefault();
    adjustFocusMinutes(focusMinutes + delta);
  };

  const focusCard: PhaseCardButtonProps = {
    card: "focus",
    active: phase === "focus",
    running: running && phase === "focus",
    minutes: focusMinutes,
    seconds: remaining,
    live: phase === "focus",
    completed: completedFocus,
    busy,
    onSelect: selectPhase,
  };
  const breakCard: PhaseCardButtonProps = {
    card: "break",
    active: phase !== "focus",
    running: running && phase !== "focus",
    minutes: completedFocus >= 4 ? longBreakMinutes : shortBreakMinutes,
    seconds: remaining,
    live: phase !== "focus",
    completed: completedFocus,
    busy,
    onSelect: selectPhase,
  };

  const primaryLabel = busy
    ? "能量转化中"
    : running
      ? "暂停"
      : phase === "focus"
        ? "开始专注"
        : "开始休息";

  return (
    <div
      ref={rootRef}
      className={`${styles.root} liquid-pomodoro-root`}
      data-phase={phase}
      data-theme={flowThemeId}
      data-running={running ? "true" : "false"}
      data-ceremony={ceremony ?? "idle"}
      data-settings={settingsOpen ? "true" : "false"}
    >
      <div className={styles.console}>
        <section className={styles.capsule} aria-label="液态番茄钟">
          <span className={styles.capsuleNoise} aria-hidden="true" />
          <header
            className={styles.header}
            data-tauri-drag-region="deep"
            title="拖动窗口"
          >
            <span className={styles.sigil} aria-hidden="true">
              <Hourglass />
            </span>
            <div className={styles.brand} data-tauri-drag-region="deep">
              <span className={styles.overline}>LULL · LIQUID HOURGLASS</span>
              <h1>番茄钟</h1>
              <p>液态时间沙漏</p>
            </div>
            <div className={styles.windowControls}>
              {canMinimize ? (
                <button
                  type="button"
                  aria-label="最小化"
                  title="最小化"
                  onClick={() => void minimizeWindow()}
                >
                  <Minus />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="关闭窗口"
                title="关闭（隐藏到托盘）"
                onClick={() => void hideWindow()}
              >
                <X />
              </button>
            </div>
          </header>

          <div
            ref={stageRef}
            className={styles.orbStage}
            data-live={running ? "true" : "false"}
            data-dialing={dialing ? "true" : "false"}
            onWheel={wheelRing}
          >
            <span className={styles.orbAura} aria-hidden="true" />
            <span className={styles.ringHaloGlow} aria-hidden="true" />
            <TuningRing
              progress={progress}
              dialProgress={dialProgress}
              dialing={dialActive || dialing}
            />
            <div
              ref={ringRef}
              className={styles.ringLayer}
              role="slider"
              tabIndex={0}
              aria-label="专注时长"
              aria-valuemin={5}
              aria-valuemax={60}
              aria-valuenow={focusMinutes}
              aria-valuetext={`专注 ${focusMinutes} 分钟`}
              aria-disabled={running || busy}
              title={
                running || busy
                  ? "暂停后可调整专注时长"
                  : "沿外圈滑动或滚轮调节专注时长"
              }
              onPointerDown={ringPointerDown}
              onPointerMove={ringPointerMove}
              onPointerUp={endRingPointer}
              onPointerCancel={endRingPointer}
              onKeyDown={ringKeyDown}
            />

            <button
              type="button"
              className={styles.orbButton}
              aria-label={`${primaryLabel}，${display}，${status}`}
              aria-pressed={running}
              disabled={busy}
              onClick={toggle}
            >
              <span className={styles.orb}>
                <span className={styles.orbDeep} aria-hidden="true" />
                <LiquidLayer tone="focus" />
                <LiquidLayer tone="break" />
                <span className={styles.orbFrost} aria-hidden="true" />
                <span className={styles.orbShade} aria-hidden="true" />
                <span className={styles.clock} key={phase} aria-hidden="true">
                  <span className={styles.clockGlow}>{display}</span>
                  <span className={styles.clockText}>{display}</span>
                  <span className={styles.clockMirror}>{display}</span>
                </span>
                <span className={styles.orbRim} aria-hidden="true" />
              </span>
            </button>

            <span className={styles.ceremonyLayer} aria-hidden="true">
              <span className={styles.pulseCore} key={`pulse-${ceremony}`} />
              <span className={styles.pulseRing} key={`ring-${ceremony}`} />
              <span className={styles.burst}>
                {BURST.map((index) => (
                  <i
                    key={`burst-${index}`}
                    className={styles.burstParticle}
                    style={{ "--burst": index } as CSSProperties}
                  />
                ))}
              </span>
              <span className={styles.rippleOne} key={`r1-${ceremony}`} />
              <span className={styles.rippleTwo} key={`r2-${ceremony}`} />
              <span className={styles.rippleThree} key={`r3-${ceremony}`} />
            </span>

            <span
              className={styles.dialReadout}
              data-visible={dialActive ? "true" : "false"}
            >
              <strong>{dialMinutes}</strong>
              <small>MIN</small>
            </span>

            <span
              className={styles.hintBubble}
              data-visible={hint ? "true" : "false"}
            >
              {hint}
            </span>
          </div>

          <div className={styles.orbMeta}>
            <span
              className={styles.statusPill}
              data-live={running ? "true" : "false"}
            >
              <i aria-hidden="true" />
              {status}
            </span>
            <span className={styles.roundLabel}>
              第 {currentRound(completedFocus)} / 4 轮
            </span>
          </div>

          <div
            className={styles.durationLine}
            data-active={dialActive ? "true" : "false"}
          >
            <span className={styles.durationKey}>专注时长</span>
            <span className={styles.durationValue}>
              {focusMinutes}
              <small>MIN</small>
            </span>
            <span className={styles.durationDivider} aria-hidden="true" />
            <span className={styles.durationHint}>
              {running ? "暂停后可调" : "外圈滑动 · 滚轮调节"}
            </span>
          </div>

          <PearlBeads
            completed={completedFocus}
            phase={phase}
            progress={focusProgress(remaining, total)}
            justLit={justLit}
            ceremony={ceremony}
          />

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryAction}
              disabled={busy}
              onClick={toggle}
            >
              {running ? <Pause /> : <Play />}
              <span>{primaryLabel}</span>
            </button>
            <button
              type="button"
              className={styles.iconAction}
              aria-label="重置当前阶段"
              title="重置当前阶段"
              onClick={reset}
            >
              <RotateCcw />
            </button>
          </div>

          <p className={styles.srOnly} aria-live="polite">
            {phaseLabel(phase)}，{status}，本轮已完成 {completedFocus} 个番茄。
          </p>
        </section>

        <aside className={styles.sideColumn} aria-label="阶段切换">
          <span className={styles.sideRail} aria-hidden="true" />
          <PhaseCardButton {...focusCard} />
          <PhaseCardButton {...breakCard} />
          <button
            type="button"
            className={styles.settingsAnchor}
            aria-label="打开计时设置"
            aria-expanded={settingsOpen}
            title="计时设置"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <span className={styles.anchorHalo} aria-hidden="true" />
            <Settings2 />
            <span className={styles.anchorLabel}>设置</span>
          </button>
        </aside>
      </div>

      {settingsOpen ? (
        <>
          <button
            type="button"
            className={styles.scrim}
            aria-label="关闭计时设置"
            onClick={() => setSettingsOpen(false)}
          />
          <section
            className={styles.settingsPanel}
            role="dialog"
            aria-label="计时设置"
          >
            <header className={styles.settingsHead}>
              <span>
                <Settings2 aria-hidden="true" />
                计时设置
              </span>
              <button
                type="button"
                aria-label="关闭设置"
                onClick={() => setSettingsOpen(false)}
              >
                <X />
              </button>
            </header>

            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>专注时长</span>
              <div className={styles.stepper}>
                <button
                  type="button"
                  aria-label="减少专注时长"
                  disabled={running || busy}
                  onClick={() => adjustFocusMinutes(focusMinutes - 1)}
                >
                  <Minus />
                </button>
                <span>{focusMinutes} 分</span>
                <button
                  type="button"
                  aria-label="增加专注时长"
                  disabled={running || busy}
                  onClick={() => adjustFocusMinutes(focusMinutes + 1)}
                >
                  <Plus />
                </button>
              </div>
            </div>

            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>短休时长</span>
              <div className={styles.stepper}>
                <button
                  type="button"
                  aria-label="减少短休时长"
                  disabled={running || busy}
                  onClick={() => adjustBreakMinutes("short", -1)}
                >
                  <Minus />
                </button>
                <span>{shortBreakMinutes} 分</span>
                <button
                  type="button"
                  aria-label="增加短休时长"
                  disabled={running || busy}
                  onClick={() => adjustBreakMinutes("short", 1)}
                >
                  <Plus />
                </button>
              </div>
            </div>

            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>长休时长</span>
              <div className={styles.stepper}>
                <button
                  type="button"
                  aria-label="减少长休时长"
                  disabled={running || busy}
                  onClick={() => adjustBreakMinutes("long", -1)}
                >
                  <Minus />
                </button>
                <span>{longBreakMinutes} 分</span>
                <button
                  type="button"
                  aria-label="增加长休时长"
                  disabled={running || busy}
                  onClick={() => adjustBreakMinutes("long", 1)}
                >
                  <Plus />
                </button>
              </div>
            </div>

            <div className={styles.settingRow} data-static="true">
              <span className={styles.settingLabel}>自动开始下一轮</span>
              <button
                type="button"
                className={styles.switch}
                role="switch"
                aria-label="自动开始下一轮"
                aria-checked={autoStart}
                onClick={() => setAutoStart((value) => !value)}
              >
                <span />
              </button>
            </div>

            <div className={styles.settingRow} data-static="true">
              <span className={styles.settingLabel}>
                结束提示音
                <small>{sound ? "声音 + 轻振" : "静音"}</small>
              </span>
              <button
                type="button"
                className={styles.switch}
                role="switch"
                aria-label="结束提示音"
                aria-checked={sound}
                onClick={toggleSound}
              >
                <span />
              </button>
            </div>

            <footer className={styles.settingsFoot}>
              <button
                type="button"
                className={styles.resetCycle}
                onClick={resetCycle}
              >
                <RotateCcw />
                重置本轮周期
              </button>
              <span className={styles.storageNote}>
                {running ? (
                  "暂停后可调时长"
                ) : sound ? (
                  <>
                    <Volume2 aria-hidden="true" />
                    仅保存在本机
                  </>
                ) : (
                  <>
                    <VolumeX aria-hidden="true" />
                    仅保存在本机
                  </>
                )}
              </span>
            </footer>
          </section>
        </>
      ) : null}
    </div>
  );
}
