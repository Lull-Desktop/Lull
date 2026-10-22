/**
 * Widget SDK：桌面工具窗口的清单、能力分层与宿主上下文。
 *
 * 清单的**唯一事实源**是 `src/widgets/manifests/*.json`：
 * - 本文件只定义契约类型与能力枚举；
 * - `scripts/gen-widgets.mjs` 读取清单生成 Tauri capability；
 * - `src-tauri/build.rs` 读取同一批清单生成 Rust 窗口描述。
 */

export const WIDGET_SCHEMA_VERSION = 1 as const;

/**
 * 宿主 API 版本：清单与上下文都带这个值，工具可以据此提示兼容性。
 * 修改窗口/能力/上下文字段语义时递增。
 */
export const WIDGET_HOST_API = 1 as const;

/** shell = 宿主外壳（设置窗）；tool = 用户可开关的桌面工具。 */
export const WIDGET_ROLES = ["shell", "tool"] as const;

export type WidgetRole = (typeof WIDGET_ROLES)[number];

/**
 * 能力分层（与 docs/widget-sdk.md 对齐）：
 * - ui / theme：界面与只读主题；
 * - state：通过 `readWidgetStorage` / `writeWidgetStorage` 访问自己的命名空间；
 * - audio / media：需要用户手势与宿主授权的资源；
 * - chrome：拖动、隐藏、最小化、改自己的窗口几何；
 * - window / native：宿主保留，第三方不可申请。
 */
export const WIDGET_CAPABILITIES = [
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.chrome",
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
  /** 初始宽度，同时也是 `widgetResizeWidth` 允许的上限。 */
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
  role: WidgetRole;
  /** 稳定 id，也是 `widget_open` 的参数值。 */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license: string;
  /** 是否属于官方内置工具（首期只有内置）。 */
  builtin: boolean;
  /** 设置页 / 托盘里的展示顺序，数值小的在前。 */
  order?: number;
  capabilities: WidgetCapability[];
  window: WidgetWindowSpec;
};

/**
 * Rust 在窗口创建时注入 `window.__LULL_WIDGET__` 的上下文。
 * 前端只能读它，不能伪造：没有注入时运行在浏览器预览 / 单元测试里。
 */
export type WidgetContext = {
  schemaVersion: typeof WIDGET_SCHEMA_VERSION;
  hostApi: number;
  id: string;
  capabilities: WidgetCapability[];
  window: WidgetWindowSpec;
};
