/**
 * Tool extension skeleton (native ESM, no framework).
 *
 * Hard constraints (from docs/widget-sdk.md, read it before editing):
 * - runs in an opaque-origin iframe: no localStorage / cookie / host DOM / Tauri IPC;
 * - every host capability goes through the @lull/widget-sdk postMessage bridge;
 * - inline event handlers are unavailable, always use addEventListener;
 * - all assets use relative paths (a package is not served from the site root).
 *
 * This file demonstrates one complete chain: connect -> theme -> persisted state ->
 * window chrome -> viewport. Domain logic lives in tick() / render(); replace it with
 * your own tool.
 */
import {
  connectLullWidget,
  LullWidgetError,
} from "./vendor/widget-sdk/index.js";

const els = {
  app: document.querySelector(".app"),
  conn: document.getElementById("conn"),
  hint: document.getElementById("hint"),
  value: document.getElementById("value"),
  meta: document.getElementById("meta"),
  viewport: document.getElementById("viewport"),
  cap: document.getElementById("cap"),
  bar: document.querySelector("[data-drag-region]"),
  winActions: document.getElementById("win-actions"),
  winMin: document.getElementById("win-min"),
  winClose: document.getElementById("win-close"),
  inc: document.getElementById("inc"),
  dec: document.getElementById("dec"),
  reset: document.getElementById("reset"),
};

/** Domain state: lives in host KV, survives window close and app restart. */
const DEFAULTS = { count: 0, updatedAt: null };
let state = { ...DEFAULTS };
let client = null;
let visible = true;

function render() {
  els.value.textContent = String(state.count);
  els.meta.textContent = state.updatedAt
    ? `Last entry ${new Date(state.updatedAt).toLocaleString("en-US")}`
    : "No entries yet";
}

function applyTheme(theme) {
  if (!theme) return;
  const { colors } = theme;
  const root = document.documentElement.style;
  root.setProperty("--lull-a", colors.a);
  root.setProperty("--lull-b", colors.b);
  root.setProperty("--lull-c", colors.c);
  root.setProperty("--lull-accent", colors.accentLight);
  root.setProperty("--lull-on-accent", colors.onAccentLight);
  els.app.dataset.theme = theme.id;
}

async function persist() {
  state.updatedAt = Date.now();
  render();
  try {
    await client.setState("state", state);
  } catch (error) {
    logError("Failed to write host state", error);
  }
}

async function tick(delta) {
  state.count = Math.max(0, state.count + delta);
  await persist();
}

function wireWindow() {
  // Chrome ownership comes from the manifest: with "host" the host draws the title bar,
  // so the plugin must not draw a second one.
  if (client.window?.chrome === "custom") {
    els.winActions.hidden = false;
    els.winMin.addEventListener("click", () => void client.minimize());
    els.winClose.addEventListener("click", () => void client.close());
  }
  els.bar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    void client.startDrag();
  });
}

function wireViewport() {
  const show = ({ width, height, dpr } = client.viewport) => {
    els.viewport.textContent = `${Math.round(width)}x${Math.round(height)} @${dpr}x`;
  };
  show();
  client.onViewport(show);
}

function describeCaps() {
  const caps = client.capabilities ?? [];
  els.cap.textContent = caps.length ? caps.join(" · ") : "no capabilities";
}

function logError(message, error) {
  const detail = error instanceof LullWidgetError ? `${error.code}: ${error.message}` : String(error);
  console.warn(`[${message}] ${detail}`);
  void client?.log(`${message}: ${detail}`, "error").catch(() => {});
}

async function boot() {
  try {
    client = await connectLullWidget();
  } catch (error) {
    // Not embedded (file opened directly) or the handshake timed out: surface something
    // actionable instead of failing silently.
    els.app.dataset.state = "error";
    els.conn.textContent = "Disconnected";
    els.hint.textContent =
      error instanceof LullWidgetError && error.code === "not-embedded"
        ? "This page only runs inside Lull (Settings -> Extensions -> Install from file)."
        : `Failed to connect to the host: ${error.message}`;
    return;
  }

  els.app.dataset.state = "ready";
  els.conn.textContent = "Connected";
  els.hint.textContent = "";

  state = await client.getState("state", DEFAULTS);
  render();
  applyTheme(client.theme);
  client.onTheme(applyTheme);
  client.onVisibility((next) => {
    visible = next;
    document.body.dataset.visible = String(next);
  });
  wireWindow();
  wireViewport();
  describeCaps();

  els.inc.addEventListener("click", () => void tick(1));
  els.dec.addEventListener("click", () => void tick(-1));
  els.reset.addEventListener("click", () => {
    state = { ...DEFAULTS };
    void persist();
  });

  window.addEventListener("beforeunload", () => client.destroy());
}

void boot();
