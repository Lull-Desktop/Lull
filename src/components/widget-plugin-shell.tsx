/**
 * 第三方插件宿主壳：宿主绘制顶栏，iframe 只承载插件内容。
 *
 * 安全边界：
 * - iframe 使用 `sandbox="allow-scripts"`（不透明源），拿不到宿主 DOM、localStorage 或 Tauri IPC；
 * - 所有能力经 postMessage 桥由宿主校验后转发；
 * - 只有 `widget_state_*` 命令对 `widget-*` 窗口开放（见 capabilities/window-widgets.json）。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hideWindow,
  isDesktopWindow,
  minimizeWindow,
} from "@/core/window/controls";
import { useFlowTheme } from "@/hooks/use-flow-theme";
import type { FlowTheme, FlowThemeId } from "@/lib/flow-theme";
import styles from "./widget-plugin-shell.module.css";

type PluginWindow = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  transparent: boolean;
  /** host = 宿主顶栏；custom = 插件自绘拖拽区与窗口按钮。 */
  chrome?: "host" | "custom";
};

type PluginContext = {
  v: number;
  protocol: number;
  hostApi: number;
  id: string;
  name: string;
  version: string;
  entryUrl: string;
  requested: string[];
  granted: string[];
  minimizable: boolean;
  window: PluginWindow;
};

type ThemePayload = {
  id: FlowThemeId;
  colors: {
    a: string;
    b: string;
    c: string;
    accentLight: string;
    accentDark: string;
    onAccentLight: string;
    onAccentDark: string;
  };
};

type Viewport = {
  width: number;
  height: number;
  dpr: number;
};

type BridgeMessage = {
  v?: number;
  type?: string;
  id?: number;
  token?: string;
  method?: string;
  params?: Record<string, unknown>;
};

declare global {
  interface Window {
    __LULL_PLUGIN__?: PluginContext;
  }
}

const PROTOCOL_VERSION = 1;
const READY_TIMEOUT_MS = 8000;

function isPluginContext(value: unknown): value is PluginContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.entryUrl === "string" &&
    Array.isArray(record.granted) &&
    typeof record.window === "object"
  );
}

function themePayload(themeId: FlowThemeId, theme: FlowTheme): ThemePayload {
  return {
    id: themeId,
    colors: {
      a: theme.a,
      b: theme.b,
      c: theme.c,
      accentLight: theme.accentLight,
      accentDark: theme.accentDark,
      onAccentLight: theme.onAccentLight,
      onAccentDark: theme.onAccentDark,
    },
  };
}

function measure(frame: HTMLIFrameElement | null): Viewport | null {
  if (!frame) return null;
  const width = Math.round(frame.clientWidth);
  const height = Math.round(frame.clientHeight);
  if (width <= 0 || height <= 0) return null;
  return {
    width,
    height,
    dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  };
}

function randomToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function WidgetPluginShell() {
  const [context, setContext] = useState<PluginContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [windowBackground, setWindowBackground] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef(randomToken());
  const themeRef = useRef<ThemePayload | null>(null);
  const readyRef = useRef(false);
  const { themeId, theme } = useFlowTheme();
  themeRef.current = themePayload(themeId, theme);
  readyRef.current = ready;

  useEffect(() => {
    if (!context) return;
    setWindowBackground(context.window.transparent ? null : "#f6f3ec");
  }, [context]);

  useEffect(() => {
    const injected = window.__LULL_PLUGIN__;
    if (isPluginContext(injected)) {
      setContext(injected);
    } else {
      setError("没有找到插件上下文：请从设置页打开插件。");
    }
    const root = document.documentElement;
    root.classList.add("lull-transparent-window");
    return () => root.classList.remove("lull-transparent-window");
  }, []);

  const send = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const sendInit = useCallback(() => {
    if (!context) return;
    const viewport = measure(iframeRef.current);
    if (!viewport) return;
    send({
      v: PROTOCOL_VERSION,
      type: "init",
      protocol: PROTOCOL_VERSION,
      hostApi: context.hostApi,
      id: context.id,
      name: context.name,
      version: context.version,
      granted: context.granted,
      requested: context.requested,
      theme: themeRef.current,
      viewport,
      minimizable: context.minimizable,
      window: context.window,
      token: tokenRef.current,
    });
  }, [context, send]);

  const revealWindow = useCallback(() => {
    if (!isDesktopWindow()) return;
    const window = getCurrentWindow();
    void window.show().catch(() => {});
    void window.setFocus().catch(() => {});
  }, []);

  const handleFrameLoad = useCallback(() => {
    // 插件可能在上面的监听器注册前就 postMessage("ready")；
    // 这里补一次 init，并把窗口显示出来，避免握手消息丢失时永远隐藏。
    setReady(true);
    setError(null);
    sendInit();
    revealWindow();
  }, [revealWindow, sendInit]);

  const handleRequest = useCallback(
    async (message: BridgeMessage): Promise<Record<string, unknown>> => {
      const params = message.params ?? {};
      switch (message.method) {
        case "state.get": {
          const key = String(params.key ?? "");
          const value = await invoke<unknown>("widget_state_get", { key });
          return { value: value ?? null };
        }
        case "state.set": {
          await invoke("widget_state_set", {
            key: String(params.key ?? ""),
            value: params.value ?? null,
          });
          return { saved: true };
        }
        case "state.remove": {
          await invoke("widget_state_remove", {
            key: String(params.key ?? ""),
          });
          return { removed: true };
        }
        case "audio.request":
          return {
            granted: context?.granted.includes("widget.audio") ?? false,
          };
        case "window.startDrag": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          if (!isDesktopWindow()) throw new Error("仅桌面窗口支持拖拽");
          await getCurrentWindow().startDragging();
          return { dragging: true };
        }
        case "window.minimize": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          if (!context.minimizable) {
            throw new Error("当前窗口未启用最小化");
          }
          await minimizeWindow();
          return { minimized: true };
        }
        case "window.setTransparent": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          const transparent = params.transparent !== false;
          const color =
            typeof params.color === "string" &&
            /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(params.color)
              ? params.color
              : "#f6f3ec";
          setWindowBackground(transparent ? null : color);
          await invoke("widget_set_transparent", {
            transparent,
            color: transparent ? null : color,
          }).catch(() => {});
          return { transparent };
        }
        case "close":
          await hideWindow();
          return { closed: true };
        case "resize.request": {
          const viewport = measure(iframeRef.current) ?? {
            width: 0,
            height: 0,
            dpr: 1,
          };
          return { ...viewport, applied: false };
        }
        case "log": {
          const level =
            params.level === "error"
              ? "error"
              : params.level === "warn"
                ? "warn"
                : "log";
          console[level](
            `[plugin:${context?.id ?? "unknown"}]`,
            params.message,
          );
          return { logged: true };
        }
        default:
          throw new Error(`不支持的桥方法：${message.method ?? "unknown"}`);
      }
    },
    [context],
  );

  useEffect(() => {
    if (!context) return;
    const onMessage = (event: MessageEvent): void => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as BridgeMessage;
      if (message.v !== PROTOCOL_VERSION) return;

      if (message.type === "ready") {
        setReady(true);
        setError(null);
        sendInit();
        revealWindow();
        return;
      }
      if (message.type !== "request") return;
      if (
        message.token !== tokenRef.current ||
        typeof message.id !== "number"
      ) {
        return;
      }
      const requestId = message.id;
      void handleRequest(message)
        .then((result) => {
          send({
            v: PROTOCOL_VERSION,
            type: "response",
            id: requestId,
            ok: true,
            result,
            token: tokenRef.current,
          });
        })
        .catch((requestError: unknown) => {
          send({
            v: PROTOCOL_VERSION,
            type: "response",
            id: requestId,
            ok: false,
            error:
              requestError instanceof Error
                ? requestError.message
                : String(requestError),
            token: tokenRef.current,
          });
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [context, handleRequest, revealWindow, send, sendInit]);

  useEffect(() => {
    if (!context || !readyRef.current) return;
    send({
      v: PROTOCOL_VERSION,
      type: "theme",
      theme: themePayload(themeId, theme),
    });
  }, [context, send, theme, themeId]);

  useEffect(() => {
    if (!context) return;
    const frame = iframeRef.current;
    if (!frame) return;
    const sendViewport = (): void => {
      const viewport = measure(frame);
      if (viewport) {
        send({ v: PROTOCOL_VERSION, type: "viewport", viewport });
      }
    };
    sendViewport();
    const observer = new ResizeObserver(sendViewport);
    observer.observe(frame);
    window.addEventListener("resize", sendViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sendViewport);
    };
  }, [context, send]);

  useEffect(() => {
    if (!context) return;
    const sendVisibility = (): void => {
      send({
        v: PROTOCOL_VERSION,
        type: "visibility",
        visible: document.visibilityState === "visible",
      });
    };
    document.addEventListener("visibilitychange", sendVisibility);
    sendVisibility();
    return () =>
      document.removeEventListener("visibilitychange", sendVisibility);
  }, [context, send]);

  useEffect(() => {
    if (ready || !context) return;
    const timer = window.setTimeout(() => {
      setError("插件未在 8 秒内响应。请检查包内容或重新打开窗口。");
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [context, ready]);

  const title = useMemo(
    () => (context ? `${context.name} ${context.version}` : "自定义插件"),
    [context],
  );
  const customChrome = context?.window.chrome === "custom";

  return (
    <div
      className={styles.shell}
      data-testid="widget-plugin-shell"
      style={{ backgroundColor: windowBackground ?? "transparent" }}
    >
      {!customChrome && (
        <header className={styles.topbar} data-tauri-drag-region="deep">
          <div className={styles.brand}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.name}>{context?.name ?? "自定义插件"}</span>
            <span className={styles.version}>{context?.version ?? ""}</span>
          </div>
          <div className={styles.actions}>
            {context?.minimizable && (
              <button
                type="button"
                className={styles.button}
                aria-label="最小化"
                title="最小化"
                onClick={() => void minimizeWindow()}
              >
                <Minus aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={styles.button}
              aria-label="关闭窗口"
              title="关闭（隐藏到托盘）"
              onClick={() => void hideWindow()}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
      )}

      {error && (
        <div className={styles.overlay} role="alert">
          <p>{error}</p>
          <button
            type="button"
            className={styles.reload}
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      )}

      {context ? (
        <iframe
          ref={iframeRef}
          className={styles.frame}
          src={context.entryUrl}
          title={title}
          sandbox="allow-scripts"
          allow="autoplay"
          referrerPolicy="no-referrer"
          onLoad={handleFrameLoad}
        />
      ) : null}
    </div>
  );
}
