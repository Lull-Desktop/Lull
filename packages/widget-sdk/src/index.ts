/**
 * `@lull/widget-sdk` 公共入口。
 *
 * 第三方插件只需要：
 * ```ts
 * import { connectLullWidget } from "@lull/widget-sdk";
 * ```
 * React / Vue 适配在子路径里，避免没有用到框架的插件被迫加载 peer 依赖。
 */

export type {
  ConnectLullWidgetOptions,
  LullWidgetClient,
  LullWidgetClientOptions,
} from "./client.js";
export { connectLullWidget, createLullWidgetClient } from "./client.js";
export type { LullWidgetErrorCode } from "./errors.js";
export { LullWidgetError } from "./errors.js";
export type {
  WidgetBridgeMethod,
  WidgetBridgeMethods,
  WidgetBridgeParams,
  WidgetBridgeResult,
  WidgetCapability,
  WidgetChrome,
  WidgetClientMessage,
  WidgetHostMessage,
  WidgetInitMessage,
  WidgetLogLevel,
  WidgetReadyMessage,
  WidgetRequestMessage,
  WidgetResponseMessage,
  WidgetTheme,
  WidgetThemeMessage,
  WidgetViewport,
  WidgetViewportMessage,
  WidgetVisibilityMessage,
  WidgetWindowSpec,
} from "./protocol.js";
export {
  isWidgetCapability,
  isWidgetHostMessage,
  normalizeViewport,
  WIDGET_CAPABILITIES,
  WIDGET_PROTOCOL,
} from "./protocol.js";
export type { WidgetBridgeTransport } from "./transport.js";
export { createDomTransport, isEmbedded } from "./transport.js";
