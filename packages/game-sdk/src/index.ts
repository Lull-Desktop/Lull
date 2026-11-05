/**
 * `@lull/game-sdk` 公共入口（Authority / Replica 通用）。
 *
 * Controller Widget 入口在 `@lull/game-sdk/widget`，测试辅助在
 * `@lull/game-sdk/testing`，避免游戏包被迫加载用不到的代码。
 */
export type {
  ConnectLullGameOptions,
  LullGameClient,
} from "./client.js";
export { connectLullGame, createLullGameClient } from "./client.js";
export type { LullGameErrorCode } from "./errors.js";
export { LullGameError } from "./errors.js";
export type {
  GameBridgeMethod,
  GameBridgeMethods,
  GameBridgeParams,
  GameBridgeResult,
  GameClientMessage,
  GameCommand,
  GameCommandMessage,
  GameCommandResult,
  GameCommandResultInput,
  GameCommandResultRequest,
  GameCommitResult,
  GameConnectResult,
  GameContext,
  GameErrorBody,
  GameEvent,
  GameEventDraft,
  GameEventMessage,
  GameHostMessage,
  GameInitErrorMessage,
  GameInitMessage,
  GameLifecycleEvent,
  GameLifecycleMessage,
  GameLifecycleState,
  GameLimits,
  GameReadyMessage,
  GameRect,
  GameRenderContext,
  GameRenderState,
  GameReportErrorRequest,
  GameRequestMessage,
  GameResponseMessage,
  GameRole,
  GameSnapshot,
  GameSnapshotMessage,
  GameStateCommitRequest,
  GameStateUpdate,
  GameTick,
  GameTickMessage,
  GameViewport,
} from "./protocol.js";
export {
  GAME_DEFAULT_LIMITS,
  GAME_HOST_API,
  GAME_PROTOCOL,
  GAME_ROLES,
  isGameCommand,
  isGameCommandResult,
  isGameCommitResult,
  isGameConnectResult,
  isGameContext,
  isGameErrorBody,
  isGameEvent,
  isGameHostMessage,
  isGameLifecycleEvent,
  isGameLimits,
  isGameRect,
  isGameRenderContext,
  isGameRenderState,
  isGameSnapshot,
  isGameTick,
} from "./protocol.js";
export { createSeededRandom } from "./random.js";
export type { GameTransport } from "./transport.js";
export { createWindowGameTransport } from "./transport.js";
