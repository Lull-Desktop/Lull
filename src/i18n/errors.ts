/**
 * IPC 错误本地化：把 Rust 抛回来的结构化错误翻译成当前语言的文案。
 *
 * 约定（Rust 侧 `IpcError`）：
 * ```json
 * { "code": "extensions_install_failed", "params": { "reason": "…" }, "fallback": "…" }
 * ```
 * 兼容三种历史形态：
 * - `string`：未迁移的命令，原样显示（现状行为不变）；
 * - `{ code }`：按键名查消息，查不到用 `fallback`，再不行显示 code 本身；
 * - 其他：`String(error)`。
 */
import { hasMessage, message } from "./messages";

export type IpcErrorPayload = {
  code: string;
  params?: Record<string, string>;
  fallback?: string;
};

function isPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.trim() !== "";
}

function stringParams(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) =>
      typeof item === "string" ? [[key, item] as [string, string]] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function localizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  if (isPayload(error)) {
    const { code, params, fallback } = error;
    if (hasMessage(code)) return message(code, stringParams(params));
    if (typeof fallback === "string" && fallback !== "") return fallback;
    return code;
  }

  return String(error);
}
