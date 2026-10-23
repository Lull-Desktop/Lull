/** `connectLullScene()` 的可分支错误码；不要匹配文案。 */
export type LullSceneErrorCode =
  | "not-embedded"
  | "init-timeout"
  | "bad-init"
  | "disposed";

export class LullSceneError extends Error {
  readonly code: LullSceneErrorCode;

  constructor(code: LullSceneErrorCode, message: string) {
    super(message);
    this.name = "LullSceneError";
    this.code = code;
  }
}
