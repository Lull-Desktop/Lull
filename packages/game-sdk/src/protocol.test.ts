/**
 * 协议层校验的契约测试：锁住字段名、版本与“未知字段忽略”的边界。
 *
 * 宿主侧对应 Rust `src-tauri/src/game/protocol.rs`；改字段必须同时改两边。
 */
import { describe, expect, test } from "vitest";
import {
  GAME_HOST_API,
  GAME_PROTOCOL,
  isGameCommandResult,
  isGameContext,
  isGameEvent,
  isGameHostMessage,
  isGameRenderContext,
  isGameRenderState,
  isGameSnapshot,
} from "./protocol.js";
import {
  createGameCommand,
  createGameCommandMessage,
  createGameContext,
  createGameEvent,
  createGameInitErrorMessage,
  createGameInitMessage,
  createGameLifecycleEvent,
  createGameLifecycleMessage,
  createGameRenderContext,
  createGameRenderState,
  createGameSnapshot,
  createGameSnapshotMessage,
  createGameTick,
  createGameTickMessage,
} from "./testing.js";

describe("协议常量", () => {
  test("桥协议与宿主 API 都从 1 开始", () => {
    expect(GAME_PROTOCOL).toBe(1);
    expect(GAME_HOST_API).toBe(1);
  });
});

describe("快照 / 事件 / 渲染态", () => {
  test("合法快照通过，未知字段忽略", () => {
    const snapshot = createGameSnapshot();
    expect(isGameSnapshot(snapshot)).toBe(true);
    expect(isGameSnapshot({ ...snapshot, extra: { future: true } })).toBe(true);
  });

  test("版本不符、缺 state 的快照被拒绝", () => {
    expect(isGameSnapshot({ ...createGameSnapshot(), protocol: 2 })).toBe(
      false,
    );
    expect(isGameSnapshot({ ...createGameSnapshot(), state: undefined })).toBe(
      false,
    );
    expect(isGameSnapshot(null)).toBe(false);
  });

  test("事件要求 eventId/type/payload 与数字 revision", () => {
    const event = createGameEvent();
    expect(isGameEvent(event)).toBe(true);
    expect(isGameEvent({ ...event, extra: 1 })).toBe(true);
    expect(isGameEvent({ ...event, eventId: 42 })).toBe(false);
    expect(isGameEvent({ ...event, payload: undefined })).toBe(false);
    expect(isGameEvent({ ...event, revision: "42" })).toBe(false);
  });

  test("渲染态要求 publishedAt，且不强制 state 结构", () => {
    const render = createGameRenderState({ state: { phase: 0.5 } });
    expect(isGameRenderState(render)).toBe(true);
    expect(isGameRenderState({ ...render, publishedAt: undefined })).toBe(
      false,
    );
    expect(isGameRenderState({ ...render, state: null })).toBe(true);
  });
});

describe("上下文", () => {
  test("Authority 上下文合法；缺 limits 或版本不符被拒绝", () => {
    const context = createGameContext();
    expect(isGameContext(context)).toBe(true);
    expect(isGameContext({ ...context, extra: true })).toBe(true);
    expect(isGameContext({ ...context, hostApi: "1" })).toBe(false);
    expect(isGameContext({ ...context, limits: undefined })).toBe(false);
  });

  test("渲染上下文要求协议版本与完整几何", () => {
    const render = createGameRenderContext();
    expect(isGameRenderContext(render)).toBe(true);
    expect(isGameRenderContext({ ...render, protocol: undefined })).toBe(false);
    expect(isGameRenderContext({ ...render, mode: "independent" })).toBe(false);
    expect(
      isGameRenderContext({
        ...render,
        viewport: { width: 1, height: 1 },
      }),
    ).toBe(false);
  });
});

describe("宿主消息", () => {
  test("init 带 null 快照也合法", () => {
    expect(isGameHostMessage(createGameInitMessage())).toBe(true);
    expect(isGameHostMessage(createGameInitMessage({ snapshot: null }))).toBe(
      true,
    );
    expect(
      isGameHostMessage({
        ...createGameInitMessage(),
        context: { gameId: "x" },
      }),
    ).toBe(false);
  });

  test("init-error 带结构化错误体", () => {
    expect(isGameHostMessage(createGameInitErrorMessage())).toBe(true);
    expect(
      isGameHostMessage({
        v: 1,
        type: "init-error",
        error: { code: "game.manifest_invalid" },
      }),
    ).toBe(false);
  });

  test("snapshot / command / tick / lifecycle 分支逐项校验", () => {
    expect(isGameHostMessage(createGameSnapshotMessage())).toBe(true);
    expect(isGameHostMessage(createGameCommandMessage())).toBe(true);
    expect(isGameHostMessage(createGameTickMessage())).toBe(true);
    expect(isGameHostMessage(createGameLifecycleMessage())).toBe(true);

    expect(
      isGameHostMessage({
        ...createGameSnapshotMessage(),
        snapshot: { protocol: 1 },
      }),
    ).toBe(false);
    expect(
      isGameHostMessage({
        ...createGameCommandMessage(),
        command: { ...createGameCommand(), requestId: "" },
      }),
    ).toBe(false);
    expect(
      isGameHostMessage({
        ...createGameTickMessage(),
        tick: { ...createGameTick(), deltaMs: "1000" },
      }),
    ).toBe(false);
    expect(
      isGameHostMessage({
        ...createGameLifecycleMessage(),
        event: { ...createGameLifecycleEvent(), state: "paused" },
      }),
    ).toBe(false);
  });

  test("response 分支与错误体", () => {
    expect(
      isGameHostMessage({
        v: 1,
        type: "response",
        id: 3,
        ok: true,
        result: { value: 1 },
      }),
    ).toBe(true);
    expect(
      isGameHostMessage({
        v: 1,
        type: "response",
        id: 3,
        ok: false,
        error: { code: "io.error", message: "磁盘写入失败" },
      }),
    ).toBe(true);
    expect(
      isGameHostMessage({
        v: 1,
        type: "response",
        id: 3,
        ok: false,
        error: { code: "io.error" },
      }),
    ).toBe(false);
  });

  test("未知类型、旧版本与非法消息一律忽略", () => {
    expect(isGameHostMessage({ v: 1, type: "frame" })).toBe(false);
    expect(isGameHostMessage({ v: 2, type: "init" })).toBe(false);
    expect(isGameHostMessage(null)).toBe(false);
    expect(isGameHostMessage("init")).toBe(false);
  });
});

describe("命令结果", () => {
  test("Rust 形态的 error 是字符串 code", () => {
    expect(
      isGameCommandResult({
        requestId: "cmd-1",
        ok: false,
        error: "command.timeout",
      }),
    ).toBe(true);
    expect(
      isGameCommandResult({
        requestId: "cmd-1",
        ok: false,
        error: { code: "command.timeout" },
      }),
    ).toBe(false);
    expect(
      isGameCommandResult({ requestId: "cmd-1", ok: true, revision: 43 }),
    ).toBe(true);
  });
});
