/**
 * 插件侧客户端：握手、typed request、状态 KV、主题/视口/可见性订阅。
 *
 * 只依赖 `WidgetBridgeTransport`，不假设自己跑在 iframe 里——
 * 默认传输是 `window.postMessage`，测试或其它宿主可以注入自己的实现。
 */
import { LullWidgetError } from "./errors.js";
import {
  isWidgetCapability,
  normalizeViewport,
  WIDGET_PROTOCOL,
  type WidgetBridgeMethod,
  type WidgetBridgeParams,
  type WidgetBridgeResult,
  type WidgetCapability,
  type WidgetInitMessage,
  type WidgetLogLevel,
  type WidgetTheme,
  type WidgetViewport,
  type WidgetWindowSpec,
} from "./protocol.js";
import {
  createDomTransport,
  isEmbedded,
  readyMessage,
  type WidgetBridgeTransport,
} from "./transport.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_INIT_TIMEOUT_MS = 10000;

export interface ConnectLullWidgetOptions {
  /** 握手超时，默认 10s。宿主 8s 也会报“未响应”，这里留一点余量。 */
  timeoutMs?: number;
  /** 自定义传输（测试/非标准宿主）；传入后不再复用全局单例。 */
  transport?: WidgetBridgeTransport;
}

export interface LullWidgetClientOptions {
  transport?: WidgetBridgeTransport;
  /** 单次请求超时，默认 8s。 */
  requestTimeoutMs?: number;
}

export interface LullWidgetClient {
  /** 桥协议版本。 */
  readonly protocol: number;
  /** 插件 id（等于包目录名）。 */
  readonly id: string;
  /** 宿主 API 版本，对应清单 `compatibility.hostApi`。 */
  readonly hostApi: number;
  /** 当前窗口是否允许最小化。 */
  readonly minimizable: boolean;
  /** 窗口当前是否透明（`setTransparent` 会更新）。 */
  readonly transparent: boolean;
  readonly window: WidgetWindowSpec | null;
  /** 宿主已授予的能力（清单声明 ∩ 用户授权）。 */
  readonly capabilities: WidgetCapability[];
  readonly theme: WidgetTheme | null;
  readonly viewport: WidgetViewport;
  readonly visible: boolean;

  /** 能力查询；未声明的能力恒为 false。 */
  has(capability: WidgetCapability | string): boolean;
  /** 直接调用桥方法；内置方法见 `WidgetBridgeMethods`。 */
  request<M extends WidgetBridgeMethod>(
    method: M,
    params?: WidgetBridgeParams<M>,
  ): Promise<WidgetBridgeResult<M>>;

  getState<T = unknown>(key: string): Promise<T | null>;
  getState<T>(key: string, fallback: T): Promise<T>;
  setState<T>(key: string, value: T): Promise<void>;
  removeState(key: string): Promise<void>;

  /** 音频是否被授权（未声明 `widget.audio` 时返回 false）。 */
  requestAudio(): Promise<boolean>;
  /**
   * 请求宿主调整内容区尺寸。v1 宿主只回报当前测量值（`applied: false`），
   * 不会真的改窗口大小——窗口尺寸由清单与宿主偏好决定。
   */
  requestResize(
    width: number,
    height: number,
  ): Promise<WidgetViewport & { applied: boolean }>;

  startDrag(): Promise<void>;
  minimize(): Promise<void>;
  setTransparent(transparent: boolean, color?: string | null): Promise<void>;
  close(): Promise<void>;
  log(message: unknown, level?: WidgetLogLevel): void;

  onTheme(listener: (theme: WidgetTheme) => void): () => void;
  onViewport(listener: (viewport: WidgetViewport) => void): () => void;
  onVisibility(listener: (visible: boolean) => void): () => void;

  /** 退订全部监听、拒绝未完成请求；之后所有调用返回 `disposed` 错误。 */
  destroy(): void;
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
};

let shared: Promise<LullWidgetClient> | null = null;

/**
 * 连接宿主。必须在宿主 iframe 内调用；同一页面重复调用返回同一个 Promise。
 *
 * ```ts
 * const lull = await connectLullWidget();
 * const count = await lull.getState("count", 0);
 * ```
 */
export function connectLullWidget(
  options: ConnectLullWidgetOptions = {},
): Promise<LullWidgetClient> {
  if (!options.transport && shared) return shared;
  const promise = handshake(options);
  if (!options.transport) {
    shared = promise;
    // 失败后允许重试：宿主可能只是还没加载完。
    promise.catch(() => {
      if (shared === promise) shared = null;
    });
  }
  return promise;
}

function handshake(
  options: ConnectLullWidgetOptions,
): Promise<LullWidgetClient> {
  return new Promise<LullWidgetClient>((resolve, reject) => {
    if (!options.transport && !isEmbedded()) {
      reject(
        new LullWidgetError(
          "not-embedded",
          "Lull Widget 必须在宿主 iframe 中运行。",
        ),
      );
      return;
    }

    const transport = options.transport ?? createDomTransport();
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : DEFAULT_INIT_TIMEOUT_MS;
    let settled = false;
    let stop: (() => void) | null = null;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      stop?.();
      reject(new LullWidgetError("init-timeout", "宿主未在超时前完成初始化。"));
    }, timeoutMs);

    stop = transport.listen((message) => {
      // 只认 init；repeat 的 init（宿主重发）在 settled 后忽略。
      if (settled || message.type !== "init") return;
      settled = true;
      window.clearTimeout(timer);
      stop?.();
      try {
        resolve(createLullWidgetClient(message, { transport }));
      } catch (error) {
        reject(error);
      }
    });

    transport.post(readyMessage());
  });
}

/**
 * 用一条已收到的 `init` 消息构造客户端。
 * 一般由 `connectLullWidget` 调用；需要自己管握手（例如多次挂载）时才直接用。
 */
export function createLullWidgetClient(
  init: WidgetInitMessage,
  options: LullWidgetClientOptions = {},
): LullWidgetClient {
  if (init.v !== WIDGET_PROTOCOL) {
    throw new LullWidgetError(
      "bad-init",
      `桥协议版本不匹配：宿主 ${String(init.v)}，SDK ${String(WIDGET_PROTOCOL)}。`,
    );
  }
  if (typeof init.token !== "string" || init.token.length === 0) {
    throw new LullWidgetError("bad-init", "宿主 init 消息缺少 token。");
  }

  const transport = options.transport ?? createDomTransport();
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Number(options.requestTimeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const token = init.token;

  const capabilities = new Set<WidgetCapability>();
  for (const capability of init.granted ?? []) {
    if (isWidgetCapability(capability)) capabilities.add(capability);
  }

  const state = {
    theme: init.theme ?? null,
    viewport: normalizeViewport(init.viewport),
    visible: true,
    transparent: Boolean(init.window?.transparent),
  };

  if (init.window?.transparent === false) {
    applyWindowBackground(false, null);
  }

  let sequence = 0;
  let disposed = false;
  const pending = new Map<number, PendingEntry>();
  const themeListeners = new Set<(theme: WidgetTheme) => void>();
  const viewportListeners = new Set<(viewport: WidgetViewport) => void>();
  const visibilityListeners = new Set<(visible: boolean) => void>();

  const stopListening = transport.listen((message) => {
    switch (message.type) {
      case "theme": {
        if (!message.theme) return;
        state.theme = message.theme;
        for (const listener of themeListeners) listener(message.theme);
        return;
      }
      case "viewport": {
        state.viewport = normalizeViewport(message.viewport);
        for (const listener of viewportListeners) listener(state.viewport);
        return;
      }
      case "visibility": {
        state.visible = message.visible !== false;
        for (const listener of visibilityListeners) listener(state.visible);
        return;
      }
      case "response": {
        if (typeof message.id !== "number") return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        window.clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message.result);
        } else {
          entry.reject(
            new LullWidgetError("host-error", message.error || "宿主请求失败"),
          );
        }
        return;
      }
      case "init":
        // 握手已经在 connectLullWidget 完成；重复 init 不重建客户端。
        return;
    }
  });

  function request<M extends WidgetBridgeMethod>(
    method: M,
    params?: WidgetBridgeParams<M>,
  ): Promise<WidgetBridgeResult<M>> {
    if (disposed) {
      return Promise.reject(new LullWidgetError("disposed", "客户端已销毁。"));
    }
    const id = ++sequence;
    return new Promise<WidgetBridgeResult<M>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new LullWidgetError("timeout", `宿主未响应 ${method}。`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => resolve(value as WidgetBridgeResult<M>),
        reject,
        timer,
      });
      transport.post({
        v: WIDGET_PROTOCOL,
        type: "request",
        id,
        method,
        params: (params ?? {}) as WidgetBridgeParams<M>,
        token,
      });
    });
  }

  function getStateImpl<T>(key: string, fallback?: T): Promise<T | null> {
    return request("state.get", { key }).then((result) => {
      const value =
        result && typeof result === "object" && "value" in result
          ? (result.value as T | null | undefined)
          : null;
      return value === null || value === undefined
        ? ((fallback ?? null) as T | null)
        : value;
    });
  }

  const client: LullWidgetClient = {
    protocol: WIDGET_PROTOCOL,
    id: init.id,
    hostApi: init.hostApi,
    minimizable: Boolean(init.minimizable),
    get transparent() {
      return state.transparent;
    },
    window: init.window ?? null,
    capabilities: [...capabilities],
    get theme() {
      return state.theme;
    },
    get viewport() {
      return state.viewport;
    },
    get visible() {
      return state.visible;
    },

    has(capability) {
      return capabilities.has(capability as WidgetCapability);
    },
    request,
    // 重载签名与实现签名不同，这里收窄为接口声明。
    getState: getStateImpl as LullWidgetClient["getState"],

    async setState(key, value) {
      await request("state.set", { key, value });
    },
    async removeState(key) {
      await request("state.remove", { key });
    },

    async requestAudio() {
      const result = await request("audio.request", {});
      return Boolean(result?.granted);
    },
    async requestResize(width, height) {
      return request("resize.request", { width, height });
    },

    async startDrag() {
      await request("window.startDrag", {});
    },
    async minimize() {
      await request("window.minimize", {});
    },
    async setTransparent(transparent, color = null) {
      const next = Boolean(transparent);
      const nextColor = typeof color === "string" ? color : null;
      await request("window.setTransparent", {
        transparent: next,
        color: nextColor,
      });
      applyWindowBackground(next, nextColor);
      state.transparent = next;
    },
    async close() {
      await request("close", {});
    },
    log(message, level = "log") {
      void request("log", { level, message: String(message) }).catch(() => {
        // 日志失败不影响插件主流程。
      });
    },

    onTheme(listener) {
      themeListeners.add(listener);
      if (state.theme) listener(state.theme);
      return () => {
        themeListeners.delete(listener);
      };
    },
    onViewport(listener) {
      viewportListeners.add(listener);
      listener(state.viewport);
      return () => {
        viewportListeners.delete(listener);
      };
    },
    onVisibility(listener) {
      visibilityListeners.add(listener);
      listener(state.visible);
      return () => {
        visibilityListeners.delete(listener);
      };
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      stopListening();
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new LullWidgetError("disposed", "客户端已销毁。"));
      }
      pending.clear();
      themeListeners.clear();
      viewportListeners.clear();
      visibilityListeners.clear();
      shared = null;
    },
  };

  return client;
}

/** 非透明窗口由插件自己铺底色，避免 WebView 透出桌面。 */
function applyWindowBackground(
  transparent: boolean,
  color: string | null,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const body = document.body;
  if (transparent) {
    root.style.removeProperty("background-color");
    body.style.removeProperty("background-color");
    return;
  }
  const value = color ?? "#f6f3ec";
  root.style.backgroundColor = value;
  body.style.backgroundColor = value;
}
