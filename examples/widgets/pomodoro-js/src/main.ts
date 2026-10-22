/**
 * Lull 自定义插件示例：番茄钟（原生 TypeScript，无框架）。
 *
 * 只依赖 @lull/widget-sdk（构建时由 esbuild 解析到包产物，再打进单文件）：
 * - 状态：宿主 Rust KV（停止运行/关闭窗口后仍在）
 * - 主题：宿主下发的主题令牌
 * - 音频：宿主授权后播放提示音
 * - 视口/可见性：随宿主窗口变化
 *
 * 这个文件刻意保留「查 DOM + 手动重绘」的写法，作为最小依赖的对照示例；
 * React / Vue 版在相同逻辑上换成声明式渲染。
 */
import {
  connectLullWidget,
  type LullWidgetClient,
  type WidgetTheme,
} from "@lull/widget-sdk";

type Phase = "focus" | "break";

interface Prefs {
  focusMinutes: number;
  breakMinutes: number;
  sound: boolean;
  completed: number;
}

interface Session {
  phase: Phase;
  running: boolean;
  endAt: number;
  remaining: number;
}

const DEFAULT_PREFS: Prefs = {
  focusMinutes: 25,
  breakMinutes: 5,
  sound: true,
  completed: 0,
};
const FOCUS_OPTIONS: readonly number[] = [15, 25, 50];
const BREAK_OPTIONS: readonly number[] = [5, 10, 15];
const RING_RADIUS = 104;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const TICK_MS = 250;

/** 查元素：缺失直接抛错，避免后续一堆 `?.` 掩盖真实的模板问题。 */
function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`缺少元素 ${selector}`);
  return node;
}

const els = {
  app: must<HTMLElement>(".app"),
  status: must<HTMLElement>("#status"),
  card: must<HTMLElement>("#card"),
  phase: must<HTMLElement>("#phase"),
  clock: must<HTMLElement>("#clock"),
  round: must<HTMLElement>("#round"),
  progress: must<SVGCircleElement>("#progress"),
  toggle: must<HTMLButtonElement>("#toggle"),
  reset: must<HTMLButtonElement>("#reset"),
  skip: must<HTMLButtonElement>("#skip"),
  focusChip: must<HTMLButtonElement>("#focus-chip"),
  breakChip: must<HTMLButtonElement>("#break-chip"),
  soundChip: must<HTMLButtonElement>("#sound-chip"),
  completed: must<HTMLElement>("#completed"),
  viewport: must<HTMLElement>("#viewport"),
  connection: must<HTMLElement>("#connection"),
  titlebar: must<HTMLElement>("#titlebar"),
  winTransparency: must<HTMLButtonElement>("#win-transparency"),
  winMinimize: must<HTMLButtonElement>("#win-minimize"),
  winClose: must<HTMLButtonElement>("#win-close"),
};

let client: LullWidgetClient | null = null;
let transparent = true;
let prefs: Prefs = { ...DEFAULT_PREFS };
let session: Session = {
  phase: "focus",
  running: false,
  endAt: 0,
  remaining: DEFAULT_PREFS.focusMinutes * 60,
};
let audioGranted: boolean | null = null;
let audioContext: AudioContext | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function durationFor(phase: Phase): number {
  return (phase === "focus" ? prefs.focusMinutes : prefs.breakMinutes) * 60;
}

function normalizePrefs(value: unknown): Prefs {
  const next: Prefs = { ...DEFAULT_PREFS };
  if (!isRecord(value)) return next;
  if (
    typeof value.focusMinutes === "number" &&
    FOCUS_OPTIONS.includes(value.focusMinutes)
  ) {
    next.focusMinutes = value.focusMinutes;
  }
  if (
    typeof value.breakMinutes === "number" &&
    BREAK_OPTIONS.includes(value.breakMinutes)
  ) {
    next.breakMinutes = value.breakMinutes;
  }
  if (typeof value.sound === "boolean") next.sound = value.sound;
  if (
    typeof value.completed === "number" &&
    Number.isFinite(value.completed) &&
    value.completed >= 0
  ) {
    next.completed = Math.floor(value.completed);
  }
  return next;
}

function normalizeSession(value: unknown): Session {
  const next: Session = {
    phase: "focus",
    running: false,
    endAt: 0,
    remaining: durationFor("focus"),
  };
  if (!isRecord(value)) return next;
  if (value.phase === "break") next.phase = "break";
  if (typeof value.running === "boolean") next.running = value.running;
  if (
    typeof value.endAt === "number" &&
    Number.isFinite(value.endAt) &&
    value.endAt > 0
  ) {
    next.endAt = value.endAt;
  }
  if (
    typeof value.remaining === "number" &&
    Number.isFinite(value.remaining) &&
    value.remaining >= 0
  ) {
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

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function hexToRgba(hex: string | undefined, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match?.[1]) return `rgba(143, 228, 255, ${alpha})`;
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function applyTheme(theme: WidgetTheme | null): void {
  if (!theme) return;
  const colors = theme.colors;
  const root = document.documentElement;
  root.dataset.theme = theme.id || "custom";
  root.style.setProperty("--accent", colors.accentDark || colors.a);
  root.style.setProperty("--accent-2", colors.b || colors.c);
  root.style.setProperty("--glow", hexToRgba(colors.a, 0.35));
}

function render(): void {
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

function persistPrefs(): void {
  if (!client) return;
  void client.setState("prefs", prefs).catch(() => {});
}

function persistSession(): void {
  if (!client) return;
  void client.setState("session", session).catch(() => {});
}

async function ensureAudio(): Promise<boolean> {
  if (audioGranted !== null) return audioGranted;
  if (!client) return false;
  try {
    audioGranted = await client.requestAudio();
  } catch {
    audioGranted = false;
  }
  return audioGranted;
}

function playChime(): void {
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

function completePhase(withChime: boolean, count = true): void {
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

function tick(): void {
  if (!session.running) return;
  const left = Math.ceil((session.endAt - Date.now()) / 1000);
  session.remaining = Math.max(0, left);
  if (left <= 0) {
    completePhase(true);
    return;
  }
  render();
}

async function startTimer(): Promise<void> {
  if (session.running) return;
  if (session.remaining <= 0) session.remaining = durationFor(session.phase);
  await ensureAudio();
  session.running = true;
  session.endAt = Date.now() + session.remaining * 1000;
  persistSession();
  render();
}

function pauseTimer(): void {
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

function resetTimer(): void {
  session.running = false;
  session.endAt = 0;
  session.remaining = durationFor(session.phase);
  persistSession();
  render();
}

function cycleFocus(): void {
  const index = FOCUS_OPTIONS.indexOf(prefs.focusMinutes);
  prefs.focusMinutes = FOCUS_OPTIONS[(index + 1) % FOCUS_OPTIONS.length];
  if (!session.running && session.phase === "focus") {
    session.remaining = durationFor("focus");
    persistSession();
  }
  persistPrefs();
  render();
}

function cycleBreak(): void {
  const index = BREAK_OPTIONS.indexOf(prefs.breakMinutes);
  prefs.breakMinutes = BREAK_OPTIONS[(index + 1) % BREAK_OPTIONS.length];
  if (!session.running && session.phase === "break") {
    session.remaining = durationFor("break");
    persistSession();
  }
  persistPrefs();
  render();
}

function toggleSound(): void {
  prefs.sound = !prefs.sound;
  persistPrefs();
  render();
}

function bindEvents(lull: LullWidgetClient): void {
  els.titlebar.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    void lull.startDrag().catch(() => {});
  });
  els.winMinimize.addEventListener("click", () => {
    void lull.minimize().catch(() => {});
  });
  els.winTransparency.addEventListener("click", () => {
    transparent = !transparent;
    els.winTransparency.setAttribute("aria-pressed", String(transparent));
    void lull.setTransparent(transparent, "#0b1014").catch(() => {});
  });
  els.winClose.addEventListener("click", () => {
    void lull.close().catch(() => {});
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
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code === "Space") {
      event.preventDefault();
      if (session.running) pauseTimer();
      else void startTimer();
    }
  });
}

async function main(): Promise<void> {
  const lull = await connectLullWidget({ timeoutMs: 8000 });
  client = lull;
  client.onTheme(applyTheme);
  client.onViewport((viewport) => {
    els.viewport.textContent = `视口 ${viewport.width}×${viewport.height}`;
  });
  client.onVisibility((visible) => {
    if (visible) tick();
  });
  applyTheme(client.theme);

  prefs = normalizePrefs(await client.getState<Prefs>("prefs", DEFAULT_PREFS));
  const storedSession = await client.getState<Session | null>("session", null);
  session = normalizeSession(storedSession);
  const expired =
    storedSession?.running === true &&
    !session.running &&
    session.remaining === 0;
  if (expired) {
    completePhase(false);
  } else if (session.remaining <= 0 && !session.running) {
    session.remaining = durationFor(session.phase);
  }

  bindEvents(lull);
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

main().catch((error: unknown) => {
  els.status.hidden = false;
  els.card.hidden = true;
  els.status.textContent = `无法连接 Lull 宿主：${String(error)}`;
  els.app.dataset.state = "error";
});
