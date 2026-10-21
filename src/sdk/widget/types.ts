/**
 * Widget SDK：桌面工具窗口的清单与能力分层。
 *
 * 第一版仍由官方代码注册内置工具；该类型先固定设置页 / 托盘 / 窗口工厂
 * 共同消费的元数据形状，避免每个工具各自维护标题与尺寸。
 */

export const WIDGET_SCHEMA_VERSION = 1 as const;

/**
 * 能力分层（与 docs/widget-sdk.md 对齐）：
 * - ui / theme：首期开放；
 * - state：通过受限 API 开放；
 * - audio / media：设计权限后开放；
 * - window / native：暂不直接开放给第三方。
 */
export const WIDGET_CAPABILITIES = [
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.window",
  "widget.native",
] as const;

export type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

export type WidgetWindowSpec = {
  /** Tauri 窗口 label，同时也是 capability 授权键。 */
  label: string;
  /** 静态导出后的前端路由（不带前导斜杠）。 */
  route: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  transparent: boolean;
};

export type WidgetManifest = {
  schemaVersion: typeof WIDGET_SCHEMA_VERSION;
  type: "widget";
  /** 稳定 id，也是 `widget_open` 的参数值。 */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license: string;
  capabilities: WidgetCapability[];
  window: WidgetWindowSpec;
  /** 是否属于官方内置工具（首期只有内置）。 */
  builtin: boolean;
};
