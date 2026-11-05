/**
 * Lull Game Host 线上协议 v1。
 *
 * 与宿主壳（`src/games/authority/game-authority-shell.tsx` 等）和
 * `src-tauri/src/game/protocol.rs` 逐字段对应；改字段必须同时改宿主、Rust 与
 * `protocol.test.ts` 的契约断言，否则已发布的游戏包会静默失效。
 *
 * 校验只做协议层：未知字段忽略，方便宿主向前兼容地追加信息。
 */

/** iframe ↔ 宿主壳的 postMessage 协议版本。 */
export const GAME_PROTOCOL = 1 as const;

/** 宿主 Game Host API 版本，对应 `game.json.hostApi`。 */
export const GAME_HOST_API = 1 as const;

export const GAME_ROLES = ["authority", "replica", "controller"] as const;

export type GameRole = (typeof GAME_ROLES)[number];

/** 宿主硬上限的公开视图；manifest 只能收紧，不能放宽。 */
export type GameLimits = {
  maxStateBytes: number;
  maxEventBytes: number;
  maxEventsPerCommit: number;
  maxRenderStateBytes: number;
  maxReplicas: number;
  tickMs: number;
};

/** 与 `game.json` 默认值一致的兜底上限，只用于连接尚未返回 limits 的场合。 */
export const GAME_DEFAULT_LIMITS: GameLimits = {
  maxStateBytes: 1_048_576,
  maxEventBytes: 16_384,
  maxEventsPerCommit: 32,
  maxRenderStateBytes: 65_536,
  maxReplicas: 8,
  tickMs: 1_000,
};

/** 物理像素矩形，可为负；语义与 SceneFrame 一致。 */
export type GameRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type GameViewport = {
  width: number;
  height: number;
  dpr: number;
};

/** 单屏渲染上下文；几何直接来自 SceneFrame，不另算一套坐标。 */
export type GameRenderContext = {
  protocol: typeof GAME_PROTOCOL;
  displayId: string;
  mode: "mirror" | "span";
  canvas: GameRect;
  view: GameRect;
  viewport: GameViewport;
};

/** 宿主下发给参与者的身份与状态上下文。 */
export type GameContext = {
  protocol: typeof GAME_PROTOCOL;
  hostApi: number;
  role: GameRole;
  gameId: string;
  /** 实例未运行时（Controller 提前连接）缺省或为 null。 */
  instanceId?: string | null;
  authorityId?: string | null;
  authorityEpoch: number;
  revision: number;
  simulationTimeMs: number;
  /** Authority 不渲染；Replica / Controller 也只有在宿主提供时才有。 */
  render?: GameRenderContext | null;
  limits: GameLimits;
  locale: string;
};

export type GameSnapshot<T = unknown> = {
  protocol: typeof GAME_PROTOCOL;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  simulationTimeMs: number;
  state: T;
};

export type GameEvent<T = unknown> = {
  protocol: typeof GAME_PROTOCOL;
  gameId: string;
  instanceId: string;
  /** `${instanceId}:${revision}:${seq}`，由宿主生成。 */
  eventId: string;
  revision: number;
  authorityEpoch: number;
  type: string;
  payload: T;
  simulationTimeMs: number;
};

export type GameRenderState<T = unknown> = {
  protocol: typeof GAME_PROTOCOL;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  state: T;
  /** 宿主墙钟（毫秒）。 */
  publishedAt: number;
};

export type GameLifecycleState =
  | "started"
  | "stopped"
  | "suspended"
  | "resumed"
  | "authority-changed"
  | "failed";

export type GameLifecycleEvent = {
  gameId: string;
  instanceId: string;
  authorityEpoch: number;
  revision: number;
  state: GameLifecycleState;
  reason?: string;
  offlineMs?: number;
  error?: GameErrorBody;
};

export type GameTick = {
  simulationTimeMs: number;
  deltaMs: number;
  wallClockMs: number;
};

/** 宿主路由给 Authority 的一次命令。 */
export type GameCommand<T = unknown> = {
  protocol?: typeof GAME_PROTOCOL;
  requestId: string;
  type: string;
  payload: T;
  expectedRevision?: number | null;
};

export type GameErrorBody = {
  code: string;
  message: string;
  detail?: string;
};

/** `commitState()` 里可选的增量事件；单次 ≤ 32 条、单条 ≤ 16 KiB。 */
export type GameEventDraft<T = unknown> = {
  type: string;
  payload?: T;
};

/** SDK 对外接收的状态更新；`baseRevision` 一般不用填。 */
export type GameStateUpdate<T = unknown> = {
  state: T;
  simulationTimeMs?: number;
  events?: GameEventDraft[];
  renderState?: unknown;
  baseRevision?: number;
};

/** Authority 提交状态时实际发往宿主壳的参数（字段与 Rust `GameStateUpdate` 一致）。 */
export type GameStateCommitRequest = {
  authorityId: string;
  authorityEpoch: number;
  baseRevision: number;
  simulationTimeMs: number;
  state: unknown;
  events?: GameEventDraft[];
  renderState?: unknown;
};

export type GameCommitResult = {
  ok: boolean;
  revision: number;
  error?: GameErrorBody;
  deduplicated?: boolean;
};

/**
 * 命令结果。
 *
 * Rust `GameCommandResult.error` 是字符串 code（`Option<String>`），不是
 * `GameErrorBody`；文档 §6.2 的 `result.error?.code` 与之不一致，以代码为准。
 */
export type GameCommandResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  revision?: number;
  deduplicated?: boolean;
};

/** `commandResult()` 的线上参数（`error` 是稳定错误 code）。 */
export type GameCommandResultRequest = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  revision?: number;
};

/** `commandResult()` 的入参；允许直接传 `GameErrorBody`，SDK 会取出 code。 */
export type GameCommandResultInput = Omit<GameCommandResultRequest, "error"> & {
  error?: string | GameErrorBody;
};

export type GameReportErrorRequest = {
  scope: string;
  code: string;
  message: string;
};

export type GameConnectResult = {
  /** 实例未运行时为 null（正常态，不抛错）。 */
  context: GameContext | null;
  replicaId: string | null;
};

// ---------------------------------------------------------------------------
// iframe → 宿主壳
// ---------------------------------------------------------------------------

export type GameReadyMessage = {
  v: typeof GAME_PROTOCOL;
  type: "ready";
};

/** 请求方法名 → 参数/返回值。新增方法先加在这里，再改宿主壳的请求路由。 */
export type GameBridgeMethods = {
  "snapshot.get": {
    params: Record<string, never>;
    result: GameSnapshot | null;
  };
  "state.commit": {
    params: GameStateCommitRequest;
    result: GameCommitResult;
  };
  "event.publish": {
    params: { events: GameEventDraft[] };
    result: { accepted: number };
  };
  "render.publish": {
    params: { revision: number; state: unknown };
    result: { revision: number };
  };
  "command.result": {
    params: GameCommandResultRequest;
    result: null;
  };
  "error.report": {
    params: GameReportErrorRequest;
    result: null;
  };
  ready: {
    params: Record<string, never>;
    result: null;
  };
};

export type GameBridgeMethod = keyof GameBridgeMethods;
export type GameBridgeParams<M extends GameBridgeMethod> =
  GameBridgeMethods[M]["params"];
export type GameBridgeResult<M extends GameBridgeMethod> =
  GameBridgeMethods[M]["result"];

export type GameRequestMessage<M extends GameBridgeMethod = GameBridgeMethod> =
  {
    v: typeof GAME_PROTOCOL;
    type: "request";
    id: number;
    method: M;
    params: GameBridgeParams<M>;
  };

export type GameClientMessage = GameReadyMessage | GameRequestMessage;

// ---------------------------------------------------------------------------
// 宿主壳 → iframe
// ---------------------------------------------------------------------------

export type GameInitMessage = {
  v: typeof GAME_PROTOCOL;
  type: "init";
  context: GameContext;
  snapshot: GameSnapshot | null;
};

/** 宿主壳初始化失败时直接拒绝，不必等 init 超时。 */
export type GameInitErrorMessage = {
  v: typeof GAME_PROTOCOL;
  type: "init-error";
  error: GameErrorBody;
};

export type GameSnapshotMessage = {
  v: typeof GAME_PROTOCOL;
  type: "snapshot";
  snapshot: GameSnapshot;
};

export type GameCommandMessage = {
  v: typeof GAME_PROTOCOL;
  type: "command";
  command: GameCommand;
};

export type GameTickMessage = {
  v: typeof GAME_PROTOCOL;
  type: "tick";
  tick: GameTick;
};

export type GameLifecycleMessage = {
  v: typeof GAME_PROTOCOL;
  type: "lifecycle";
  event: GameLifecycleEvent;
};

/**
 * 宿主 → iframe 的事件推送。
 *
 * P1 的 authority 不订阅自己的事件（`game:event` 只投给 replica/controller），
 * 这里保留该分支给 replica / 需要回放事件的角色；宿主未发送时不会触发。
 */
export type GameEventMessage = {
  v: typeof GAME_PROTOCOL;
  type: "event";
  event: GameEvent;
};

export type GameResponseMessage = {
  v: typeof GAME_PROTOCOL;
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: GameErrorBody;
};

export type GameHostMessage =
  | GameInitMessage
  | GameInitErrorMessage
  | GameSnapshotMessage
  | GameCommandMessage
  | GameTickMessage
  | GameLifecycleMessage
  | GameEventMessage
  | GameResponseMessage;

// ---------------------------------------------------------------------------
// 运行时校验
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGameRole(value: unknown): value is GameRole {
  return (
    typeof value === "string" &&
    (GAME_ROLES as readonly string[]).includes(value)
  );
}

export function isGameRect(value: unknown): value is GameRect {
  return (
    isRecord(value) &&
    isNumber(value.x) &&
    isNumber(value.y) &&
    isNumber(value.w) &&
    isNumber(value.h)
  );
}

export function isGameRenderContext(
  value: unknown,
): value is GameRenderContext {
  if (!isRecord(value)) return false;
  if (value.protocol !== GAME_PROTOCOL) return false;
  if (value.mode !== "mirror" && value.mode !== "span") return false;
  if (typeof value.displayId !== "string") return false;
  if (!isGameRect(value.canvas) || !isGameRect(value.view)) return false;
  if (!isRecord(value.viewport)) return false;
  return (
    isNumber(value.viewport.width) &&
    isNumber(value.viewport.height) &&
    isNumber(value.viewport.dpr)
  );
}

export function isGameLimits(value: unknown): value is GameLimits {
  return (
    isRecord(value) &&
    isNumber(value.maxStateBytes) &&
    isNumber(value.maxEventBytes) &&
    isNumber(value.maxEventsPerCommit) &&
    isNumber(value.maxRenderStateBytes) &&
    isNumber(value.maxReplicas) &&
    isNumber(value.tickMs)
  );
}

export function isGameContext(value: unknown): value is GameContext {
  if (!isRecord(value)) return false;
  if (value.protocol !== GAME_PROTOCOL) return false;
  if (!isNumber(value.hostApi)) return false;
  if (!isGameRole(value.role)) return false;
  if (typeof value.gameId !== "string" || value.gameId.length === 0) {
    return false;
  }
  if (
    value.instanceId !== undefined &&
    value.instanceId !== null &&
    typeof value.instanceId !== "string"
  ) {
    return false;
  }
  if (
    value.authorityId !== undefined &&
    value.authorityId !== null &&
    typeof value.authorityId !== "string"
  ) {
    return false;
  }
  if (!isNumber(value.authorityEpoch) || !isNumber(value.revision)) {
    return false;
  }
  if (!isNumber(value.simulationTimeMs)) return false;
  if (
    value.render !== undefined &&
    value.render !== null &&
    !isGameRenderContext(value.render)
  ) {
    return false;
  }
  if (typeof value.locale !== "string") return false;
  return isGameLimits(value.limits);
}

export function isGameSnapshot<T = unknown>(
  value: unknown,
): value is GameSnapshot<T> {
  if (!isRecord(value)) return false;
  return (
    value.protocol === GAME_PROTOCOL &&
    typeof value.gameId === "string" &&
    typeof value.instanceId === "string" &&
    isNumber(value.revision) &&
    isNumber(value.authorityEpoch) &&
    isNumber(value.simulationTimeMs) &&
    value.state !== undefined
  );
}

export function isGameEvent<T = unknown>(
  value: unknown,
): value is GameEvent<T> {
  if (!isRecord(value)) return false;
  return (
    value.protocol === GAME_PROTOCOL &&
    typeof value.gameId === "string" &&
    typeof value.instanceId === "string" &&
    typeof value.eventId === "string" &&
    isNumber(value.revision) &&
    isNumber(value.authorityEpoch) &&
    typeof value.type === "string" &&
    value.payload !== undefined &&
    isNumber(value.simulationTimeMs)
  );
}

export function isGameRenderState<T = unknown>(
  value: unknown,
): value is GameRenderState<T> {
  if (!isRecord(value)) return false;
  return (
    value.protocol === GAME_PROTOCOL &&
    typeof value.gameId === "string" &&
    typeof value.instanceId === "string" &&
    isNumber(value.revision) &&
    isNumber(value.authorityEpoch) &&
    value.state !== undefined &&
    isNumber(value.publishedAt)
  );
}

export function isGameTick(value: unknown): value is GameTick {
  return (
    isRecord(value) &&
    isNumber(value.simulationTimeMs) &&
    isNumber(value.deltaMs) &&
    isNumber(value.wallClockMs)
  );
}

export function isGameCommand<T = unknown>(
  value: unknown,
): value is GameCommand<T> {
  if (!isRecord(value)) return false;
  if (value.protocol !== undefined && value.protocol !== GAME_PROTOCOL) {
    return false;
  }
  return (
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.type === "string" &&
    value.payload !== undefined &&
    (value.expectedRevision === undefined ||
      value.expectedRevision === null ||
      isNumber(value.expectedRevision))
  );
}

export function isGameErrorBody(value: unknown): value is GameErrorBody {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

export function isGameLifecycleEvent(
  value: unknown,
): value is GameLifecycleEvent {
  if (!isRecord(value)) return false;
  if (
    value.state !== "started" &&
    value.state !== "stopped" &&
    value.state !== "suspended" &&
    value.state !== "resumed" &&
    value.state !== "authority-changed" &&
    value.state !== "failed"
  ) {
    return false;
  }
  return (
    typeof value.gameId === "string" &&
    typeof value.instanceId === "string" &&
    isNumber(value.authorityEpoch) &&
    isNumber(value.revision) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.offlineMs === undefined || isNumber(value.offlineMs)) &&
    (value.error === undefined || isGameErrorBody(value.error))
  );
}

export function isGameCommitResult(value: unknown): value is GameCommitResult {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isNumber(value.revision) &&
    (value.error === undefined || isGameErrorBody(value.error)) &&
    (value.deduplicated === undefined ||
      typeof value.deduplicated === "boolean")
  );
}

export function isGameCommandResult(
  value: unknown,
): value is GameCommandResult {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.ok === "boolean" &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.revision === undefined || isNumber(value.revision)) &&
    (value.deduplicated === undefined ||
      typeof value.deduplicated === "boolean")
  );
}

export function isGameConnectResult(
  value: unknown,
): value is GameConnectResult {
  if (!isRecord(value)) return false;
  if (value.context !== null && !isGameContext(value.context)) return false;
  if (value.replicaId !== null && typeof value.replicaId !== "string") {
    return false;
  }
  return "context" in value && "replicaId" in value;
}

/** 收包的最低门槛：版本一致且 type 可识别；字段级校验按 type 分支。 */
export function isGameHostMessage(value: unknown): value is GameHostMessage {
  if (!isRecord(value) || value.v !== GAME_PROTOCOL) return false;
  switch (value.type) {
    case "init":
      return (
        isGameContext(value.context) &&
        (value.snapshot === null ||
          value.snapshot === undefined ||
          isGameSnapshot(value.snapshot))
      );
    case "init-error":
      return isGameErrorBody(value.error);
    case "snapshot":
      return isGameSnapshot(value.snapshot);
    case "command":
      return isGameCommand(value.command);
    case "tick":
      return isGameTick(value.tick);
    case "lifecycle":
      return isGameLifecycleEvent(value.event);
    case "event":
      return isGameEvent(value.event);
    case "response":
      return (
        isNumber(value.id) &&
        typeof value.ok === "boolean" &&
        (value.error === undefined || isGameErrorBody(value.error))
      );
    default:
      return false;
  }
}
