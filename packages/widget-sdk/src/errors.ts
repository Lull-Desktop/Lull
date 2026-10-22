/** 插件侧 SDK 的结构化错误码；宿主返回的错误统一收敛为 `host-error`。 */
export type LullWidgetErrorCode =
  | "not-embedded"
  | "init-timeout"
  | "bad-init"
  | "host-error"
  | "timeout"
  | "disposed"
  | "transport-error";

/** 带码的错误：调用方可以按 `code` 分支，而不是靠匹配 message。 */
export class LullWidgetError extends Error {
  readonly code: LullWidgetErrorCode;

  constructor(code: LullWidgetErrorCode, message: string) {
    super(message);
    this.name = "LullWidgetError";
    this.code = code;
  }
}
