/**
 * Authority 客户端契约测试：锁住握手、请求/响应、推送订阅、提交自动填充、
 * 超时与销毁语义。宿主侧对应 `src/games/authority` 的宿主壳。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLullGameClient } from "./client.js";
import { GAME_PROTOCOL, type GameContext } from "./protocol.js";
import {
  createGameCommand,
  createGameCommandMessage,
  createGameContext,
  createGameEvent,
  createGameEventMessage,
  createGameInitErrorMessage,
  createGameInitMessage,
  createGameLifecycleEvent,
  createGameLifecycleMessage,
  createGameSnapshot,
  createGameSnapshotMessage,
  createGameTick,
  createGameTickMessage,
  createMemoryGameTransport,
  type MemoryGameTransport,
  TEST_AUTHORITY_ID,
} from "./testing.js";

afterEach(() => {
  vi.useRealTimers();
});

type ConnectOverrides = {
  context?: Partial<GameContext>;
  snapshot?: ReturnType<typeof createGameSnapshot> | null;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
};

async function connect(overrides: ConnectOverrides = {}) {
  const transport = createMemoryGameTransport();
  const pending = createLullGameClient({
    transport,
    timeoutMs: overrides.initTimeoutMs,
    requestTimeoutMs: overrides.requestTimeoutMs,
  });
  const ready = transport.sent[0];
  transport.receive(
    createGameInitMessage({
      context: createGameContext(overrides.context),
      snapshot:
        overrides.snapshot === undefined
          ? createGameSnapshot()
          : overrides.snapshot,
    }),
  );
  const client = await pending;
  return { transport, client, ready };
}

function lastRequest(transport: MemoryGameTransport) {
  const request = transport.lastRequest();
  if (!request) throw new Error("没有发出请求");
  return request;
}

describe("握手", () => {
  test("连接后先发 ready，init 后暴露 context 与首份快照", async () => {
    const { client, ready } = await connect();

    expect(ready).toEqual({ v: 1, type: "ready" });
    expect(client.context.role).toBe("authority");
    expect(client.context.gameId).toBe("community.living-world");
    expect(client.context.revision).toBe(42);
    expect(client.snapshot?.revision).toBe(42);
  });

  test("宿主不响应时按 init-timeout 失败", async () => {
    vi.useFakeTimers();
    const transport = createMemoryGameTransport();
    const pending = createLullGameClient({ transport, timeoutMs: 5 });
    const expectation = expect(pending).rejects.toMatchObject({
      code: "init-timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    expect(transport.sent[0]).toMatchObject({ type: "ready" });
  });

  test("非法 init 被忽略，最终按超时失败", async () => {
    vi.useFakeTimers();
    const transport = createMemoryGameTransport();
    const pending = createLullGameClient({ transport, timeoutMs: 5 });
    const expectation = expect(pending).rejects.toMatchObject({
      code: "init-timeout",
    });
    transport.receive({ v: 1, type: "init", context: {}, snapshot: null });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
  });

  test("宿主 init 失败时立即按 host-error 拒绝，不等超时", async () => {
    const transport = createMemoryGameTransport();
    const pending = createLullGameClient({ transport, timeoutMs: 60_000 });
    transport.receive(
      createGameInitErrorMessage({
        error: { code: "game.manifest_invalid", message: "清单无效" },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: "host-error",
      message: "清单无效",
      body: { code: "game.manifest_invalid" },
    });
  });

  test("宿主 API 版本过高时按 bad-init 拒绝", async () => {
    const transport = createMemoryGameTransport();
    const pending = createLullGameClient({ transport });
    transport.receive(
      createGameInitMessage({
        context: createGameContext({ hostApi: 2 }),
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: "bad-init" });
  });

  test("顶层页面没有 transport 时返回 not-connected", async () => {
    await expect(createLullGameClient()).rejects.toMatchObject({
      code: "not-connected",
    });
  });
});

describe("快照", () => {
  test("getSnapshot 走 snapshot.get 并更新缓存与 context.revision", async () => {
    const { transport, client } = await connect({ snapshot: null });
    const pending = client.getSnapshot<{ food: number }>();
    const request = lastRequest(transport);
    expect(request).toMatchObject({ method: "snapshot.get", params: {} });

    const next = createGameSnapshot({
      revision: 43,
      simulationTimeMs: 200_000,
      state: { food: 9 },
    });
    transport.respond(request.id, next);

    await expect(pending).resolves.toMatchObject({
      revision: 43,
      state: { food: 9 },
    });
    expect(client.snapshot?.revision).toBe(43);
    expect(client.context.revision).toBe(43);
    expect(client.context.simulationTimeMs).toBe(200_000);
  });

  test("snapshot 推送更新缓存并广播给订阅者", async () => {
    const { transport, client } = await connect({ snapshot: null });
    const revisions: number[] = [];
    const stop = client.onSnapshot((snapshot) => {
      revisions.push(snapshot.revision);
    });

    const next = createGameSnapshot({ revision: 44 });
    transport.receive(createGameSnapshotMessage(next));
    expect(revisions).toEqual([44]);
    expect(client.snapshot).toEqual(next);
    expect(client.context.revision).toBe(44);

    stop();
    transport.receive(
      createGameSnapshotMessage(createGameSnapshot({ revision: 45 })),
    );
    expect(revisions).toEqual([44]);
  });

  test("非法 / 旧版本消息被忽略，不影响缓存", async () => {
    const { transport, client } = await connect({ snapshot: null });
    const revisions: number[] = [];
    client.onSnapshot((snapshot) => revisions.push(snapshot.revision));

    transport.receive({
      v: GAME_PROTOCOL,
      type: "snapshot",
      snapshot: { protocol: GAME_PROTOCOL },
    });
    transport.receive({
      v: 2,
      type: "snapshot",
      snapshot: createGameSnapshot({ revision: 90 }),
    });
    transport.receive({ v: 1, type: "unknown" });

    expect(revisions).toEqual([]);
    expect(client.snapshot).toBeNull();
  });
});

describe("状态提交", () => {
  test("自动填充 authorityId / authorityEpoch / baseRevision，成功后更新 revision", async () => {
    const { transport, client } = await connect();
    const pending = client.commitState({ state: { food: 4 } });
    const request = lastRequest(transport);

    expect(request).toMatchObject({
      v: 1,
      type: "request",
      method: "state.commit",
      params: {
        authorityId: TEST_AUTHORITY_ID,
        authorityEpoch: 3,
        baseRevision: 42,
        simulationTimeMs: 123_456,
        state: { food: 4 },
      },
    });
    expect(request.params).not.toHaveProperty("events");

    transport.respond(request.id, { ok: true, revision: 43 });
    await expect(pending).resolves.toMatchObject({ ok: true, revision: 43 });
    expect(client.context.revision).toBe(43);

    const second = client.commitState({ state: { food: 5 } });
    expect(lastRequest(transport).params).toMatchObject({
      baseRevision: 43,
      simulationTimeMs: 123_456,
    });
    const secondRequest = lastRequest(transport);
    transport.respond(secondRequest.id, { ok: true, revision: 44 });
    await second;
    expect(client.context.revision).toBe(44);
  });

  test("显式 baseRevision / simulationTimeMs / events / renderState 会透传", async () => {
    const { transport, client } = await connect();
    const pending = client.commitState({
      state: { food: 4 },
      baseRevision: 40,
      simulationTimeMs: 777,
      events: [{ type: "world.changed", payload: { reason: "seed" } }],
      renderState: { phase: 0.5 },
    });
    const request = lastRequest(transport);
    expect(request.params).toMatchObject({
      baseRevision: 40,
      simulationTimeMs: 777,
      events: [{ type: "world.changed", payload: { reason: "seed" } }],
      renderState: { phase: 0.5 },
    });
    transport.respond(request.id, { ok: true, revision: 41 });
    await pending;
  });

  test("提交被宿主拒绝时返回结果对象，不推进 revision", async () => {
    const { transport, client } = await connect();
    const pending = client.commitState({ state: { food: 4 } });
    const request = lastRequest(transport);
    transport.respond(request.id, {
      ok: false,
      revision: 42,
      error: { code: "state.revision_conflict", message: "基准 revision 过期" },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      revision: 42,
      error: { code: "state.revision_conflict" },
    });
    expect(client.context.revision).toBe(42);
  });

  test("host 失败响应映射为 host-error 并保留错误体", async () => {
    const { transport, client } = await connect({ snapshot: null });
    const pending = client.getSnapshot();
    const request = lastRequest(transport);
    const expectation = expect(pending).rejects.toMatchObject({
      code: "host-error",
      body: { code: "io.error" },
    });
    transport.fail(request.id, {
      code: "io.error",
      message: "存档写入失败",
    });
    await expectation;
  });

  test("request 超时返回 request-timeout", async () => {
    const { client } = await connect({
      snapshot: null,
      requestTimeoutMs: 5,
    });
    vi.useFakeTimers();
    const expectation = expect(client.getSnapshot()).rejects.toMatchObject({
      code: "request-timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
  });
});

describe("推送订阅", () => {
  test("onEvent 支持精确类型与通配符", async () => {
    const { transport, client } = await connect();
    const specific: string[] = [];
    const all: string[] = [];
    client.onEvent("world.changed", (event) => specific.push(event.type));
    client.onEvent("*", (event) => all.push(event.type));

    transport.receive(
      createGameEventMessage(createGameEvent({ type: "world.changed" })),
    );
    transport.receive(
      createGameEventMessage(createGameEvent({ type: "task.completed" })),
    );

    expect(specific).toEqual(["world.changed"]);
    expect(all).toEqual(["world.changed", "task.completed"]);
  });

  test("onCommand 按命令类型分发", async () => {
    const { transport, client } = await connect();
    const ids: string[] = [];
    client.onCommand("plant.seed", (command) => ids.push(command.requestId));

    transport.receive(createGameCommandMessage());
    transport.receive(
      createGameCommandMessage(
        createGameCommand({ requestId: "cmd-2", type: "plant.water" }),
      ),
    );
    expect(ids).toEqual(["cmd-1"]);
  });

  test("onTick / onLifecycle 生效，lifecycle 同步 epoch 与 revision", async () => {
    const { transport, client } = await connect();
    const ticks: number[] = [];
    const states: string[] = [];
    client.onTick((tick) => ticks.push(tick.simulationTimeMs));
    client.onLifecycle((event) => states.push(event.state));

    transport.receive(
      createGameTickMessage(createGameTick({ simulationTimeMs: 130_000 })),
    );
    transport.receive(
      createGameLifecycleMessage(
        createGameLifecycleEvent({
          state: "authority-changed",
          authorityEpoch: 4,
          revision: 50,
        }),
      ),
    );

    expect(ticks).toEqual([130_000]);
    expect(states).toEqual(["authority-changed"]);
    expect(client.context.authorityEpoch).toBe(4);
    expect(client.context.revision).toBe(50);
  });
});

describe("事件 / 渲染态 / 就绪 / 错误上报", () => {
  test("publishEvent 包成 events 数组", async () => {
    const { transport, client } = await connect();
    const pending = client.publishEvent("task.completed", { taskId: "t-1" });
    const request = lastRequest(transport);
    expect(request).toMatchObject({
      method: "event.publish",
      params: {
        events: [{ type: "task.completed", payload: { taskId: "t-1" } }],
      },
    });
    transport.respond(request.id, { accepted: 1 });
    await expect(pending).resolves.toEqual({ accepted: 1 });
  });

  test("publishRenderState 带当前 revision，不推进本地 revision", async () => {
    const { transport, client } = await connect();
    const pending = client.publishRenderState({ phase: 0.2 });
    const request = lastRequest(transport);
    expect(request).toMatchObject({
      method: "render.publish",
      params: { revision: 42, state: { phase: 0.2 } },
    });
    transport.respond(request.id, { revision: 42 });
    await pending;
    expect(client.context.revision).toBe(42);
  });

  test("commandResult 允许传错误体，只回传 code", async () => {
    const { transport, client } = await connect();
    const pending = client.commandResult({
      requestId: "cmd-1",
      ok: false,
      error: { code: "state.too_large", message: "状态过大" },
      revision: 42,
    });
    const request = lastRequest(transport);
    expect(request).toMatchObject({
      method: "command.result",
      params: {
        requestId: "cmd-1",
        ok: false,
        error: "state.too_large",
        revision: 42,
      },
    });
    transport.respond(request.id, null);
    await pending;
  });

  test("reportReady 走 ready 方法，reportError 默认用当前角色 scope", async () => {
    const { transport, client } = await connect();

    const ready = client.reportReady();
    const readyRequest = lastRequest(transport);
    expect(readyRequest).toMatchObject({ method: "ready", params: {} });
    transport.respond(readyRequest.id, null);
    await ready;

    const error = client.reportError({
      code: "render.context-lost",
      message: "WebGL 上下文丢失",
    });
    const errorRequest = lastRequest(transport);
    expect(errorRequest).toMatchObject({
      method: "error.report",
      params: {
        scope: "authority",
        code: "render.context-lost",
        message: "WebGL 上下文丢失",
      },
    });
    transport.respond(errorRequest.id, null);
    await error;
  });
});

describe("销毁", () => {
  test("destroy 拒绝未完成请求，之后调用返回 disposed", async () => {
    const { client } = await connect({ snapshot: null });
    const pending = client.getSnapshot();
    const expectation = expect(pending).rejects.toMatchObject({
      code: "disposed",
    });

    client.destroy();
    await expectation;
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: "disposed",
    });
    expect(() => client.onSnapshot(() => {})).toThrowError();
  });

  test("destroy 后不再接收推送", async () => {
    const { transport, client } = await connect();
    const revisions: number[] = [];
    client.onSnapshot((snapshot) => revisions.push(snapshot.revision));
    client.destroy();
    transport.receive(
      createGameSnapshotMessage(createGameSnapshot({ revision: 99 })),
    );
    expect(revisions).toEqual([]);
  });
});
