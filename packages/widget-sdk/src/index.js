/**
 * Lull Widget 插件侧 SDK（无框架依赖）。
 *
 * 运行在宿主窗口的 sandbox iframe 里，只通过 postMessage 与父窗口通信：
 * - 不能访问宿主 DOM / localStorage / Tauri IPC；
 * - 状态、主题、视口、音频授权都由宿主桥处理；
 * - connect() 完成 init 握手后返回客户端。
 */

const PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 8000;

/** 协议/宿主返回的结构化错误。 */
export class LullWidgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LullWidgetError";
    this.code = code;
  }
}

let sharedClient = null;

/**
 * 连接宿主。必须在 iframe 内调用；同一页面重复调用返回同一个 Promise。
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<LullWidgetClient>}
 */
export function connectLullWidget(options = {}) {
  if (sharedClient) return sharedClient;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : 10000;
  sharedClient = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || window.parent === window) {
      reject(
        new LullWidgetError(
          "not-embedded",
          "Lull Widget 必须在宿主 iframe 中运行。",
        ),
      );
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onInit);
      reject(new LullWidgetError("init-timeout", "宿主未在超时前完成初始化。"));
    }, timeoutMs);

    function onInit(event) {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.v !== PROTOCOL || data.type !== "init") return;
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onInit);
      try {
        resolve(createClient(data));
      } catch (error) {
        reject(error);
      }
    }

    window.addEventListener("message", onInit);
    window.parent.postMessage(
      { v: PROTOCOL, type: "ready", protocol: PROTOCOL },
      "*",
    );
  });
  sharedClient.catch(() => {
    sharedClient = null;
  });
  return sharedClient;
}

function applyWindowBackground(transparent, color) {
  if (transparent) {
    document.documentElement.style.removeProperty("background-color");
    document.body.style.removeProperty("background-color");
    return;
  }
  const value = typeof color === "string" ? color : "#f6f3ec";
  document.documentElement.style.backgroundColor = value;
  document.body.style.backgroundColor = value;
}

function createClient(init) {
  const capabilities = new Set(
    Array.isArray(init.granted) ? init.granted.slice() : [],
  );
  if (init.window && init.window.transparent === false) {
    applyWindowBackground(false, "#f6f3ec");
  }
  const token = init.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new LullWidgetError("bad-init", "宿主 init 消息缺少 token。");
  }

  let theme = init.theme ?? null;
  let viewport = normalizeViewport(init.viewport);
  let visible = true;
  let sequence = 0;
  let disposed = false;
  const pending = new Map();
  const themeListeners = new Set();
  const viewportListeners = new Set();
  const visibilityListeners = new Set();

  function onMessage(event) {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.v !== PROTOCOL) return;
    if (data.type === "theme") {
      theme = data.theme ?? theme;
      for (const listener of themeListeners) listener(theme);
      return;
    }
    if (data.type === "viewport") {
      viewport = normalizeViewport(data.viewport);
      for (const listener of viewportListeners) listener(viewport);
      return;
    }
    if (data.type === "visibility") {
      visible = data.visible !== false;
      for (const listener of visibilityListeners) listener(visible);
      return;
    }
    if (data.type !== "response" || typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    window.clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else
      entry.reject(
        new LullWidgetError("host-error", data.error || "宿主请求失败"),
      );
  }

  window.addEventListener("message", onMessage);

  function request(method, params = {}) {
    if (disposed) {
      return Promise.reject(new LullWidgetError("disposed", "客户端已销毁。"));
    }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new LullWidgetError("timeout", `宿主未响应 ${method}。`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { v: PROTOCOL, type: "request", id, method, params, token },
        "*",
      );
    });
  }

  const client = {
    protocol: PROTOCOL,
    id: init.id,
    hostApi: init.hostApi,
    minimizable: Boolean(init.minimizable),
    transparent: Boolean(init.window?.transparent),
    window: init.window ?? null,
    capabilities: [...capabilities],
    get theme() {
      return theme;
    },
    get viewport() {
      return viewport;
    },
    get visible() {
      return visible;
    },
    has(capability) {
      return capabilities.has(capability);
    },
    request,
    async getState(key, fallback = null) {
      const result = await request("state.get", { key });
      const value = result && "value" in result ? result.value : null;
      return value === null || value === undefined ? fallback : value;
    },
    async setState(key, value) {
      await request("state.set", { key, value });
      return true;
    },
    async removeState(key) {
      await request("state.remove", { key });
      return true;
    },
    async requestAudio() {
      const result = await request("audio.request", {});
      return Boolean(result && result.granted);
    },
    async requestResize(width, height) {
      return request("resize.request", { width, height });
    },
    async startDrag() {
      await request("window.startDrag", {});
      return true;
    },
    async minimize() {
      await request("window.minimize", {});
      return true;
    },
    async setTransparent(transparent, color) {
      const next = Boolean(transparent);
      const result = await request("window.setTransparent", {
        transparent: next,
        color: typeof color === "string" ? color : null,
      });
      applyWindowBackground(next, typeof color === "string" ? color : null);
      client.transparent = next;
      return result;
    },
    async close() {
      await request("close", {});
      return true;
    },
    log(message, level = "log") {
      request("log", { level, message: String(message) }).catch(() => {});
    },
    onTheme(listener) {
      themeListeners.add(listener);
      if (theme) listener(theme);
      return () => themeListeners.delete(listener);
    },
    onViewport(listener) {
      viewportListeners.add(listener);
      listener(viewport);
      return () => viewportListeners.delete(listener);
    },
    onVisibility(listener) {
      visibilityListeners.add(listener);
      listener(visible);
      return () => visibilityListeners.delete(listener);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new LullWidgetError("disposed", "客户端已销毁。"));
      }
      pending.clear();
      themeListeners.clear();
      viewportListeners.clear();
      visibilityListeners.clear();
      sharedClient = null;
    },
  };
  return client;
}

function normalizeViewport(value) {
  if (!value || typeof value !== "object") {
    return { width: 0, height: 0, dpr: 1 };
  }
  return {
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    dpr: Number(value.dpr) || 1,
  };
}
