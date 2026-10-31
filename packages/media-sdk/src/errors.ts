import type { MediaErrorBody } from "./types";

/** 统一媒体错误：按 code 分支，不要匹配 message 文案。 */
export class LullMediaError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(body: MediaErrorBody) {
    super(body.message);
    this.name = "LullMediaError";
    this.code = body.code;
    this.details = body.details;
  }
}

export function isLullMediaError(error: unknown): error is LullMediaError {
  return error instanceof LullMediaError;
}
