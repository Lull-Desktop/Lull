/**
 * Vue 3 版番茄钟示例：与 vanilla / React 版功能一致。
 * 使用 render 函数而不是运行时模板，避免 Vue 运行时编译器依赖 eval（CSP 禁止）。
 * 全程 TypeScript：Prefs 形状、ref 泛型与 SDK 返回值都有类型。
 */

import { connectLullWidget, type WidgetTheme } from "@lull/widget-sdk";
import {
  createLullPlugin,
  useLull,
  useLullState,
  useLullTheme,
  useLullViewport,
  useLullVisibility,
} from "@lull/widget-sdk/vue";
import {
  computed,
  createApp,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";

type Phase = "focus" | "break";

interface Prefs {
  focusMinutes: number;
  breakMinutes: number;
  sound: boolean;
  completed: number;
}

const DEFAULT_PREFS: Prefs = {
  focusMinutes: 25,
  breakMinutes: 5,
  sound: true,
  completed: 0,
};
const FOCUS_OPTIONS: readonly number[] = [15, 25, 50];
const BREAK_OPTIONS: readonly number[] = [5, 10, 15];
const RING_CIRCUMFERENCE = 2 * Math.PI * 104;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function durationFor(phase: Phase, prefs: Prefs): number {
  return (phase === "focus" ? prefs.focusMinutes : prefs.breakMinutes) * 60;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(
    safe % 60,
  ).padStart(2, "0")}`;
}

function hexToRgba(hex: string | undefined, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match?.[1]) return `rgba(143, 228, 255, ${alpha})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
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

const Timer = defineComponent({
  name: "Timer",
  setup() {
    const lull = useLull();
    const theme = useLullTheme();
    const viewport = useLullViewport();
    const visible = useLullVisibility();
    const [rawPrefs, savePrefs] = useLullState<Prefs>("prefs", DEFAULT_PREFS);
    const prefs = computed(() => normalizePrefs(rawPrefs.value));
    const phase = ref<Phase>("focus");
    const running = ref(false);
    const endAt = ref(0);
    const remaining = ref(DEFAULT_PREFS.focusMinutes * 60);
    const transparent = ref(Boolean(lull.transparent));
    const audioGranted = ref<boolean | null>(null);
    const audioContext = ref<AudioContext | null>(null);
    let timer: number | null = null;

    const duration = computed(() => durationFor(phase.value, prefs.value));
    const ratio = computed(() =>
      Math.min(1, Math.max(0, remaining.value / Math.max(1, duration.value))),
    );
    const clock = computed(() => formatClock(remaining.value));
    const toggleLabel = computed(() =>
      running.value
        ? "暂停"
        : phase.value === "focus"
          ? "开始专注"
          : "开始休息",
    );
    const roundLabel = computed(() =>
      phase.value === "focus"
        ? `第 ${prefs.value.completed + 1} 轮`
        : `已完成 ${prefs.value.completed} 轮`,
    );

    watch(theme, applyTheme, { immediate: true });
    watch([duration, running], () => {
      if (!running.value) remaining.value = duration.value;
    });

    function playChime(): void {
      if (!audioGranted.value) return;
      try {
        audioContext.value ??= new AudioContext();
        const context = audioContext.value;
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
        // 静默失败。
      }
    }

    function finish(count = true): void {
      running.value = false;
      endAt.value = 0;
      if (phase.value === "focus") {
        if (count) {
          savePrefs({
            ...prefs.value,
            completed: (prefs.value.completed ?? 0) + 1,
          });
        }
        phase.value = "break";
        remaining.value = (prefs.value.breakMinutes ?? 5) * 60;
      } else {
        phase.value = "focus";
        remaining.value = (prefs.value.focusMinutes ?? 25) * 60;
      }
      if (prefs.value.sound) playChime();
    }

    async function ensureAudio(): Promise<boolean> {
      if (audioGranted.value !== null) return audioGranted.value;
      audioGranted.value = await lull.requestAudio().catch(() => false);
      return audioGranted.value;
    }

    async function start(): Promise<void> {
      await ensureAudio();
      const seconds = remaining.value > 0 ? remaining.value : duration.value;
      remaining.value = seconds;
      endAt.value = Date.now() + seconds * 1000;
      running.value = true;
    }

    function pause(): void {
      remaining.value = Math.max(
        0,
        Math.ceil((endAt.value - Date.now()) / 1000),
      );
      running.value = false;
      endAt.value = 0;
    }

    function reset(): void {
      running.value = false;
      endAt.value = 0;
      remaining.value = duration.value;
    }

    function cycleFocus(): void {
      const index = FOCUS_OPTIONS.indexOf(prefs.value.focusMinutes);
      const next = FOCUS_OPTIONS[(index + 1) % FOCUS_OPTIONS.length];
      savePrefs({ ...prefs.value, focusMinutes: next });
      if (!running.value && phase.value === "focus")
        remaining.value = next * 60;
    }

    function cycleBreak(): void {
      const index = BREAK_OPTIONS.indexOf(prefs.value.breakMinutes);
      const next = BREAK_OPTIONS[(index + 1) % BREAK_OPTIONS.length];
      savePrefs({ ...prefs.value, breakMinutes: next });
      if (!running.value && phase.value === "break")
        remaining.value = next * 60;
    }

    function toggleSound(): void {
      savePrefs({ ...prefs.value, sound: !prefs.value.sound });
    }

    onMounted(() => {
      timer = window.setInterval(() => {
        if (!running.value) return;
        const left = Math.max(0, Math.ceil((endAt.value - Date.now()) / 1000));
        remaining.value = left;
        if (left <= 0) finish(true);
      }, 250);
    });
    onUnmounted(() => {
      if (timer !== null) window.clearInterval(timer);
    });

    const startDrag = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("button")) return;
      event.preventDefault();
      void lull.startDrag().catch(() => {});
    };

    const toggleTransparent = (): void => {
      transparent.value = !transparent.value;
      void lull.setTransparent(transparent.value, "#0b1014").catch(() => {});
    };

    return () =>
      h("main", { class: "app", "data-state": "ready" }, [
        h("section", { class: "card" }, [
          h("header", { class: "titlebar", onPointerdown: startDrag }, [
            h("div", { class: "titlebar-title" }, [
              h("span", { class: "eyebrow" }, "FOCUS TIMER · VUE"),
              h("span", { class: "connection" }, "已连接"),
            ]),
            h("div", { class: "window-actions" }, [
              h(
                "button",
                {
                  class: "win-btn",
                  type: "button",
                  "aria-label": "切换透明度",
                  "aria-pressed": String(transparent.value),
                  title: "切换窗口透明",
                  onClick: toggleTransparent,
                },
                "◐",
              ),
              lull.minimizable
                ? h(
                    "button",
                    {
                      class: "win-btn",
                      type: "button",
                      "aria-label": "最小化",
                      title: "最小化",
                      onClick: () => void lull.minimize().catch(() => {}),
                    },
                    "–",
                  )
                : null,
              h(
                "button",
                {
                  class: "win-btn win-close",
                  type: "button",
                  "aria-label": "关闭",
                  title: "关闭",
                  onClick: () => void lull.close().catch(() => {}),
                },
                "×",
              ),
            ]),
          ]),
          h("div", { class: "ring" }, [
            h("svg", { viewBox: "0 0 240 240", "aria-hidden": "true" }, [
              h("circle", { class: "track", cx: 120, cy: 120, r: 104 }),
              h("circle", {
                class: "progress",
                cx: 120,
                cy: 120,
                r: 104,
                style: {
                  strokeDasharray: RING_CIRCUMFERENCE,
                  strokeDashoffset: RING_CIRCUMFERENCE * (1 - ratio.value),
                },
              }),
            ]),
            h("div", { class: "face" }, [
              h(
                "span",
                { class: "phase" },
                phase.value === "focus" ? "专注" : "休息",
              ),
              h("span", { class: "clock", "aria-live": "polite" }, clock.value),
              h("span", { class: "round" }, roundLabel.value),
            ]),
          ]),
          h("div", { class: "controls" }, [
            h(
              "button",
              {
                type: "button",
                class: "primary",
                onClick: () => {
                  if (running.value) pause();
                  else void start();
                },
              },
              toggleLabel.value,
            ),
            h(
              "button",
              { type: "button", class: "ghost", onClick: reset },
              "重置",
            ),
            h(
              "button",
              {
                type: "button",
                class: "ghost",
                onClick: () => finish(false),
              },
              "跳过",
            ),
          ]),
          h("div", { class: "chips" }, [
            h(
              "button",
              { type: "button", class: "chip", onClick: cycleFocus },
              `专注 ${prefs.value.focusMinutes} 分`,
            ),
            h(
              "button",
              { type: "button", class: "chip", onClick: cycleBreak },
              `休息 ${prefs.value.breakMinutes} 分`,
            ),
            h(
              "button",
              {
                type: "button",
                class: "chip",
                "aria-pressed": String(prefs.value.sound),
                onClick: toggleSound,
              },
              `提示音 ${prefs.value.sound ? "开" : "关"}`,
            ),
          ]),
          h("footer", { class: "footer" }, [
            h("span", null, `已完成 ${prefs.value.completed} 轮`),
            h(
              "span",
              { class: "hint" },
              `视口 ${viewport.value.width}×${viewport.value.height} · ${
                visible.value ? "可见" : "后台"
              }`,
            ),
          ]),
        ]),
      ]);
  },
});

const container = document.querySelector<HTMLElement>("#root");
if (!container) {
  throw new Error("缺少 #root");
}

connectLullWidget({ timeoutMs: 8000 })
  .then((client) => {
    const app = createApp(Timer);
    app.use(createLullPlugin(client));
    app.mount(container);
  })
  .catch((error: unknown) => {
    container.textContent = `无法连接 Lull 宿主：${String(error)}`;
  });
