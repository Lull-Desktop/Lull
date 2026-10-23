/**
 * EtherBubbles（白噪音）：悬浮式五层环境声混音器。
 *
 * 交互：点击泡泡开关声音，滚轮 / 上下拖动调节音量；点击主泡静音，滚轮调总音量。
 * 视觉：玻璃泡 + 发光液体 + 体积环；声场运行时由分析器驱动液体涟漪与呼吸。
 * 页面为工具窗定制的透明外壳：WebView 与 Tauri 窗口都不铺背景，桌面内容可透出。
 */
"use client";

import {
  ChevronRight,
  ChevronsLeftRight,
  Clock,
  Flame,
  Leaf,
  Minus,
  Moon,
  Play,
  RotateCcw,
  Settings2,
  Waves,
  X,
  Zap,
} from "lucide-react";
import type {
  ComponentType,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import {
  onWidgetPrefsChanged,
  readWidgetStorage,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetMinimizeWindow,
  writeWidgetStorage,
} from "@/sdk/widget";
import { useWidgetFit, useWidgetTheme } from "@/sdk/widget/react";
import styles from "./ether-bubbles.module.css";
import {
  type ChannelMap,
  type ChannelState,
  channelMood,
  clampLevel,
  effectiveLevel,
  INITIAL_MASTER,
  initialChannels,
  masterMood,
  SOUNDS,
  type SoundDefinition,
  type SoundId,
} from "./sound-model";
import { useAmbientMixer } from "./use-ambient-mixer";

const SOUND_ICONS: Record<SoundId, ComponentType<{ className?: string }>> = {
  rain: DropletGlyph,
  thunder: Zap,
  wind: Leaf,
  waves: Waves,
  fire: Flame,
};

const SLEEP_OPTIONS = [0, 15, 30, 60] as const;
type SleepMinutes = (typeof SLEEP_OPTIONS)[number];

type StartupMode = "resume" | "silent";
const NOISE_WIDGET_ID = "noise";
const STARTUP_STORAGE_VERSION = "startup";

type BubbleStyle = CSSProperties & {
  "--tone": string;
  "--fill": string;
  "--master-level": string;
  "--master-angle": string;
  "--master-scale": string;
};

type ReadoutTarget = SoundId | "master";

/** 参考图里雨滴两侧展开的水翼，用 lucide 基础路径拼一个更轻盈的雨符号。 */
function DropletGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.4c2.8 3.5 5.9 6.6 5.9 10.1a5.9 5.9 0 0 1-11.8 0C6.1 10 9.2 6.9 12 3.4Z" />
      <path d="M4.2 13.6c1.8.8 3 .5 4.2-.3M19.8 13.6c-1.8.8-3 .5-4.2-.3" />
      <path d="M8.1 17.3c.8.7 1.9 1 3 1" opacity=".65" />
    </svg>
  );
}

function StarGlyph() {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={0.72}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="10.5" opacity=".8" />
      <circle cx="32" cy="32" r="21.5" opacity=".22" />
      <path d="M32 3.5v57M3.5 32h57" opacity=".8" />
      <path d="M11.8 11.8 52.2 52.2M52.2 11.8 11.8 52.2" opacity=".55" />
      <path d="M21 8.5 43 55.5M55.5 21 8.5 43" opacity=".26" />
      <path d="M8.5 21 55.5 43M43 8.5 21 55.5" opacity=".26" />
      <circle cx="32" cy="32" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

type DragState = {
  pointerId: number;
  startY: number;
  startLevel: number;
  moved: boolean;
};

type BubbleProps = {
  definition: SoundDefinition;
  channel: ChannelState;
  readout: boolean;
  onToggle: (id: SoundId) => void;
  onVolume: (id: SoundId, value: number) => void;
  onAdjust: (id: SoundId) => void;
};

function SoundBubble({
  definition,
  channel,
  readout,
  onToggle,
  onVolume,
  onAdjust,
}: BubbleProps) {
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const level = effectiveLevel(channel);
  const active = level > 0;
  const Icon = SOUND_ICONS[definition.id];
  const status = active ? `音量 ${level}%` : "已关闭";

  const wheel = (event: ReactWheelEvent<HTMLButtonElement>): void => {
    const step = event.deltaY < 0 ? 4 : -4;
    onVolume(definition.id, level + step);
    onAdjust(definition.id);
  };

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: level,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    onVolume(definition.id, drag.startLevel + delta * 0.72);
    onAdjust(definition.id);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const click = (): void => {
    if (suppressClickRef.current) return;
    onToggle(definition.id);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onVolume(definition.id, level + 5);
      onAdjust(definition.id);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onVolume(definition.id, level - 5);
      onAdjust(definition.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      onVolume(definition.id, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      onVolume(definition.id, 100);
      onAdjust(definition.id);
    }
  };

  return (
    <div
      className={styles.bubbleShell}
      data-active={active ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-full={level >= 100 ? "true" : "false"}
      data-readout={readout ? "true" : "false"}
      style={
        {
          "--tone": definition.tone,
          "--fill": `${level}%`,
        } as BubbleStyle
      }
    >
      <span className={styles.bubbleAura} aria-hidden="true" />
      <svg
        className={styles.volumeRing}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle className={styles.ringTrack} cx="50" cy="50" r="47.4" />
        <circle
          className={styles.ringProgress}
          cx="50"
          cy="50"
          r="47.4"
          pathLength={100}
          strokeDasharray={`${level} 100`}
        />
      </svg>

      <button
        type="button"
        className={styles.bubbleButton}
        data-ether-wheel="true"
        aria-label={`${definition.label}，${status}。点击${active ? "关闭" : "开启"}，滚轮或上下拖动调节音量`}
        aria-pressed={active}
        onWheel={wheel}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={click}
        onKeyDown={keyDown}
      >
        <span className={styles.sphere}>
          <span className={styles.liquid} aria-hidden="true">
            <span className={styles.liquidSurface} />
            <span className={styles.liquidSurfaceAlt} />
            <span className={styles.liquidShaft} />
            <span className={styles.liquidMotes} />
          </span>
          <span className={styles.sphereShade} aria-hidden="true" />
          <span className={styles.sphereRim} aria-hidden="true" />
          <span className={styles.glyph}>
            <Icon className={styles.glyphSvg} />
          </span>
        </span>
      </button>

      <span className={styles.bubbleReadout} aria-hidden="true">
        {level}%
      </span>
    </div>
  );
}

type MasterBubbleProps = {
  master: number;
  muted: boolean;
  readout: boolean;
  onVolume: (value: number) => void;
  onToggle: () => void;
  onAdjust: () => void;
};

function MasterBubble({
  master,
  muted,
  readout,
  onVolume,
  onToggle,
  onAdjust,
}: MasterBubbleProps) {
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const wheel = (event: ReactWheelEvent<HTMLButtonElement>): void => {
    onVolume(master + (event.deltaY < 0 ? 4 : -4));
    onAdjust();
  };

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: master,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    onVolume(drag.startLevel + delta * 0.72);
    onAdjust();
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onVolume(master + 5);
      onAdjust();
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onVolume(master - 5);
      onAdjust();
    }
  };

  return (
    <div
      className={styles.masterShell}
      data-muted={muted ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      style={
        {
          "--master-level": `${master}%`,
          "--master-angle": `${master * 3.6}deg`,
          "--master-scale": `${(0.9 + (master / 100) * 0.12).toFixed(3)}`,
          "--tone": "#ffe0a8",
          "--fill": `${master}%`,
        } as BubbleStyle
      }
    >
      <span className={styles.masterAura} aria-hidden="true" />
      <span className={styles.masterRing} aria-hidden="true" />
      <button
        type="button"
        className={styles.masterButton}
        data-ether-wheel="true"
        aria-label={
          muted
            ? `白噪音，总音量 ${master}%，已静音。点击恢复声音，滚轮或上下拖动调节总音量`
            : `白噪音，总音量 ${master}%。点击静音，滚轮或上下拖动调节总音量`
        }
        aria-pressed={muted}
        onWheel={wheel}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (suppressClickRef.current) return;
          onToggle();
        }}
        onKeyDown={keyDown}
      >
        <span className={styles.motherSphere}>
          <span className={styles.motherDeep} aria-hidden="true" />
          <span className={styles.motherRays} aria-hidden="true" />
          <span className={styles.motherFlare} aria-hidden="true" />
          <span className={styles.motherGlass} aria-hidden="true" />
          <span className={styles.motherGlyph}>
            <StarGlyph />
          </span>
        </span>
      </button>
      <span
        className={styles.masterReadout}
        data-visible={dragging || readout ? "true" : "false"}
      >
        {master}%
      </span>
    </div>
  );
}

export function EtherBubbles() {
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    awake,
    start: startAudio,
    sync: syncAudio,
  } = useAmbientMixer(rootRef);
  const [channels, setChannels] = useState<ChannelMap>(initialChannels);
  const [master, setMaster] = useState(INITIAL_MASTER);
  const [muted, setMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dockSide, setDockSide] = useState<"left" | "right">("right");
  const [autoFade, setAutoFade] = useState(true);
  const { theme: currentTheme } = useWidgetTheme();
  const [sleepMinutes, setSleepMinutes] = useState<SleepMinutes>(0);
  const [startupMode, setStartupMode] = useState<StartupMode>("resume");
  const [dormant, setDormant] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [readout, setReadout] = useState<ReadoutTarget | null>(null);
  const [canMinimize, setCanMinimize] = useState(false);

  const readoutTimer = useRef<number | null>(null);
  const switchTimer = useRef<number | null>(null);
  const sleepLabel = sleepMinutes === 0 ? "关闭" : `${sleepMinutes} 分钟`;
  const startupLabel = startupMode === "resume" ? "继续上次" : "静默启动";

  useWidgetFit(rootRef);

  const activeCount = SOUNDS.reduce(
    (count, sound) => count + (channels[sound.id].enabled ? 1 : 0),
    0,
  );
  const audible = awake && !muted && activeCount > 0;

  useEffect(() => {
    // 音频图是首次手势后才创建的；`awake` 参与依赖，确保创建完成时立刻把
    // 当前混音状态灌进各增益节点，否则用户只是轻触空白处唤醒时会是静音。
    if (!awake) return;
    syncAudio({ channels, master, muted });
  }, [syncAudio, awake, channels, master, muted]);

  // 启动行为：挂载后读取偏好，选择「静默启动」时先保持主泡静音。
  useEffect(() => {
    try {
      if (
        readWidgetStorage(NOISE_WIDGET_ID, STARTUP_STORAGE_VERSION) === "silent"
      ) {
        setStartupMode("silent");
        setMuted(true);
      }
    } catch {
      // 存储不可用时维持默认「继续上次」。
    }
  }, []);

  // 让 WebView 页面本身也透明：窗口是隐藏创建的，等这里和 useWidgetFit 完成后才显示。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lull-transparent-window");
    return () => root.classList.remove("lull-transparent-window");
  }, []);

  // 睡眠定时器：设定后到点自动静音并归零。
  useEffect(() => {
    if (sleepMinutes === 0) return;
    const timer = window.setTimeout(() => {
      setMuted(true);
      setSleepMinutes(0);
    }, sleepMinutes * 60_000);
    return () => window.clearTimeout(timer);
  }, [sleepMinutes]);

  // 首次键盘 / 指针手势里唤醒音频上下文；点击泡泡时也保留它自己的语义。
  useEffect(() => {
    const wake = (): void => {
      void startAudio();
    };
    window.addEventListener("pointerdown", wake, { capture: true, once: true });
    window.addEventListener("keydown", wake, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", wake, { capture: true });
      window.removeEventListener("keydown", wake, { capture: true });
    };
  }, [startAudio]);

  // 滚轮只作用于泡泡，阻止页面在调节音量时滚动。
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const blockScroll = (event: globalThis.WheelEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-ether-wheel]")) {
        event.preventDefault();
      }
    };
    node.addEventListener("wheel", blockScroll, { passive: false });
    return () => node.removeEventListener("wheel", blockScroll);
  }, []);

  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void widgetIsMinimizable().then((value) => {
        if (alive) setCanMinimize(value);
      });
    };
    sync();
    const stop = onWidgetPrefsChanged(sync);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  // 无操作 5 秒且声场运行时进入「微光」状态；任何指针 / 键盘活动立即唤醒。
  useEffect(() => {
    if (!autoFade || !audible || settingsOpen) {
      setDormant(false);
      return;
    }
    let timer = 0;
    const arm = (): void => {
      setDormant(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDormant(true), 5000);
    };
    arm();
    window.addEventListener("pointermove", arm, { passive: true });
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", arm);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [autoFade, audible, settingsOpen]);

  useEffect(
    () => () => {
      if (readoutTimer.current) window.clearTimeout(readoutTimer.current);
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
    },
    [],
  );

  const markReadout = useCallback((target: ReadoutTarget): void => {
    setReadout(target);
    if (readoutTimer.current) window.clearTimeout(readoutTimer.current);
    readoutTimer.current = window.setTimeout(() => {
      setReadout(null);
    }, 1600);
  }, []);

  const setChannelVolume = useCallback(
    (id: SoundId, value: number): void => {
      const level = clampLevel(value);
      setChannels((prev) => ({
        ...prev,
        [id]: { enabled: level > 0, level },
      }));
      setMuted(false);
      void startAudio();
      markReadout(id);
    },
    [markReadout, startAudio],
  );

  const toggleChannel = useCallback(
    (id: SoundId): void => {
      setChannels((prev) => {
        const current = prev[id];
        if (current.enabled) {
          return { ...prev, [id]: { ...current, enabled: false } };
        }
        return {
          ...prev,
          [id]: {
            enabled: true,
            level: current.level < 5 ? 50 : current.level,
          },
        };
      });
      setMuted(false);
      void startAudio();
      markReadout(id);
    },
    [markReadout, startAudio],
  );

  const setMasterVolume = useCallback(
    (value: number): void => {
      const level = clampLevel(value);
      setMaster(level);
      if (level > 0) setMuted(false);
      void startAudio();
      markReadout("master");
    },
    [markReadout, startAudio],
  );

  const toggleMaster = useCallback((): void => {
    if (muted) {
      if (master === 0) setMaster(50);
      setMuted(false);
    } else {
      setMuted(true);
    }
    void startAudio();
  }, [master, muted, startAudio]);

  const cycleSleep = useCallback((): void => {
    const current = SLEEP_OPTIONS.indexOf(sleepMinutes);
    setSleepMinutes(SLEEP_OPTIONS[(current + 1) % SLEEP_OPTIONS.length]);
  }, [sleepMinutes]);

  const cycleStartup = useCallback((): void => {
    const next: StartupMode = startupMode === "resume" ? "silent" : "resume";
    setStartupMode(next);
    setMuted(next === "silent");
    try {
      writeWidgetStorage(NOISE_WIDGET_ID, STARTUP_STORAGE_VERSION, next);
    } catch {
      // 存储不可用时只在当前会话生效。
    }
  }, [startupMode]);

  const switchDock = useCallback(
    (side: "left" | "right"): void => {
      if (dockSide === side) return;
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
      setSwitching(true);
      setDockSide(side);
      switchTimer.current = window.setTimeout(() => setSwitching(false), 820);
    },
    [dockSide],
  );

  const resetMix = useCallback((): void => {
    setChannels(initialChannels());
    setMaster(INITIAL_MASTER);
    setMuted(false);
    setSleepMinutes(0);
    setSettingsOpen(false);
    void startAudio();
  }, [startAudio]);

  const nextDockSide = dockSide === "right" ? "left" : "right";
  const dockSideLabel =
    nextDockSide === "left" ? "屏幕位置改到左侧" : "屏幕位置改到右侧";

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ether-bubbles-root`}
      data-dormant={dormant ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-side={dockSide}
      data-switching={switching ? "true" : "false"}
      data-theme={currentTheme.id}
    >
      <main className={styles.stage}>
        <div className={styles.ribbonAnchor}>
          <div
            key={dockSide}
            className={styles.ribbonGroup}
            data-switching={switching ? "true" : "false"}
          >
            <div className={styles.dockTop} data-tauri-drag-region="deep">
              <button
                type="button"
                className={styles.dockButton}
                aria-label={dockSideLabel}
                title={dockSideLabel}
                onClick={() => switchDock(nextDockSide)}
              >
                <ChevronsLeftRight aria-hidden="true" />
              </button>
              <div
                className={styles.dockDragHandle}
                data-tauri-drag-region="deep"
                title="拖动窗口"
              >
                <span className={styles.dockGrip} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className={styles.dockControls}>
                {canMinimize ? (
                  <button
                    type="button"
                    className={styles.dockButton}
                    aria-label="最小化"
                    title="最小化"
                    onClick={() => void widgetMinimizeWindow()}
                  >
                    <Minus />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.dockButton}
                  aria-label="关闭窗口"
                  title="关闭（隐藏到托盘）"
                  onClick={() => void widgetHideWindow()}
                >
                  <X />
                </button>
              </div>
            </div>

            <span className={styles.rail} aria-hidden="true">
              <span className={styles.railShine} />
              <span className={styles.railThread} />
            </span>

            <div
              className={`${styles.soundRow} ${styles.masterRow}`}
              data-active="true"
            >
              <div className={styles.rowLabel}>
                <span className={styles.glyphTitle}>白噪音</span>
                <span className={styles.rowMeta}>
                  {master}% · {masterMood(master, muted)}
                </span>
              </div>
              <div className={styles.rowBubble}>
                <MasterBubble
                  master={master}
                  muted={muted}
                  readout={readout === "master"}
                  onVolume={setMasterVolume}
                  onToggle={toggleMaster}
                  onAdjust={() => markReadout("master")}
                />
              </div>
              <div className={styles.rowSpacer} aria-hidden="true" />
            </div>

            {SOUNDS.map((sound) => {
              const channel = channels[sound.id];
              const level = effectiveLevel(channel);
              return (
                <div
                  className={styles.soundRow}
                  key={sound.id}
                  data-active={level > 0 ? "true" : "false"}
                >
                  <div className={styles.rowLabel}>
                    <span className={styles.glyphTitle}>{sound.glyph}</span>
                    <span className={styles.rowMeta}>
                      {level}% · {channelMood(channel, sound)}
                    </span>
                  </div>
                  <div className={styles.rowBubble}>
                    <SoundBubble
                      definition={sound}
                      channel={channel}
                      readout={readout === sound.id}
                      onToggle={toggleChannel}
                      onVolume={setChannelVolume}
                      onAdjust={markReadout}
                    />
                  </div>
                  <div className={styles.rowSpacer} aria-hidden="true" />
                </div>
              );
            })}

            <div className={styles.gearRow}>
              <button
                type="button"
                className={styles.gearButton}
                aria-label="泡泡设置"
                aria-expanded={settingsOpen}
                title="声场设置"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings2 />
              </button>
            </div>
          </div>
        </div>
      </main>

      <span
        className={styles.switchVeil}
        data-active={switching ? "true" : "false"}
        aria-hidden="true"
      />

      {settingsOpen ? (
        <>
          <button
            type="button"
            className={styles.scrim}
            aria-label="关闭泡泡设置"
            onClick={() => setSettingsOpen(false)}
          />
          <section
            className={styles.settingsPanel}
            role="dialog"
            aria-modal="true"
            aria-label="泡泡设置"
          >
            <div className={styles.settingsBody}>
              <div className={styles.settingsHead}>
                <strong>更多设置</strong>
                <button
                  type="button"
                  aria-label="关闭设置"
                  onClick={() => setSettingsOpen(false)}
                >
                  <X />
                </button>
              </div>

              <div className={styles.settingInline}>
                <span className={styles.settingLabel}>主题流光</span>
                <span
                  className={styles.themeBadge}
                  title="在设置窗口的「主题流光」中统一调整"
                >
                  {currentTheme.label()} · {m.common_global()}
                </span>
              </div>

              <div className={styles.otherSection}>
                <span className={styles.sectionLabel}>其他功能</span>
                <button
                  type="button"
                  className={styles.menuRow}
                  aria-label={`睡眠定时器，当前${sleepLabel}`}
                  onClick={cycleSleep}
                >
                  <span className={styles.menuIcon}>
                    <Clock />
                  </span>
                  <span className={styles.menuText}>睡眠定时器</span>
                  <span className={styles.menuValue}>{sleepLabel}</span>
                  <ChevronRight />
                </button>
                <button
                  type="button"
                  className={styles.menuRow}
                  aria-label={`启动设置，当前${startupLabel}`}
                  onClick={cycleStartup}
                >
                  <span className={styles.menuIcon}>
                    <Play />
                  </span>
                  <span className={styles.menuText}>启动设置</span>
                  <span className={styles.menuValue}>{startupLabel}</span>
                  <ChevronRight />
                </button>
                <div className={styles.menuRow} data-static="true">
                  <span className={styles.menuIcon}>
                    <Moon />
                  </span>
                  <span className={styles.menuText}>自动隐去</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="自动隐去"
                    aria-checked={autoFade}
                    className={styles.switch}
                    onClick={() => setAutoFade((value) => !value)}
                  >
                    <span />
                  </button>
                </div>
              </div>

              <div className={styles.settingsFoot}>
                <button
                  type="button"
                  className={styles.resetButton}
                  onClick={resetMix}
                >
                  <RotateCcw />
                  重置混音
                </button>
                <p className={styles.settingsNote}>
                  滚动调节 · 主题流光在设置窗口
                </p>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
