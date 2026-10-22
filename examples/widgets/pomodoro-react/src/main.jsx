/**
 * React 版番茄钟示例：与 vanilla 版功能一致，证明插件不依赖具体框架。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectLullWidget } from "../../../../packages/widget-sdk/src/index.js";
import {
  LullProvider,
  useLull,
  useLullState,
  useLullTheme,
  useLullViewport,
  useLullVisibility,
} from "../../../../packages/widget-sdk/src/react.js";

const DEFAULT_PREFS = {
  focusMinutes: 25,
  breakMinutes: 5,
  sound: true,
  completed: 0,
};
const FOCUS_OPTIONS = [15, 25, 50];
const BREAK_OPTIONS = [5, 10, 15];
const RING_CIRCUMFERENCE = 2 * Math.PI * 104;

function normalizePrefs(value) {
  const next = { ...DEFAULT_PREFS };
  if (!value || typeof value !== "object") return next;
  if (FOCUS_OPTIONS.includes(value.focusMinutes)) {
    next.focusMinutes = value.focusMinutes;
  }
  if (BREAK_OPTIONS.includes(value.breakMinutes)) {
    next.breakMinutes = value.breakMinutes;
  }
  if (typeof value.sound === "boolean") next.sound = value.sound;
  if (Number.isFinite(value.completed) && value.completed >= 0) {
    next.completed = Math.floor(value.completed);
  }
  return next;
}

function durationFor(phase, prefs) {
  return (phase === "focus" ? prefs.focusMinutes : prefs.breakMinutes) * 60;
}

function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(
    safe % 60,
  ).padStart(2, "0")}`;
}

function hexToRgba(hex, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return `rgba(143, 228, 255, ${alpha})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function applyTheme(theme) {
  if (!theme || !theme.colors) return;
  const colors = theme.colors;
  const root = document.documentElement;
  root.dataset.theme = theme.id || "custom";
  root.style.setProperty("--accent", colors.accentDark || colors.a);
  root.style.setProperty("--accent-2", colors.b || colors.c);
  root.style.setProperty("--glow", hexToRgba(colors.a, 0.35));
}

function Timer() {
  const lull = useLull();
  const theme = useLullTheme();
  const viewport = useLullViewport();
  const visible = useLullVisibility();
  const [rawPrefs, setPrefs] = useLullState("prefs", DEFAULT_PREFS);
  const prefs = normalizePrefs(rawPrefs);
  const [phase, setPhase] = useState("focus");
  const [running, setRunning] = useState(false);
  const [endAt, setEndAt] = useState(0);
  const [remaining, setRemaining] = useState(DEFAULT_PREFS.focusMinutes * 60);
  const [transparent, setTransparent] = useState(Boolean(lull.transparent));
  const audioGrantedRef = useRef(null);
  const audioContextRef = useRef(null);

  const duration = durationFor(phase, prefs);
  const ratio = Math.min(1, Math.max(0, remaining / Math.max(1, duration)));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!running) setRemaining(duration);
  }, [duration, running]);

  const playChime = useCallback(() => {
    if (!audioGrantedRef.current) return;
    try {
      audioContextRef.current ??= new AudioContext();
      const context = audioContextRef.current;
      if (context.state === "suspended") void context.resume();
      const now = context.currentTime;
      [660, 880].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        const start = now + index * 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.45);
      });
    } catch {
      // 静默失败：计时不依赖提示音。
    }
  }, []);

  const finish = useCallback(
    (count = true) => {
      setRunning(false);
      setEndAt(0);
      if (phase === "focus") {
        if (count) {
          setPrefs({ ...prefs, completed: (prefs.completed ?? 0) + 1 });
        }
        setPhase("break");
        setRemaining((prefs.breakMinutes ?? 5) * 60);
      } else {
        setPhase("focus");
        setRemaining((prefs.focusMinutes ?? 25) * 60);
      }
      if (prefs.sound) playChime();
    },
    [phase, prefs, setPrefs, playChime],
  );

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) finish(true);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [running, endAt, finish]);

  const ensureAudio = useCallback(async () => {
    if (audioGrantedRef.current !== null) return audioGrantedRef.current;
    const granted = await lull.requestAudio().catch(() => false);
    audioGrantedRef.current = granted;
    return granted;
  }, [lull]);

  const start = async () => {
    await ensureAudio();
    const seconds = remaining > 0 ? remaining : duration;
    setRemaining(seconds);
    setEndAt(Date.now() + seconds * 1000);
    setRunning(true);
  };

  const pause = () => {
    setRemaining(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    setRunning(false);
    setEndAt(0);
  };

  const reset = () => {
    setRunning(false);
    setEndAt(0);
    setRemaining(duration);
  };

  const cycleFocus = () => {
    const index = FOCUS_OPTIONS.indexOf(prefs.focusMinutes);
    const next = FOCUS_OPTIONS[(index + 1) % FOCUS_OPTIONS.length];
    setPrefs({ ...prefs, focusMinutes: next });
    if (!running && phase === "focus") setRemaining(next * 60);
  };

  const cycleBreak = () => {
    const index = BREAK_OPTIONS.indexOf(prefs.breakMinutes);
    const next = BREAK_OPTIONS[(index + 1) % BREAK_OPTIONS.length];
    setPrefs({ ...prefs, breakMinutes: next });
    if (!running && phase === "break") setRemaining(next * 60);
  };

  const startDrag = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    event.preventDefault();
    void lull.startDrag().catch(() => {});
  };

  const toggleTransparent = () => {
    const next = !transparent;
    setTransparent(next);
    void lull.setTransparent(next, "#0b1014").catch(() => {});
  };

  return (
    <main className="app" data-state="ready">
      <section className="card">
        <header className="titlebar" onPointerDown={startDrag}>
          <div className="titlebar-title">
            <span className="eyebrow">FOCUS TIMER · REACT</span>
            <span className="connection">已连接</span>
          </div>
          <div className="window-actions">
            <button
              type="button"
              className="win-btn"
              aria-label="切换透明度"
              aria-pressed={transparent}
              title="切换窗口透明"
              onClick={toggleTransparent}
            >
              ◐
            </button>
            {lull.minimizable && (
              <button
                type="button"
                className="win-btn"
                aria-label="最小化"
                title="最小化"
                onClick={() => void lull.minimize().catch(() => {})}
              >
                –
              </button>
            )}
            <button
              type="button"
              className="win-btn win-close"
              aria-label="关闭"
              title="关闭"
              onClick={() => void lull.close().catch(() => {})}
            >
              ×
            </button>
          </div>
        </header>

        <div className="ring">
          <svg viewBox="0 0 240 240" aria-hidden="true">
            <circle className="track" cx="120" cy="120" r="104" />
            <circle
              className="progress"
              cx="120"
              cy="120"
              r="104"
              style={{
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - ratio),
              }}
            />
          </svg>
          <div className="face">
            <span className="phase">{phase === "focus" ? "专注" : "休息"}</span>
            <span className="clock" aria-live="polite">
              {formatClock(remaining)}
            </span>
            <span className="round">
              {phase === "focus"
                ? `第 ${prefs.completed + 1} 轮`
                : `已完成 ${prefs.completed} 轮`}
            </span>
          </div>
        </div>

        <div className="controls">
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (running) pause();
              else void start();
            }}
          >
            {running ? "暂停" : phase === "focus" ? "开始专注" : "开始休息"}
          </button>
          <button type="button" className="ghost" onClick={reset}>
            重置
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => finish(false)}
          >
            跳过
          </button>
        </div>

        <div className="chips">
          <button type="button" className="chip" onClick={cycleFocus}>
            专注 {prefs.focusMinutes} 分
          </button>
          <button type="button" className="chip" onClick={cycleBreak}>
            休息 {prefs.breakMinutes} 分
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={prefs.sound}
            onClick={() => setPrefs({ ...prefs, sound: !prefs.sound })}
          >
            提示音 {prefs.sound ? "开" : "关"}
          </button>
        </div>

        <footer className="footer">
          <span>已完成 {prefs.completed} 轮</span>
          <span className="hint">
            视口 {viewport.width}×{viewport.height} · {visible ? "可见" : "后台"}
          </span>
        </footer>
      </section>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root");
}
const root = createRoot(container);
root.render(<p className="status">正在连接 Lull 宿主…</p>);

connectLullWidget({ timeoutMs: 8000 })
  .then((client) => {
    root.render(
      <LullProvider client={client}>
        <Timer />
      </LullProvider>,
    );
  })
  .catch((error) => {
    root.render(<p className="status">无法连接 Lull 宿主：{String(error)}</p>);
  });
