/**
 * Widget SDK 公共入口（无 React 依赖）。
 *
 * React 钩子在同目录的 `@/sdk/widget/react`；纯模型代码只 import 本文件，
 * 避免把 React / 主题副作用带进 Vitest 的数据层测试。
 */

export {
  isWidgetCapability,
  parseWidgetContext,
  parseWidgetManifest,
} from "./manifest";
export {
  getWidgetContext,
  hasWidgetCapability,
  isWidgetAudioAvailable,
  isWidgetHosted,
  isWidgetMediaAvailable,
  onWidgetPrefsChanged,
  readWidgetStorage,
  requireWidgetCapability,
  resetWidgetRuntimeForTests,
  WidgetCapabilityError,
  widgetAlignPlayer,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetMinimizeWindow,
  widgetResizeWidth,
  widgetSetResizable,
  widgetStartWindowDrag,
  widgetStorageKey,
  writeWidgetStorage,
} from "./runtime";
export {
  WIDGET_CAPABILITIES,
  WIDGET_HOST_API,
  WIDGET_ROLES,
  WIDGET_SCHEMA_VERSION,
  type WidgetCapability,
  type WidgetContext,
  type WidgetManifest,
  type WidgetRole,
  type WidgetWindowSpec,
} from "./types";
