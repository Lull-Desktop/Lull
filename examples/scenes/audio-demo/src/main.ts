/**
 * 音频响应示例：`wallpaper.audio` 提供只读的标准化音频帧。
 *
 * 数据链路：Media Engine（20Hz 特征提取）→ Rust Audio Reactive Service
 * （归一化 + 平滑 + 多屏共享）→ Tauri 定向事件 → 壁纸页 → `postMessage`
 * → `@lull/scene-sdk` 的 `scene.audio`。
 *
 * 映射约定：
 * - `level.normalized` → 整体呼吸/亮度（连续量，按 rAF 插值）；
 * - `bass` 越过显示阈值 0.76 → 瞬时光效（短时释放，不做常亮）；
 * - `bass / lowMid / mid / highMid / treble` → 五根对数频谱柱；
 * - `noise` 来源 → 雾与背景，`mix` 来源 → 整体能量。
 *
 * 构建：pnpm scenes:samples:build
 */
import {
  type AudioFrame,
  connectLullScene,
  type SceneFrame,
  smoothAudioValue,
} from "@lull/scene-sdk";

type AudioKey =
  | "energy"
  | "bass"
  | "lowMid"
  | "mid"
  | "highMid"
  | "treble"
  | "noise"
  | "flash";

const AUDIO_KEYS: readonly AudioKey[] = [
  "energy",
  "bass",
  "lowMid",
  "mid",
  "highMid",
  "treble",
  "noise",
  "flash",
];

const root = document.documentElement;
const target: Record<AudioKey, number> = {
  energy: 0,
  bass: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  treble: 0,
  noise: 0,
  flash: 0,
};
const current: Record<AudioKey, number> = { ...target };

/** 五根柱子下方的测试数值；显示实际写入 CSS 变量后的值。 */
const VALUE_KEYS: readonly AudioKey[] = [
  "bass",
  "lowMid",
  "mid",
  "highMid",
  "treble",
];
const valueLabels = new Map<AudioKey, HTMLElement>();
for (const key of VALUE_KEYS) {
  const element = document.querySelector<HTMLElement>(`[data-value="${key}"]`);
  if (element) valueLabels.set(key, element);
}

/**
 * 频段显示曲线：先切掉 0.06 以下的底噪，再做轻微 gamma 提亮。
 *
 * 宿主已经输出对数刻度 + 逐段 AGC（每个频段围绕近期平均摆动），所以这里只做
 * “显示端”的对比度处理，不再叠加自动增益——否则又会把五个频段拉回同一高度。
 * 阈值 0.76 与画布上的虚线对齐，闪光只在低频明显高于近期平均时触发。
 */
const BAND_GATE = 0.06;
const BAND_GAMMA = 0.85;
const FLASH_THRESHOLD = 0.76;

let sensitivity = 1;
let lastFrameAt = 0;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function shapeBand(value: number): number {
  const gated = clampUnit((value - BAND_GATE) / (1 - BAND_GATE));
  return clampUnit(gated ** BAND_GAMMA);
}

function applyFrame(frame: SceneFrame | null): void {
  if (!frame) return;
  const value = frame.params.sensitivity;
  if (typeof value === "number" && Number.isFinite(value)) {
    sensitivity = Math.min(2, Math.max(0.2, value));
  }
  root.dataset.palette = String(frame.params.palette ?? "tide");
}

function applyAudio(frame: AudioFrame): void {
  if (frame.source === "noise") {
    target.noise = shapeBand(clampUnit(frame.level.normalized * sensitivity));
    return;
  }
  if (frame.source !== "music" && frame.source !== "mix") return;

  target.energy = clampUnit(frame.level.normalized * sensitivity);
  target.bass = shapeBand(clampUnit(frame.bands.bass * sensitivity));
  target.lowMid = shapeBand(clampUnit(frame.bands.lowMid * sensitivity));
  target.mid = shapeBand(clampUnit(frame.bands.mid * sensitivity));
  target.highMid = shapeBand(clampUnit(frame.bands.highMid * sensitivity));
  target.treble = shapeBand(clampUnit(frame.bands.treble * sensitivity));

  // 瞬态只做短时闪光：用平滑后的低频越过显示阈值，而不是原始 peak。
  // 原始 peak 在正常音乐里长期接近 1，会让闪光常亮。
  const onset = frame.active
    ? clampUnit((target.bass - FLASH_THRESHOLD) / (1 - FLASH_THRESHOLD))
    : 0;
  if (onset > target.flash) target.flash = onset;
}

/**
 * 每个通道的插值时间常数。
 *
 * 频段 release 必须远短于雾/整体呼吸：宿主频段已经约 130ms 回落，这里再接
 * 一段长 release 会让快速鼓点来不及回落，看起来“阻尼很高、没有细节”。
 * 快速鼓点需要 20–30ms attack + 90ms 左右 release。
 */
const SMOOTHING: Record<AudioKey, { attackMs: number; releaseMs: number }> = {
  energy: { attackMs: 110, releaseMs: 380 },
  bass: { attackMs: 25, releaseMs: 90 },
  lowMid: { attackMs: 25, releaseMs: 90 },
  mid: { attackMs: 25, releaseMs: 90 },
  highMid: { attackMs: 25, releaseMs: 90 },
  treble: { attackMs: 20, releaseMs: 85 },
  noise: { attackMs: 160, releaseMs: 600 },
  flash: { attackMs: 10, releaseMs: 110 },
};

function render(now: number): void {
  const dt = lastFrameAt === 0 ? 16 : Math.min(100, now - lastFrameAt);
  lastFrameAt = now;

  for (const key of AUDIO_KEYS) {
    current[key] = smoothAudioValue(
      current[key],
      target[key],
      dt,
      SMOOTHING[key],
    );
  }
  target.flash *= Math.exp(-dt / 140);

  root.style.setProperty("--energy", current.energy.toFixed(3));
  root.style.setProperty("--bass", current.bass.toFixed(3));
  root.style.setProperty("--low-mid", current.lowMid.toFixed(3));
  root.style.setProperty("--mid", current.mid.toFixed(3));
  root.style.setProperty("--high-mid", current.highMid.toFixed(3));
  root.style.setProperty("--treble", current.treble.toFixed(3));
  root.style.setProperty("--noise", current.noise.toFixed(3));
  root.style.setProperty("--flash", current.flash.toFixed(3));

  for (const [key, element] of valueLabels) {
    element.textContent = current[key].toFixed(2);
  }

  requestAnimationFrame(render);
}

function resetTargets(): void {
  for (const key of AUDIO_KEYS) target[key] = 0;
  sensitivity = 1;
}

try {
  const scene = await connectLullScene();
  applyFrame(scene.frame);
  scene.onFrame(applyFrame);

  const snapshot = await scene.audio.getSnapshot();
  const initial = snapshot.sources.mix ?? snapshot.sources.music;
  if (initial) applyAudio(initial);

  scene.audio.onData(applyAudio, {
    sources: ["music", "noise", "mix"],
  });
  scene.audio.onStatus((status) => {
    root.dataset.audio = status.available
      ? "on"
      : (status.reason ?? "inactive");
    if (!status.available) resetTargets();
  });
  scene.onVisibility((visible) => {
    if (!visible) resetTargets();
  });

  requestAnimationFrame(render);
} catch (error) {
  // 不在壁纸窗口（例如直接用浏览器打开）时静默降级为静态画面。
  console.error("[audio-demo] Scene host unavailable", error);
  root.dataset.audio = "unavailable";
  requestAnimationFrame(render);
}
