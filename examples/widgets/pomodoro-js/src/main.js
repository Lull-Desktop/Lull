/**
 * Lull 自定义插件示例：番茄钟。
 *
 * 只依赖 @lull/widget-sdk（这里用相对源码路径，构建时打包）：
 * - 状态：宿主 Rust KV（停止运行/关闭窗口后仍在）
 * - 主题：宿主下发的主题令牌
 * - 音频：宿主授权后播放提示音
 * - 视口/可见性：随宿主窗口变化
 */
import { connectLullWidget } from "../../../../packages/widget-sdk/src/index.js";

const DEFAULT_PREFS = {
  focusMinutes: 25,
  breakMinutes: 5,
  sound: true,
  completed: 0,
};
const FOCUS_OPTIONS = [15, 25, 50];
const BREAK_OPTIONS = [5, 10, 15];
const RING_RADIUS = 104;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const TICK_MS = 250;

const els = {
  app: document.querySelector(".app"),
  status: document.getElementById("status"),
  card: document.getElementById("card"),
  phase: document.getElementById("phase"),
  clock: document.getElementById("clock"),
  round: document.getElementById("round"),
  progress: document.getElementById("progress"),
  toggle: document.getElementById("toggle"),
  reset: document.getElementById("reset"),
  skip: document.getElementById("skip"),
  focusChip: document.getElementById("focus-chip"),
  breakChip: document.getElementById("break-chip"),
  soundChip: document.getElementById("sound-chip"),
  completed: document.getElementById("completed"),
  viewport: document.getElementById("viewport"),
  connection: document.getElementById("connection"),
  titlebar: document.getElementById("titlebar"),
  winTransparency: document.getElementById("win-transparency"),
  winMinimize: document.getElementById("win-minimize"),
  winClose: document.getElementById("win-close"),
};

let client = null;
let transparent = true;
let prefs = { ...DEFAULT_PREFS };
let session = {
  phase: "focus",
  running: false,
  endAt: 0,
  remaining: DEFAULT_PREFS.focusMinutes * 60,
};
let audioGranted = null;
let audioContext = null;

function durationFor(phase) {
  return (phase === "focus" ? prefs.focusMinutes : prefs.breakMinutes) * 60;
}

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

function normalizeSession(value) {
  const next = {
    phase: "focus",
    running: false,
    endAt: 0,
    remaining: durationFor("focus"),
  };
  if (!value || typeof value !== "object") return next;
  if (value.phase === "break") next.phase = "break";
  if (typeof value.running === "boolean") next.running = value.running;
  if (Number.isFinite(value.endAt) && value.endAt > 0) {
    next.endAt = value.endAt;
  }
  if (Number.isFinite(value.remaining) && value.remaining >= 0) {
    next.remaining = Math.floor(value.remaining);
  }
  next.remaining = Math.min(next.remaining, durationFor(next.phase));
  if (next.running) {
    const left = Math.ceil((next.endAt - Date.now()) / 1000);
    if (left <= 0) {
      next.running = false;
      next.remaining = 0;
    } else {
      next.remaining = Math.min(left, durationFor(next.phase));
    }
  }
  return next;
}

function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function hexToRgba(hex, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return `rgba(143, 228, 255, ${alpha})`;
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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

function render() {
  const total = Math.max(1, durationFor(session.phase));
  const ratio = Math.min(1, Math.max(0, session.remaining / total));
  els.phase.textContent = session.phase === "focus" ? "专注" : "休息";
  els.clock.textContent = formatClock(session.remaining);
  els.round.textContent =
    session.phase === "focus"
      ? `第 ${prefs.completed + 1} 轮`
      : `已完成 ${prefs.completed} 轮`;
  els.progress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.progress.style.strokeDashoffset = String(
    RING_CIRCUMFERENCE * (1 - ratio),
  );
  els.toggle.textContent = session.running
    ? "暂停"
    : session.phase === "focus"
      ? "开始专注"
      : "开始休息";
  els.focusChip.textContent = `专注 ${prefs.focusMinutes} 分`;
  els.breakChip.textContent = `休息 ${prefs.breakMinutes} 分`;
  els.soundChip.textContent = `提示音 ${prefs.sound ? "开" : "关"}`;
  els.soundChip.setAttribute("aria-pressed", String(prefs.sound));
  els.completed.textContent = `已完成 ${prefs.completed} 轮`;
}

function persistPrefs() {
  if (!client) return;
  void client.setState("prefs", prefs).catch(() => {});
}

function persistSession() {
  if (!client) return;
  void client.setState("session", session).catch(() => {});
}

async function ensureAudio() {
  if (audioGranted !== null) return audioGranted;
  try {
    audioGranted = await client.requestAudio();
  } catch {
    audioGranted = false;
  }
  return audioGranted;
}

function playChime() {
  if (!audioGranted) return;
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
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
    }
  } catch {
    // 音频不可用时静默；计时本身不受影响。
  }
}

function completePhase(withChime, count = true) {
  const wasFocus = session.phase === "focus";
  if (wasFocus) {
    if (count) prefs.completed += 1;
    session.phase = "break";
  } else {
    session.phase = "focus";
  }
  session.running = false;
  session.endAt = 0;
  session.remaining = durationFor(session.phase);
  persistPrefs();
  persistSession();
  render();
  if (withChime && prefs.sound) playChime();
}

function tick() {
  if (!session.running) return;
  const left = Math.ceil((session.endAt - Date.now()) / 1000);
  session.remaining = Math.max(0, left);
  if (left <= 0) {
    completePhase(true);
    return;
  }
  render();
}

async function startTimer() {
  if (session.running) return;
  if (session.remaining <= 0) session.remaining = durationFor(session.phase);
  await ensureAudio();
  session.running = true;
  session.endAt = Date.now() + session.remaining * 1000;
  persistSession();
  render();
}

function pauseTimer() {
  if (!session.running) return;
  session.remaining = Math.max(
    0,
    Math.ceil((session.endAt - Date.now()) / 1000),
  );
  session.running = false;
  session.endAt = 0;
  persistSession();
  render();
}

function resetTimer() {
  session.running = false;
  session.endAt = 0;
  session.remaining = durationFor(session.phase);
  persistSession();
  render();
}

function cycleFocus() {
  const index = FOCUS_OPTIONS.indexOf(prefs.focusMinutes);
  prefs.focusMinutes = FOCUS_OPTIONS[(index + 1) % FOCUS_OPTIONS.length];
  if (!session.running && session.phase === "focus") {
    session.remaining = durationFor("focus");
    persistSession();
  }
  persistPrefs();
  render();
}

function cycleBreak() {
  const index = BREAK_OPTIONS.indexOf(prefs.breakMinutes);
  prefs.breakMinutes = BREAK_OPTIONS[(index + 1) % BREAK_OPTIONS.length];
  if (!session.running && session.phase === "break") {
    session.remaining = durationFor("break");
    persistSession();
  }
  persistPrefs();
  render();
}

function toggleSound() {
  prefs.sound = !prefs.sound;
  persistPrefs();
  render();
}

function bindEvents() {
  els.titlebar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    void client.startDrag().catch(() => {});
  });
  els.winMinimize.addEventListener("click", () => {
    void client.minimize().catch(() => {});
  });
  els.winTransparency.addEventListener("click", () => {
    transparent = !transparent;
    els.winTransparency.setAttribute("aria-pressed", String(transparent));
    void client.setTransparent(transparent, "#0b1014").catch(() => {});
  });
  els.winClose.addEventListener("click", () => {
    void client.close().catch(() => {});
  });
  els.toggle.addEventListener("click", () => {
    if (session.running) pauseTimer();
    else void startTimer();
  });
  els.reset.addEventListener("click", resetTimer);
  els.skip.addEventListener("click", () => completePhase(false, false));
  els.focusChip.addEventListener("click", cycleFocus);
  els.breakChip.addEventListener("click", cycleBreak);
  els.soundChip.addEventListener("click", toggleSound);
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      if (session.running) pauseTimer();
      else void startTimer();
    }
  });
}

async function main() {
  client = await connectLullWidget({ timeoutMs: 8000 });
  client.onTheme(applyTheme);
  client.onViewport((viewport) => {
    els.viewport.textContent = `视口 ${viewport.width}×${viewport.height}`;
  });
  client.onVisibility((visible) => {
    if (visible) tick();
  });
  applyTheme(client.theme);

  prefs = normalizePrefs(await client.getState("prefs", DEFAULT_PREFS));
  const storedSession = await client.getState("session", null);
  session = normalizeSession(storedSession);
  const expired =
    Boolean(storedSession && storedSession.running) &&
    !session.running &&
    session.remaining === 0;
  if (expired) {
    completePhase(false);
  } else if (session.remaining <= 0 && !session.running) {
    session.remaining = durationFor(session.phase);
  }

  bindEvents();
  transparent = Boolean(client.transparent);
  els.winTransparency.setAttribute("aria-pressed", String(transparent));
  if (!client.minimizable) {
    els.winMinimize.hidden = true;
  }
  els.status.hidden = true;
  els.card.hidden = false;
  els.app.dataset.state = "ready";
  els.connection.textContent = "已连接";
  render();
  window.setInterval(tick, TICK_MS);

  if (session.running) tick();
}

main().catch((error) => {
  els.status.hidden = false;
  els.card.hidden = true;
  els.status.textContent = `无法连接 Lull 宿主：${String(error)}`;
  if (els.app) els.app.dataset.state = "error";
});
