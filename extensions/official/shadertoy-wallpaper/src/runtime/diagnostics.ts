/**
 * 诊断模型：扩展内部所有失败都以 `ShaderDiagnostic` 表达。
 *
 * 原则（对应 RFC §12）：只展示原始信息，不自动改写用户源码；外部输入用显式占位
 * 并在界面提示，不静默伪装成真实资源。`detail` 一律按纯文本渲染（`textContent`），
 * 不拼 HTML。
 */

export type ShaderDiagnosticCode =
  | "source-empty"
  | "source-too-large"
  | "unsupported-source"
  | "unsupported-version"
  | "unsupported-input"
  | "unsupported-entry"
  | "unsupported-feature"
  | "compile-failed"
  | "link-failed"
  | "webgl-unavailable"
  | "context-lost"
  | "performance-stopped"
  | "runtime-error";

export type ShaderDiagnostic = {
  code: ShaderDiagnosticCode;
  /** 面向用户的一句话（中英双语）。 */
  message: string;
  /** 原始编译器 / 运行时信息，原样展示。 */
  detail?: string;
  /** 生成源码相对用户源码多出的行数；有编译日志时用于提示行号偏移。 */
  lineOffset?: number;
};

/** 单条诊断里保留的最大原始日志字符数，避免把整段源码写进日志。 */
export const DIAGNOSTIC_DETAIL_MAX_CHARS = 4_000;

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）`;
}

export function diagnostic(
  code: ShaderDiagnosticCode,
  message: string,
  detail?: string,
  lineOffset?: number,
): ShaderDiagnostic {
  return {
    code,
    message,
    detail:
      detail === undefined
        ? undefined
        : truncateText(detail, DIAGNOSTIC_DETAIL_MAX_CHARS),
    lineOffset,
  };
}

/** 壁纸状态层里的完整文本（标题 + 原始信息 + 行号提示）。 */
export function formatDiagnostic(value: ShaderDiagnostic): string {
  const parts = [value.message];
  if (value.detail && value.detail.trim() !== "")
    parts.push(value.detail.trim());
  if (
    value.lineOffset !== undefined &&
    value.lineOffset > 0 &&
    value.code === "compile-failed"
  ) {
    parts.push(
      `行号相对运行时生成的源码：你的源码前附加了 ${value.lineOffset} 行。\n` +
        `Line numbers refer to the generated source; ${value.lineOffset} lines were prepended.`,
    );
  }
  return parts.join("\n\n");
}

/** 转发到宿主控制台的单行摘要。 */
export function toLogMessage(value: ShaderDiagnostic): string {
  const detail =
    value.detail && value.detail.trim() !== ""
      ? ` | ${value.detail.replace(/\s+/g, " ").trim().slice(0, 800)}`
      : "";
  return `[${value.code}] ${value.message}${detail}`;
}
