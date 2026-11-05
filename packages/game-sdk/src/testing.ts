/**
 * 测试辅助：内存传输与样例消息。只用于单元测试与非 iframe 宿主，
 * 不参与游戏运行时。
 *
 * ```ts
 * const transport = createMemoryGameTransport();
 * const pending = createLullGameClient({ transport });
 * transport.receive(createGameInitMessage());
 * const game = await pending;
 * ```
 */
import {
  GAME_DEFAULT_LIMITS,
  GAME_PROTOCOL,
  type GameClientMessage,
  type GameCommand,
  type GameCommandMessage,
  type GameContext,
  type GameErrorBody,
  type GameEvent,
  type GameEventMessage,
  type GameHostMessage,
  type GameInitErrorMessage,
  type GameInitMessage,
  type GameLifecycleEvent,
  type GameLifecycleMessage,
  type GameRenderContext,
  type GameRenderState,
  type GameRequestMessage,
  type GameSnapshot,
  type GameSnapshotMessage,
  type GameTick,
  type GameTickMessage,
  isGameHostMessage,
} from "./protocol.js";
import {
  isSceneGameHostMessage,
  type SceneGameClientMessage,
  type SceneGameEventMessage,
  type SceneGameHostMessage,
  type SceneGameInitMessage,
  type SceneGameLifecycleMessage,
  type SceneGameRenderMessage,
  type SceneGameSnapshotMessage,
  type SceneGameTransport,
  type SceneGameUnavailableMessage,
} from "./scene.js";
import type { GameTransport } from "./transport.js";

export const TEST_GAME_ID = "community.living-world";
export const TEST_INSTANCE_ID = "0192f3a6b4c8d9e0f1a2b3c4d5e6f708";
export const TEST_AUTHORITY_ID = "6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

export type MemoryGameTransport = GameTransport & {
  /** iframe 发出的消息（ready / request），按发送顺序。 */
  readonly sent: GameClientMessage[];
  /** 注入一条宿主消息；非协议消息会被丢弃。 */
  receive(message: unknown): void;
  /** 成功应答某个请求 id。 */
  respond(id: number, result?: unknown): void;
  /** 失败应答某个请求 id。 */
  fail(id: number, error: GameErrorBody | string): void;
  /** 最近一条请求（没有则 null）。 */
  lastRequest(): GameRequestMessage | null;
  clear(): void;
};

export function createMemoryGameTransport(): MemoryGameTransport {
  const listeners = new Set<(message: GameHostMessage) => void>();
  const sent: GameClientMessage[] = [];

  const deliver = (message: unknown): void => {
    if (!isGameHostMessage(message)) return;
    for (const listener of [...listeners]) listener(message);
  };

  return {
    sent,
    post(message) {
      sent.push(message);
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(message) {
      deliver(message);
    },
    respond(id, result) {
      deliver({ v: GAME_PROTOCOL, type: "response", id, ok: true, result });
    },
    fail(id, error) {
      const body =
        typeof error === "string" ? { code: error, message: error } : error;
      deliver({
        v: GAME_PROTOCOL,
        type: "response",
        id,
        ok: false,
        error: body,
      });
    },
    lastRequest() {
      for (let index = sent.length - 1; index >= 0; index -= 1) {
        const message = sent[index];
        if (message && message.type === "request") return message;
      }
      return null;
    },
    clear() {
      sent.length = 0;
      listeners.clear();
    },
  };
}

export function createGameContext(
  overrides: Partial<GameContext> = {},
): GameContext {
  return {
    protocol: GAME_PROTOCOL,
    hostApi: 1,
    role: "authority",
    gameId: TEST_GAME_ID,
    instanceId: TEST_INSTANCE_ID,
    authorityId: TEST_AUTHORITY_ID,
    authorityEpoch: 3,
    revision: 42,
    simulationTimeMs: 123_456,
    render: null,
    limits: { ...GAME_DEFAULT_LIMITS },
    locale: "zh-CN",
    ...overrides,
  };
}

export function createGameRenderContext(
  overrides: Partial<GameRenderContext> = {},
): GameRenderContext {
  return {
    protocol: GAME_PROTOCOL,
    displayId: "\\\\.\\DISPLAY1",
    mode: "mirror",
    canvas: { x: 0, y: 0, w: 1920, h: 1080 },
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    viewport: { width: 1920, height: 1080, dpr: 1 },
    ...overrides,
  };
}

export function createGameSnapshot<T = unknown>(
  overrides: Partial<GameSnapshot<T>> = {},
): GameSnapshot<T> {
  return {
    protocol: GAME_PROTOCOL,
    gameId: TEST_GAME_ID,
    instanceId: TEST_INSTANCE_ID,
    revision: 42,
    authorityEpoch: 3,
    simulationTimeMs: 123_456,
    state: { resources: { food: 3 }, plants: [] } as T,
    ...overrides,
  };
}

export function createGameEvent<T = unknown>(
  overrides: Partial<GameEvent<T>> = {},
): GameEvent<T> {
  return {
    protocol: GAME_PROTOCOL,
    gameId: TEST_GAME_ID,
    instanceId: TEST_INSTANCE_ID,
    eventId: `${TEST_INSTANCE_ID}:42:0`,
    revision: 42,
    authorityEpoch: 3,
    type: "world.changed",
    payload: { reason: "seed" } as T,
    simulationTimeMs: 123_456,
    ...overrides,
  };
}

export function createGameRenderState<T = unknown>(
  overrides: Partial<GameRenderState<T>> = {},
): GameRenderState<T> {
  return {
    protocol: GAME_PROTOCOL,
    gameId: TEST_GAME_ID,
    instanceId: TEST_INSTANCE_ID,
    revision: 42,
    authorityEpoch: 3,
    state: {} as T,
    publishedAt: 1_760_000_000_000,
    ...overrides,
  };
}

export function createGameCommand<T = unknown>(
  overrides: Partial<GameCommand<T>> = {},
): GameCommand<T> {
  return {
    protocol: GAME_PROTOCOL,
    requestId: "cmd-1",
    type: "plant.seed",
    payload: { seedId: "seed-1" } as T,
    expectedRevision: 42,
    ...overrides,
  };
}

export function createGameTick(overrides: Partial<GameTick> = {}): GameTick {
  return {
    simulationTimeMs: 124_456,
    deltaMs: 1_000,
    wallClockMs: 1_760_000_000_000,
    ...overrides,
  };
}

export function createGameLifecycleEvent(
  overrides: Partial<GameLifecycleEvent> = {},
): GameLifecycleEvent {
  return {
    gameId: TEST_GAME_ID,
    instanceId: TEST_INSTANCE_ID,
    authorityEpoch: 3,
    revision: 42,
    state: "started",
    ...overrides,
  };
}

export function createGameInitMessage(
  overrides: Partial<GameInitMessage> = {},
): GameInitMessage {
  return {
    v: GAME_PROTOCOL,
    type: "init",
    context: createGameContext(),
    snapshot: createGameSnapshot(),
    ...overrides,
  };
}

export function createGameInitErrorMessage(
  overrides: Partial<GameInitErrorMessage> = {},
): GameInitErrorMessage {
  return {
    v: GAME_PROTOCOL,
    type: "init-error",
    error: {
      code: "game.manifest_invalid",
      message: "游戏清单校验失败",
    },
    ...overrides,
  };
}

export function createGameSnapshotMessage(
  snapshot: GameSnapshot = createGameSnapshot(),
): GameSnapshotMessage {
  return { v: GAME_PROTOCOL, type: "snapshot", snapshot };
}

export function createGameCommandMessage(
  command: GameCommand = createGameCommand(),
): GameCommandMessage {
  return { v: GAME_PROTOCOL, type: "command", command };
}

export function createGameTickMessage(
  tick: GameTick = createGameTick(),
): GameTickMessage {
  return { v: GAME_PROTOCOL, type: "tick", tick };
}

export function createGameLifecycleMessage(
  event: GameLifecycleEvent = createGameLifecycleEvent(),
): GameLifecycleMessage {
  return { v: GAME_PROTOCOL, type: "lifecycle", event };
}

export function createGameEventMessage(
  event: GameEvent = createGameEvent(),
): GameEventMessage {
  return { v: GAME_PROTOCOL, type: "event", event };
}

// ---------------------------------------------------------------------------
// Scene 渲染桥（`@lull/game-sdk/scene`）的测试辅助
// ---------------------------------------------------------------------------

export type MemorySceneGameTransport = SceneGameTransport & {
  readonly sent: SceneGameClientMessage[];
  receive(message: unknown): void;
  clear(): void;
};

export function createMemorySceneGameTransport(): MemorySceneGameTransport {
  const listeners = new Set<(message: SceneGameHostMessage) => void>();
  const sent: SceneGameClientMessage[] = [];
  return {
    sent,
    post(message) {
      sent.push(message);
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(message) {
      if (!isSceneGameHostMessage(message)) return;
      for (const listener of [...listeners]) listener(message);
    },
    clear() {
      sent.length = 0;
      listeners.clear();
    },
  };
}

export function createSceneGameInitMessage(
  overrides: Partial<SceneGameInitMessage> = {},
): SceneGameInitMessage {
  const render = createGameRenderContext();
  return {
    v: GAME_PROTOCOL,
    type: "game.init",
    context: createGameContext({ role: "replica", render }),
    snapshot: createGameSnapshot(),
    ...overrides,
  };
}

export function createSceneGameUnavailableMessage(
  reason?: string,
): SceneGameUnavailableMessage {
  return { v: GAME_PROTOCOL, type: "game.unavailable", reason };
}

export function createSceneGameSnapshotMessage(
  snapshot: GameSnapshot = createGameSnapshot(),
): SceneGameSnapshotMessage {
  return { v: GAME_PROTOCOL, type: "game.snapshot", snapshot };
}

export function createSceneGameEventMessage(
  event: GameEvent = createGameEvent(),
): SceneGameEventMessage {
  return { v: GAME_PROTOCOL, type: "game.event", event };
}

export function createSceneGameRenderMessage(
  renderState: GameRenderState = createGameRenderState(),
): SceneGameRenderMessage {
  return { v: GAME_PROTOCOL, type: "game.render", renderState };
}

export function createSceneGameLifecycleMessage(
  event: GameLifecycleEvent = createGameLifecycleEvent(),
): SceneGameLifecycleMessage {
  return { v: GAME_PROTOCOL, type: "game.lifecycle", event };
}
