/**
 * 桥协议 v1 的线上格式（wire format）。
 *
 * 这一层是插件与宿主之间唯一的契约：宿主壳（`src/components/widget-plugin-shell.tsx`）
 * 按这里的结构收发消息，插件侧只通过 postMessage 说话。改动任何字段都必须同时改宿主壳、
 * `packages/widget-sdk` 与 `docs/widget-package.md`，并递增 `WIDGET_PROTOCOL`。
 */

/** 桥协议版本。破坏性变更才递增；当前与宿主 `PROTOCOL_VERSION` 必须一致。 */
export const WIDGET_PROTOCOL = 1 as const;

/** 清单允许声明的能力；宿主按 `.grants.json` 二次校验。 */
export const WIDGET_CAPABILITIES = [
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.network",
  "widget.chrome",
] as const;

export type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

/** 顶栏归属：`host` = 宿主绘制；`custom` = 插件自绘拖拽区。 */
export type WidgetChrome = "host" | "custom";

/** 清单 `window` 字段在运行时的形态（宿主已补齐 minWidth/minHeight 等默认值）。 */
export interface WidgetWindowSpec {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  transparent: boolean;
  chrome: WidgetChrome;
}

/** 宿主流光主题令牌，只读。 */
export interface WidgetTheme {
  id: string;
  colors: {
    a: string;
    b: string;
    c: string;
    accentLight: string;
    accentDark: string;
    onAccentLight: string;
    onAccentDark: string;
  };
}

export interface WidgetViewport {
  width: number;
  height: number;
  dpr: number;
}

export type WidgetLogLevel = "log" | "warn" | "error";

/** 宿主 → 插件：握手成功，客户端可用的全部上下文。 */
export interface WidgetInitMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "init";
  protocol: number;
  hostApi: number;
  id: string;
  name: string;
  version: string;
  entryUrl?: string;
  requested?: string[];
  granted?: string[];
  minimizable?: boolean;
  window?: WidgetWindowSpec;
  theme?: WidgetTheme | null;
  viewport?: Partial<WidgetViewport> | null;
  token: string;
}

/** 宿主 → 插件：主题变化。 */
export interface WidgetThemeMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "theme";
  theme: WidgetTheme | null;
}

/** 宿主 → 插件：窗口尺寸变化。 */
export interface WidgetViewportMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "viewport";
  viewport: WidgetViewport;
}

/** 宿主 → 插件：窗口可见性变化（隐藏到托盘时为 false）。 */
export interface WidgetVisibilityMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "visibility";
  visible: boolean;
}

/** 宿主 → 插件：请求结果。`ok=false` 时 `error` 为宿主给出的原因。 */
export interface WidgetResponseMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WidgetHostMessage =
  | WidgetInitMessage
  | WidgetThemeMessage
  | WidgetViewportMessage
  | WidgetVisibilityMessage
  | WidgetResponseMessage;

/** 插件 → 宿主：握手请求（插件侧 SDK 自动发送）。 */
export interface WidgetReadyMessage {
  v: typeof WIDGET_PROTOCOL;
  type: "ready";
  protocol: number;
}

/** 方法名 → 参数/返回值。新增方法先加在这里，再改宿主壳的 `handleRequest`。 */
export interface WidgetBridgeMethods {
  "state.get": { params: { key: string }; result: { value: unknown } };
  "state.set": {
    params: { key: string; value: unknown };
    result: { saved: boolean };
  };
  "state.remove": { params: { key: string }; result: { removed: boolean } };
  "audio.request": {
    params: Record<string, never>;
    result: { granted: boolean };
  };
  "resize.request": {
    params: { width: number; height: number };
    result: WidgetViewport & { applied: boolean };
  };
  "window.startDrag": {
    params: Record<string, never>;
    result: { dragging: boolean };
  };
  "window.minimize": {
    params: Record<string, never>;
    result: { minimized: boolean };
  };
  "window.setTransparent": {
    params: { transparent: boolean; color: string | null };
    result: { transparent: boolean };
  };
  close: { params: Record<string, never>; result: { closed: boolean } };
  log: {
    params: { level: WidgetLogLevel; message: string };
    result: { logged: boolean };
  };
}

export type WidgetBridgeMethod = keyof WidgetBridgeMethods;
export type WidgetBridgeParams<M extends WidgetBridgeMethod> =
  WidgetBridgeMethods[M]["params"];
export type WidgetBridgeResult<M extends WidgetBridgeMethod> =
  WidgetBridgeMethods[M]["result"];

/** 插件 → 宿主：一次方法调用（`token` 由宿主 init 下发，用于防冒名）。 */
export interface WidgetRequestMessage<
  M extends WidgetBridgeMethod = WidgetBridgeMethod,
> {
  v: typeof WIDGET_PROTOCOL;
  type: "request";
  id: number;
  method: M;
  params: WidgetBridgeParams<M>;
  token: string;
}

export type WidgetClientMessage = WidgetReadyMessage | WidgetRequestMessage;

/** 能力名是否在清单白名单内（宿主下发的 `granted` 可能是任意字符串）。 */
export function isWidgetCapability(value: unknown): value is WidgetCapability {
  return (
    typeof value === "string" &&
    (WIDGET_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** 收包的最低门槛：版本一致且带 `type`。字段级校验交给具体分支。 */
export function isWidgetHostMessage(
  value: unknown,
): value is WidgetHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.v === WIDGET_PROTOCOL && typeof record.type === "string";
}

/** 把宿主给的 `viewport` 归一化，坏数据回落到 0 尺寸而不是 NaN。 */
export function normalizeViewport(value: unknown): WidgetViewport {
  if (typeof value !== "object" || value === null) {
    return { width: 0, height: 0, dpr: 1 };
  }
  const record = value as Record<string, unknown>;
  return {
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    dpr: Number(record.dpr) || 1,
  };
}
