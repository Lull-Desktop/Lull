/**
 * Widget 清单 / 宿主上下文的运行时校验。
 *
 * 清单来自 `src/widgets/manifests/*.json`，未来也会来自第三方内容包；
 * 宿主上下文来自 Rust 注入的 `window.__LULL_WIDGET__`。两处都不能假设输入可信。
 */
import {
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

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const WINDOW_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: 字段 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: 字段 ${key} 必须是非空字符串或省略`);
  }
  return value.trim();
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where}: 字段 ${key} 必须是正数`);
  }
  return value;
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  where: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${where}: 字段 ${key} 必须是布尔值`);
  }
  return value;
}

export function isWidgetCapability(value: unknown): value is WidgetCapability {
  return (
    typeof value === "string" &&
    (WIDGET_CAPABILITIES as readonly string[]).includes(value)
  );
}

function parseCapabilities(input: unknown, where: string): WidgetCapability[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${where}: capabilities 必须是非空数组`);
  }
  const capabilities: WidgetCapability[] = [];
  for (const [index, value] of input.entries()) {
    if (!isWidgetCapability(value)) {
      throw new Error(
        `${where}: capabilities[${index}] 不是已知能力 ${String(value)}`,
      );
    }
    if (!capabilities.includes(value)) capabilities.push(value);
  }
  return capabilities;
}

function parseWindow(input: unknown, where: string): WidgetWindowSpec {
  if (!isRecord(input)) {
    throw new Error(`${where}: window 必须是对象`);
  }
  const label = requireString(input, "label", `${where}.window`);
  const route = requireString(input, "route", `${where}.window`);
  if (!WINDOW_KEY_PATTERN.test(label)) {
    throw new Error(`${where}.window: label "${label}" 非法`);
  }
  if (!WINDOW_KEY_PATTERN.test(route)) {
    throw new Error(`${where}.window: route "${route}" 非法`);
  }
  const width = requireNumber(input, "width", `${where}.window`);
  const height = requireNumber(input, "height", `${where}.window`);
  const minWidth = requireNumber(input, "minWidth", `${where}.window`);
  const minHeight = requireNumber(input, "minHeight", `${where}.window`);
  if (minWidth > width || minHeight > height) {
    throw new Error(`${where}.window: 最小尺寸不能大于初始尺寸`);
  }
  return {
    label,
    route,
    title: requireString(input, "title", `${where}.window`),
    width,
    height,
    minWidth,
    minHeight,
    resizable: requireBoolean(input, "resizable", `${where}.window`),
    transparent: requireBoolean(input, "transparent", `${where}.window`),
  };
}

function parseRole(input: Record<string, unknown>, where: string): WidgetRole {
  const role = input.role;
  if (
    typeof role !== "string" ||
    !(WIDGET_ROLES as readonly string[]).includes(role)
  ) {
    throw new Error(`${where}: role 必须是 ${WIDGET_ROLES.join(" / ")}`);
  }
  return role as WidgetRole;
}

function parseOrder(input: Record<string, unknown>, where: string): number {
  const value = input.order;
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: order 必须是数字或省略`);
  }
  return value;
}

/** 解析并校验一份 Widget 清单；未知字段忽略，便于后续版本扩展。 */
export function parseWidgetManifest(
  input: unknown,
  where = "widget manifest",
): WidgetManifest {
  if (!isRecord(input)) {
    throw new Error(`${where}: 必须是 JSON 对象`);
  }
  if (input.schemaVersion !== WIDGET_SCHEMA_VERSION) {
    throw new Error(
      `${where}: 不支持的 schemaVersion=${String(input.schemaVersion)}（当前支持 ${WIDGET_SCHEMA_VERSION}）`,
    );
  }
  if (input.type !== "widget") {
    throw new Error(`${where}: type 必须是 "widget"`);
  }
  const id = requireString(input, "id", where);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${where}: id "${id}" 非法`);
  }
  const version = requireString(input, "version", where);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${where}: version "${version}" 不是语义化版本`);
  }
  if (input.builtin !== true) {
    throw new Error(`${where}: 首期只接受 builtin=true 的官方清单`);
  }
  return {
    schemaVersion: WIDGET_SCHEMA_VERSION,
    type: "widget",
    role: parseRole(input, where),
    id,
    name: requireString(input, "name", where),
    version,
    description: optionalString(input, "description", where),
    author: optionalString(input, "author", where),
    license: requireString(input, "license", where),
    builtin: true,
    order: parseOrder(input, where),
    capabilities: parseCapabilities(input.capabilities, where),
    window: parseWindow(input.window, where),
  };
}

/**
 * 解析 Rust 注入的宿主上下文；格式不对时返回 null。
 * 运行在 Tauri 里却拿不到上下文属于宿主异常，调用方会按「无权限」处理（失败关闭）。
 */
export function parseWidgetContext(input: unknown): WidgetContext | null {
  try {
    if (!isRecord(input)) return null;
    if (input.schemaVersion !== WIDGET_SCHEMA_VERSION) return null;
    if (typeof input.hostApi !== "number" || !Number.isFinite(input.hostApi)) {
      return null;
    }
    // 宿主版本超出当前前端支持范围时拒绝上下文，避免用旧 SDK 解释新字段。
    if (input.hostApi < 1 || input.hostApi > WIDGET_HOST_API) return null;
    const id = requireString(input, "id", "widget context");
    if (!ID_PATTERN.test(id)) return null;
    return {
      schemaVersion: WIDGET_SCHEMA_VERSION,
      hostApi: input.hostApi,
      id,
      capabilities: parseCapabilities(input.capabilities, "widget context"),
      window: parseWindow(input.window, "widget context"),
    };
  } catch {
    return null;
  }
}
