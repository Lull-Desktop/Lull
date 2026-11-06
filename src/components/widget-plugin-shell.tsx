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
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hideWindowSilently,
  isDesktopWindow,
  minimizeWindow,
} from "@/core/window/controls";
import { listenGameEvent } from "@/games/bridge/game-events";
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
  /** none = 固定尺寸；content = 允许按内容高度调整。 */
  fit?: "none" | "content";
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
  /** 声明了功能槽位的 Provider 必须等 SDK ready，不能只等 iframe load。 */
  provider?: boolean;
  locale?: string;
  minimizable: boolean;
  window: PluginWindow;
  bridgeToken: string;
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
  tokens: Record<string, string>;
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
/** 桥允许插件打开 / 关闭 / 查询的窗口白名单。 */
const BRIDGE_WINDOW_KINDS = ["library", "settings"] as const;

/** Widget 可申请的游戏能力；宿主壳按能力把请求转发给 `game_*` 命令。 */
const GAME_BRIDGE_CAPABILITIES = [
  "game.state.read",
  "game.command.send",
  "game.event.read",
] as const;

/** 是否持有任一游戏能力；单独的能力门控在各分支里做。 */
function hasGameBridgeCapability(context: PluginContext | null): boolean {
  return (
    context?.granted.some((capability) =>
      (GAME_BRIDGE_CAPABILITIES as readonly string[]).includes(capability),
    ) ?? false
  );
}

/** 白名单校验：不在名单里的 kind 一律当非法，避免插件探测任意窗口。 */
function bridgeWindowKind(value: unknown): string | null {
  return typeof value === "string" &&
    (BRIDGE_WINDOW_KINDS as readonly string[]).includes(value)
    ? value
    : null;
}

function isPluginContext(value: unknown): value is PluginContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.entryUrl === "string" &&
    Array.isArray(record.granted) &&
    typeof record.bridgeToken === "string" &&
    typeof record.window === "object"
  );
}

/** 下发给插件的 CSS 变量白名单；包内 fallback 只用这些名字。 */
const THEME_TOKEN_KEYS = [
  "--font-body",
  "--font-sans",
  "--font-serif",
  "--font-mono",
  "--paper",
  "--paper-warm",
  "--paper-deep",
  "--ink",
  "--ink-soft",
  "--bamboo",
  "--bamboo-light",
  "--bamboo-mist",
  "--bamboo-glow",
  "--flow-a",
  "--flow-b",
  "--flow-c",
  "--flow-accent",
  "--flow-accent-surface",
  "--flow-accent-ink",
  "--color-primary",
  "--color-accent",
  "--radius",
  "--radius-sm",
  "--radius-lg",
] as const;

function readThemeTokens(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const style = window.getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    const value = style.getPropertyValue(key).trim();
    if (value) tokens[key] = value;
  }
  return tokens;
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
    tokens: readThemeTokens(),
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
  const devServer = context?.entryUrl ?? "";
  const isDevServer =
    /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(
      devServer,
    );
  const fitContent = context?.window.fit === "content";

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

  useEffect(() => {
    if (!context) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<unknown>("media:event", (event) => {
      send({
        v: PROTOCOL_VERSION,
        type: "media.event",
        event: event.payload,
      });
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览/单测没有 Tauri 事件系统；媒体事件不可用。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [context, send]);

  // 游戏事件转发：宿主壳持有 Tauri IPC，插件只能通过 postMessage 收到
  // game.snapshot / game.event / game.lifecycle。未授权 game.* 时不注册。
  useEffect(() => {
    if (!hasGameBridgeCapability(context)) return;
    let disposed = false;
    const stops: Array<() => void> = [];
    const forward = (
      eventName: string,
      type: string,
      key: "snapshot" | "event",
    ): void => {
      void listenGameEvent<unknown>(eventName, (event) => {
        send({ v: PROTOCOL_VERSION, type, [key]: event.payload });
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stops.push(unlisten);
        })
        .catch(() => {
          // 浏览器预览 / 单测没有 Tauri 事件系统。
        });
    };
    forward("game:snapshot", "game.snapshot", "snapshot");
    forward("game:event", "game.event", "event");
    forward("game:lifecycle", "game.lifecycle", "event");
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [context, send]);

  // 工具窗可见性同步：用户直接点库窗口的关闭按钮、或从托盘/设置页隐藏时，
  // 插件里的开关也要跟着熄灭。事件本身只表示「可能变了」，状态再拉一次。
  useEffect(() => {
    if (!context || !context.granted.includes("widget.chrome")) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    const pushWindowState = (kind: string): void => {
      void invoke<boolean>("widget_visibility", { kind })
        .then((visible) => {
          if (disposed) return;
          send({
            v: PROTOCOL_VERSION,
            type: "window.state",
            kind,
            visible: visible === true,
          });
        })
        .catch(() => {
          // 窗口未创建或命令不可用时忽略：插件仍可自己查询。
        });
    };
    void listen("widgets-changed", () => {
      for (const kind of BRIDGE_WINDOW_KINDS) pushWindowState(kind);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri 事件系统。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [context, send]);

  // 工具窗内部页签同步：库窗口切换页签时广播，插件据此区分「再点一次」
  // 是关闭窗口还是切页签，开关按钮的高亮也跟住真实页签。
  useEffect(() => {
    if (!context || !context.granted.includes("widget.chrome")) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<{ tab?: string }>("library-tab-changed", (event) => {
      const tab =
        typeof event.payload?.tab === "string" ? event.payload.tab : "";
      if (!tab) return;
      send({
        v: PROTOCOL_VERSION,
        type: "window.state",
        kind: "library",
        visible: true,
        tab,
      });
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri 事件系统。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [context, send]);

  // 设置窗的页签 / 曲库分类同步：播放器的队列 / 收藏齿轮落在设置窗的「音乐」页。
  useEffect(() => {
    if (!context || !context.granted.includes("widget.chrome")) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<{ tab?: string; category?: string | null }>(
      "settings-music-changed",
      (event) => {
        const category =
          typeof event.payload?.category === "string"
            ? event.payload.category
            : "";
        send({
          v: PROTOCOL_VERSION,
          type: "window.state",
          kind: "settings",
          visible: true,
          ...(category ? { tab: category } : {}),
        });
      },
    )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri 事件系统。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [context, send]);

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
      locale: context.locale ?? "zh-CN",
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

  // Slot 切换事务在 Rust 侧等待这个信号；普通打开时它只是 no-op。
  const reportReady = useCallback(() => {
    void invoke("widget_package_ready").catch(() => {});
  }, []);

  const closePluginWindow = useCallback(async () => {
    await hideWindowSilently();
    await invoke("widget_package_notify").catch(() => {});
  }, []);

  const handleFrameLoad = useCallback(() => {
    // 普通 Widget 可以把 iframe load 当作可用；Provider 必须等 SDK ready，
    // 否则坏包/未响应的 dev server 会被 Slot 误判为 active。
    setError(null);
    sendInit();
    if (context?.provider === true) return;
    // 插件可能在上面的监听器注册前就 postMessage("ready")；
    // 这里补一次 init，并把窗口显示出来，避免握手消息丢失时永远隐藏。
    setReady(true);
    reportReady();
    if (!fitContent) revealWindow();
  }, [context?.provider, fitContent, reportReady, revealWindow, sendInit]);

  // fit=content 的包等第一次成功贴高再显示；插件没发 resize 时兜底。
  useEffect(() => {
    if (!context || !fitContent || !ready) return;
    const timer = window.setTimeout(() => revealWindow(), 1500);
    return () => window.clearTimeout(timer);
  }, [context, fitContent, ready, revealWindow]);

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
        case "media.call": {
          if (!context?.granted.includes("widget.media")) {
            throw new Error("未获得 widget.media 权限");
          }
          const request =
            params.request && typeof params.request === "object"
              ? (params.request as Record<string, unknown>)
              : {};
          return invoke("media_call", {
            request: { ...request, bridgeToken: context.bridgeToken },
          });
        }
        case "media.connect": {
          if (!context?.granted.includes("widget.media")) {
            throw new Error("未获得 widget.media 权限");
          }
          const request =
            params.request && typeof params.request === "object"
              ? (params.request as Record<string, unknown>)
              : {};
          return invoke("media_connect", {
            request: { ...request, bridgeToken: context.bridgeToken },
          });
        }
        case "media.disconnect": {
          if (!context?.granted.includes("widget.media")) {
            throw new Error("未获得 widget.media 权限");
          }
          await invoke("media_disconnect", {
            bridgeToken: context.bridgeToken,
          });
          return { disconnected: true };
        }
        case "game.connect": {
          if (!context || !hasGameBridgeCapability(context)) {
            throw new Error("未获得游戏能力授权");
          }
          // gameId 可省略：从设置页/托盘打开的控制器由宿主记录目标游戏。
          const gameId =
            typeof params.gameId === "string" ? params.gameId.trim() : "";
          return invoke("game_connect", {
            request: gameId ? { gameId } : {},
            token: context.bridgeToken,
          });
        }
        case "game.snapshot": {
          if (!context || !context.granted.includes("game.state.read")) {
            throw new Error("未获得 game.state.read 权限");
          }
          return invoke("game_snapshot_get", {
            token: context.bridgeToken,
          });
        }
        case "game.command": {
          if (!context || !context.granted.includes("game.command.send")) {
            throw new Error("未获得 game.command.send 权限");
          }
          const requestId =
            typeof params.requestId === "string" ? params.requestId : "";
          const type = typeof params.type === "string" ? params.type : "";
          if (!requestId || !type) {
            throw new Error("game.command 缺少 requestId 或 type");
          }
          const request: Record<string, unknown> = {
            requestId,
            type,
            payload: params.payload ?? null,
          };
          if (typeof params.expectedRevision === "number") {
            request.expectedRevision = params.expectedRevision;
          }
          return invoke("game_command_send", {
            request,
            token: context.bridgeToken,
          });
        }
        case "game.disconnect": {
          if (!context || !hasGameBridgeCapability(context)) {
            throw new Error("未获得游戏能力授权");
          }
          await invoke("game_detach", {
            token: context.bridgeToken,
          });
          return { disconnected: true };
        }
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
        case "window.alignPlayer": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          const currentSide = params.currentSide === "right" ? "right" : "left";
          const nextSide = params.nextSide === "right" ? "right" : "left";
          const width = typeof params.width === "number" ? params.width : 0;
          const playerAnchor =
            typeof params.playerAnchor === "number" ? params.playerAnchor : 0;
          return invoke<Viewport & { applied: boolean }>(
            "widget_align_player",
            { currentSide, nextSide, width, playerAnchor },
          );
        }
        case "window.open": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          // 只允许打开白名单内的工具窗口；页签由工具窗口自行校验。
          const kind = bridgeWindowKind(params.kind);
          if (!kind) {
            throw new Error(`不支持打开窗口：${String(params.kind ?? "")}`);
          }
          const tab =
            typeof params.tab === "string" && params.tab ? params.tab : null;
          await invoke("widget_open", { kind, tab });
          return { opened: true };
        }
        case "window.close": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          const kind = bridgeWindowKind(params.kind);
          if (!kind) {
            throw new Error(`不支持关闭窗口：${String(params.kind ?? "")}`);
          }
          await invoke("widget_close", { kind });
          return { closed: true };
        }
        case "window.isOpen": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          const kind = bridgeWindowKind(params.kind);
          if (!kind) {
            throw new Error(`不支持查询窗口：${String(params.kind ?? "")}`);
          }
          const visible = await invoke<boolean>("widget_visibility", { kind });
          return { visible: visible === true };
        }
        case "close":
          await closePluginWindow();
          return { closed: true };
        case "resize.request": {
          if (!context?.granted.includes("widget.chrome")) {
            throw new Error("未获得 widget.chrome 权限");
          }
          const width =
            typeof params.width === "number" ? params.width : undefined;
          const height =
            typeof params.height === "number" ? params.height : undefined;
          const anchor =
            params.anchor === "left" || params.anchor === "right"
              ? params.anchor
              : undefined;
          const result = await invoke<Viewport & { applied: boolean }>(
            "widget_apply_resize",
            { width, height, anchor },
          );
          if (result.applied && fitContent) revealWindow();
          return result;
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
    [closePluginWindow, context, fitContent, revealWindow],
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
        reportReady();
        if (!fitContent) revealWindow();
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
  }, [
    context,
    fitContent,
    handleRequest,
    reportReady,
    revealWindow,
    send,
    sendInit,
  ]);

  useEffect(() => {
    if (!context || !readyRef.current) return;
    if (!context.granted.includes("widget.theme")) return;
    send({
      v: PROTOCOL_VERSION,
      type: "theme",
      theme: themePayload(themeId, theme),
    });
  }, [context, send, theme, themeId]);

  useEffect(() => {
    if (!context) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<{ locale?: string }>("i18n-locale-changed", (event) => {
      const locale = event.payload?.locale;
      if (typeof locale === "string") {
        send({ v: PROTOCOL_VERSION, type: "locale", locale });
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri 事件系统。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [context, send]);

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
      setError(
        isDevServer
          ? "开发服务器未响应。确认 `pnpm extensions:dev <id>` 正在运行，且端口与 .lull-dev.json 一致。"
          : "插件未在 8 秒内响应。请检查包内容或重新打开窗口。",
      );
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [context, ready, isDevServer]);

  const title = useMemo(
    () => (context ? `${context.name} ${context.version}` : "自定义插件"),
    [context],
  );
  const customChrome =
    context?.window.chrome === "custom" &&
    (context.granted.includes("widget.chrome") ?? false);
  const devHost = isDevServer ? new URL(devServer).host : "";

  return (
    <div
      className={styles.shell}
      data-testid="widget-plugin-shell"
      style={{ backgroundColor: windowBackground ?? "transparent" }}
    >
      {isDevServer && (
        <span className={styles.devBadge} data-testid="widget-dev-badge">
          DEV · {devHost}
        </span>
      )}
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
              onClick={() => void closePluginWindow()}
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
