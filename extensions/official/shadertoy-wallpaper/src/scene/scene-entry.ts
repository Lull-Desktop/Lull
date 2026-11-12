/**
 * 场景装配：DOM、WebGL、渲染循环、Scene SDK 帧/参数/指针/可见性。
 *
 * 与宿主的分工（RFC §4.3）：宿主只负责「把源码字符串送进来」；识别、适配、
 * 编译、渲染、错误展示都在这里完成。扩展不访问 Tauri、不读本地文件。
 */
import type { SceneFrame, ScenePointer } from "@lull/scene-sdk";
import { buildUniforms } from "../adapter/uniform-adapter";
import { toLogMessage } from "../runtime/diagnostics";
import { createPerformanceGuard } from "../runtime/performance-guard";
import { createRenderLoop, type RenderLoop } from "../runtime/render-loop";
import { createShaderRenderer } from "../runtime/renderer";
import { createWebglContext } from "../runtime/webgl-context";
import { createStatusOverlay, type StatusOverlay } from "../ui/status-overlay";
import { readRuntimeParams, shouldPause } from "./lifecycle";
import { createMouseTracker } from "./pointer";
import { createShaderClock } from "./time";
import {
  computeDrawSize,
  type DrawSize,
  MAX_MULTIPASS_PIXELS,
} from "./viewport";

export type LogLevel = "log" | "warn" | "error";
export type Reporter = (level: LogLevel, message: string) => void;

export type ShaderSceneController = {
  applyFrame(frame: SceneFrame): void;
  applyPointer(pointer: ScenePointer): void;
  applyVisibility(visible: boolean): void;
  applyDocumentVisibility(visible: boolean): void;
  /** 有宿主连接后把日志转发到宿主控制台。 */
  setReporter(reporter: Reporter): void;
  showNotice(title: string, detail: string): void;
  destroy(): void;
};

function defaultReporter(level: LogLevel, message: string): void {
  const line = `[shadertoy-wallpaper] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function ensureRoot(doc: Document): HTMLElement {
  const existing = doc.getElementById("shader-root");
  if (existing) return existing;
  const root = doc.createElement("div");
  root.id = "shader-root";
  root.className = "shader-root";
  doc.body.append(root);
  return root;
}

function ensureCanvas(doc: Document): HTMLCanvasElement {
  const existing = doc.getElementById("shader-canvas");
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = doc.createElement("canvas");
  canvas.id = "shader-canvas";
  canvas.className = "shader-canvas";
  ensureRoot(doc).append(canvas);
  return canvas;
}

function ensureStatusRoot(doc: Document): HTMLElement {
  const existing = doc.getElementById("shader-status");
  if (existing) return existing;
  const root = doc.createElement("div");
  root.id = "shader-status";
  root.className = "shader-status";
  root.hidden = true;
  ensureRoot(doc).append(root);
  return root;
}

function inertController(
  overlay: StatusOverlay,
  setReporter: (next: Reporter) => void,
): ShaderSceneController {
  return {
    applyFrame() {},
    applyPointer() {},
    applyVisibility() {},
    applyDocumentVisibility() {},
    setReporter(next) {
      setReporter(next);
    },
    showNotice(title, detail) {
      overlay.set({ kind: "notice", title, detail });
    },
    destroy() {
      overlay.dispose();
    },
  };
}

export function mountShaderScene(
  doc: Document = document,
): ShaderSceneController {
  const canvas = ensureCanvas(doc);
  const overlay = createStatusOverlay(ensureStatusRoot(doc));

  let reporter: Reporter = defaultReporter;
  const report = (level: LogLevel, message: string): void => {
    reporter(level, message);
  };

  const notifyChannels = (channels: readonly string[]): void => {
    if (channels.length === 0) {
      overlay.set({ kind: "hidden" });
      return;
    }
    report(
      "warn",
      `源码引用外部输入（${channels.join(", ")}），已用占位通道运行。`,
    );
    overlay.flash(
      {
        kind: "notice",
        title: "使用占位输入 / Placeholder inputs",
        detail:
          "iChannel0 = 256×256 程序化噪声，iChannel1-3 = 1×1 黑色，iSampleRate = 44100。\n" +
          "与原始纹理/音频/键盘输入不等价。\n" +
          "Placeholder inputs are not equivalent to the original textures/audio/keyboard.",
      },
      6_000,
    );
  };

  const contextResult = createWebglContext(canvas);
  if (!contextResult.ok) {
    overlay.set({
      kind: "error",
      diagnostic: contextResult.diagnostic,
      previousActive: false,
    });
    report("error", toLogMessage(contextResult.diagnostic));
    return inertController(overlay, (next) => {
      reporter = next;
    });
  }

  const context = contextResult.context;
  const renderer = createShaderRenderer({ canvas, context });
  const clock = createShaderClock();
  const guard = createPerformanceGuard();

  let source = "";
  let renderScale = 1;
  let animation = true;
  let visible = true;
  let documentVisible = doc.visibilityState !== "hidden";
  let stopped = false;
  let synced = false;
  const mouse = createMouseTracker();
  let viewport = { w: 1, h: 1, dpr: 1 };
  let draw: DrawSize = computeDrawSize(viewport, renderScale);
  let drawKey = "";
  let passCount = 1;
  let multipassScale = 1;

  const updatePipelineScale = (): void => {
    if (passCount <= 1) {
      multipassScale = 1;
      return;
    }
    const base = computeDrawSize(viewport, renderScale * guard.scaleFactor);
    const pixels = base.width * base.height;
    multipassScale =
      pixels <= MAX_MULTIPASS_PIXELS
        ? 1
        : Math.sqrt(MAX_MULTIPASS_PIXELS / pixels);
  };

  const pausedNow = (): boolean =>
    shouldPause({
      animation,
      visible,
      documentVisible,
      hasProgram: renderer.hasProgram(),
      stopped,
    });

  const applyDrawSize = (): void => {
    draw = computeDrawSize(
      viewport,
      renderScale * multipassScale * guard.scaleFactor,
    );
    const key = `${draw.width}x${draw.height}`;
    if (key !== drawKey) {
      drawKey = key;
      renderer.resize(draw);
    }
  };

  let onFrameHandler: () => void = () => {};
  const renderLoop: RenderLoop = createRenderLoop({
    onFrame: () => onFrameHandler(),
  });

  const syncLoop = (): void => {
    const paused = pausedNow();
    clock.setPaused(paused);
    if (paused) {
      renderLoop.stop();
      // 暂停时按需重绘一帧，保证尺寸/参数变化后画面不会停在旧内容上。
      if (renderer.hasProgram() && !stopped) renderLoop.requestFrame();
      return;
    }
    renderLoop.start();
  };

  const onFrame = (): void => {
    if (!renderer.hasProgram()) return;
    const paused = pausedNow();
    const timing = paused ? clock.peek() : clock.tick();
    const mouseUniform = mouse.resolve(viewport, draw);
    renderer.render(
      buildUniforms({
        width: draw.width,
        height: draw.height,
        time: timing.time,
        timeDelta: paused ? 0 : timing.delta,
        frame: timing.frame,
        frameRate: timing.frameRate,
        mouse: mouseUniform,
      }),
    );
    if (paused) return;

    const sample = guard.sample(timing.delta);
    if (sample.level === "degrade") {
      applyDrawSize();
      overlay.set({
        kind: "notice",
        title: "已自动降低渲染分辨率 / Render scale reduced",
        detail: `平均帧耗时 ${sample.averageMs.toFixed(1)} ms，当前渲染比例 ${draw.scale.toFixed(2)}×。\nAverage frame time ${sample.averageMs.toFixed(1)} ms; render scale is now ${draw.scale.toFixed(2)}×.`,
      });
      report(
        "warn",
        `性能偏慢，自动降低渲染比例到 ${draw.scale.toFixed(2)}×（平均 ${sample.averageMs.toFixed(1)} ms/帧）`,
      );
      return;
    }
    if (sample.level === "stop") {
      stopped = true;
      renderLoop.stop();
      overlay.set({
        kind: "perf",
        detail: `平均帧耗时 ${sample.averageMs.toFixed(1)} ms，已停止渲染。请降低渲染比例，或更换开销更小的着色器。\nAverage frame time ${sample.averageMs.toFixed(1)} ms; rendering stopped. Lower the render scale or load a cheaper shader.`,
      });
      report(
        "error",
        `性能不足，已停止渲染（平均 ${sample.averageMs.toFixed(1)} ms/帧）`,
      );
    }
  };
  onFrameHandler = onFrame;

  const compile = (nextSource: string): void => {
    source = nextSource;
    if (nextSource.trim() === "") {
      renderer.unload();
      passCount = 1;
      multipassScale = 1;
      stopped = false;
      guard.reset();
      overlay.set({ kind: "empty" });
      syncLoop();
      return;
    }

    const hadProgram = renderer.hasProgram();
    if (!hadProgram) overlay.set({ kind: "compiling" });

    const result = renderer.load(nextSource);
    if (!result.ok) {
      // 关键：失败时不替换旧 Program，旧画面继续跑（RFC §8.3）。
      overlay.set({
        kind: "error",
        diagnostic: result.diagnostic,
        previousActive: hadProgram,
      });
      report("error", toLogMessage(result.diagnostic));
      syncLoop();
      return;
    }

    for (const warning of result.warnings) report("warn", warning);
    if (result.passes.length > 1) {
      report("log", `多 Pass 管线：${result.passes.join(" → ")}`);
    }
    passCount = result.passes.length;
    guard.reset();
    stopped = false;
    updatePipelineScale();
    applyDrawSize();
    if (multipassScale < 1) {
      report(
        "log",
        `多 Pass 显存保护：渲染尺寸限制为 ${draw.width}×${draw.height}`,
      );
    }
    clock.restart();
    notifyChannels(result.channels);
    syncLoop();
  };

  context.onLost(() => {
    renderer.unload();
    clock.setPaused(true);
    renderLoop.stop();
    overlay.set({ kind: "context-lost", restoring: true });
    report("warn", "WebGL 上下文丢失，已暂停渲染");
  });

  context.onRestored(() => {
    report("log", "WebGL 上下文已恢复");
    // 恢复后 canvas 的 GL 状态全部丢失：尺寸、viewport、Program 都要重建。
    drawKey = "";
    applyDrawSize();
    if (source.trim() === "") {
      clock.setPaused(false);
      overlay.set({ kind: "empty" });
      syncLoop();
      return;
    }
    const result = renderer.load(source);
    if (!result.ok) {
      overlay.set({
        kind: "error",
        diagnostic: result.diagnostic,
        previousActive: false,
      });
      report("error", toLogMessage(result.diagnostic));
      return;
    }
    guard.reset();
    stopped = false;
    passCount = result.passes.length;
    updatePipelineScale();
    applyDrawSize();
    clock.restart();
    notifyChannels(result.channels);
    syncLoop();
  });

  overlay.set({ kind: "empty" });

  return {
    applyFrame(frame) {
      viewport = {
        w: frame.viewport.w,
        h: frame.viewport.h,
        dpr: frame.viewport.dpr,
      };
      const params = readRuntimeParams(frame.params);
      if (frame.sync.enabled !== synced) {
        synced = frame.sync.enabled;
        clock.setSync(synced);
      }
      const scaleChanged = params.renderScale !== renderScale;
      const animationChanged = params.animation !== animation;
      renderScale = params.renderScale;
      animation = params.animation;
      updatePipelineScale();
      applyDrawSize();

      if (params.source !== source) {
        compile(params.source);
        return;
      }
      if (!renderer.hasProgram() && params.source.trim() !== "") {
        // 首次帧或 context 恢复前下发：补一次加载。
        compile(params.source);
        return;
      }
      if (scaleChanged || animationChanged) {
        syncLoop();
      }
      if (!renderLoop.running && renderer.hasProgram() && !stopped) {
        renderLoop.requestFrame();
      }
    },
    applyPointer(next) {
      mouse.update(next);
    },
    applyVisibility(next) {
      if (visible === next) return;
      visible = next;
      syncLoop();
    },
    applyDocumentVisibility(next) {
      if (documentVisible === next) return;
      documentVisible = next;
      syncLoop();
    },
    setReporter(next) {
      reporter = next;
    },
    showNotice(title, detail) {
      overlay.set({ kind: "notice", title, detail });
    },
    destroy() {
      renderLoop.dispose();
      renderer.dispose();
      context.destroy();
      overlay.dispose();
    },
  };
}
