import type { GameErrorBody } from "./protocol.js";

/**
 * 游戏侧 SDK 的可分支错误码；不要匹配文案。
 *
 * - `not-connected`：不在游戏 iframe 内，或 init 之前调用；
 * - `init-timeout`：宿主没在超时前发 `init`；
 * - `request-timeout`：宿主没在超时前响应 request；
 * - `disposed`：客户端已 `destroy()`；
 * - `bad-init`：init / connect 返回的结构不合法；
 * - `host-error`：宿主返回了失败响应；
 * - `permission-denied`：Widget 没有声明对应的 `game.*` 能力。
 */
export type LullGameErrorCode =
  | "not-connected"
  | "init-timeout"
  | "request-timeout"
  | "disposed"
  | "bad-init"
  | "host-error"
  | "permission-denied";

export class LullGameError extends Error {
  readonly code: LullGameErrorCode;
  /** 宿主返回的结构化错误体（如果有）。 */
  readonly body?: GameErrorBody;

  constructor(code: LullGameErrorCode, message: string, body?: GameErrorBody) {
    super(message);
    this.name = "LullGameError";
    this.code = code;
    this.body = body;
  }
}
