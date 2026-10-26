/**
 * Script scene skeleton (declares wallpaper.script).
 *
 * Runs in a sandbox="allow-scripts" opaque-origin iframe: no same-origin storage, no
 * Tauri IPC, and the only channel is the @lull/scene-sdk postMessage bridge that
 * delivers params, geometry and the sync phase.
 *
 * Rules:
 * - read params from frame.params; the host already restored types and applied defaults;
 * - for cross-screen sync use syncedDelayMs(period, epochMs) to build a negative
 *   animation-delay, never call Date.now() yourself;
 * - when reducedMotion is true, stop continuous animation.
 */
import {
  connectLullScene,
  syncedDelayMs,
  LullSceneError,
} from "./vendor/scene-sdk/index.js";

const root = document.documentElement;
const layer = document.querySelector(".layer");

let period = 12;

function applyParams(params) {
  root.style.setProperty("--tint", String(params.tint ?? "__ACCENT__"));
  root.style.setProperty("--glow", String(params.glow ?? 0.45));
  // Map params to the period here; add more mappings as params grow.
  period = Number(params.speed ?? 12);
  root.style.setProperty("--period", `${period}s`);
}

function applySync(frame) {
  if (!frame.sync?.enabled) {
    layer.style.animationDelay = "0ms";
    return;
  }
  // A negative delay aligns every window to the same time base.
  layer.style.animationDelay = `${syncedDelayMs(period * 1000, frame.sync.epochMs)}ms`;
}

function applyMotion(frame) {
  layer.style.animationPlayState = frame.reducedMotion ? "paused" : "running";
  root.dataset.motion = frame.reducedMotion ? "reduced" : "full";
}

async function boot() {
  try {
    const scene = await connectLullScene();
    scene.onFrame((frame) => {
      applyParams(frame.params);
      applySync(frame);
      applyMotion(frame);
    });
    scene.onVisibility((visible) => {
      layer.style.animationPlayState = visible ? "running" : "paused";
    });
  } catch (error) {
    // Not embedded (file opened directly): keep a static backdrop instead of a white page.
    if (error instanceof LullSceneError) {
      console.warn(`[scene] ${error.code}: ${error.message}`);
    }
    root.dataset.state = "standalone";
  }
}

void boot();
