/**
 * Controller Widget 客户端契约测试：用假的宿主实现桥方法，用 window message
 * 模拟宿主壳转发的 `game.snapshot` / `game.event` / `game.lifecycle`。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGameContext,
  createGameEvent,
  createGameLifecycleEvent,
  createGameSnapshot,
} from "./testing.js";
import {
  connectLullGameWidget,
  type GameWidgetHost,
  type LullGameWidgetClient,
} from "./widget.js";

type HostCall = {
  method: string;
  params: Record<string, unknown>;
};

type FakeHostOptions = {
  capabilities?: string[];
  connect?: () => unknown;
  snapshot?: () => unknown;
  command?: (params: Record<string, unknown>) => unknown;
};

type FakeHost = GameWidgetHost & { calls: HostCall[] };

const activeClients: LullGameWidgetClient[] = [];

afterEach(() => {
  for (const client of activeClients.splice(0)) client.destroy();
  vi.useRealTimers();
});

function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const calls: HostCall[] = [];
  const capabilities = new Set(
    options.capabilities ?? [
      "game.state.read",
      "game.command.send",
      "game.event.read",
    ],
  );
  const host = {
    locale: "zh-CN",
    calls,
    has(capability: string) {
      return capabilities.has(capability);
    },
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      switch (method) {
        case "game.connect":
          return options.connect
            ? await options.connect()
            : {
                context: createGameContext({ role: "controller" }),
                replicaId: null,
              };
        case "game.snapshot":
          return options.snapshot
            ? await options.snapshot()
            : createGameSnapshot();
        case "game.command":
          return options.command
            ? await options.command(params)
            : { requestId: params.requestId, ok: true, result: {} };
        case "game.disconnect":
          return { disconnected: true };
        default:
          throw new Error(`未知桥方法：${method}`);
      }
    },
  };
  return host as unknown as FakeHost;
}

async function setup(options: FakeHostOptions = {}) {
  const host = createFakeHost(options);
  const client = await connectLullGameWidget(host, {
    gameId: "community.living-world",
  });
  activeClients.push(client);
  return { host, client };
}

async function connectWithHost(host: FakeHost) {
  const client = await connectLullGameWidget(host, {
    gameId: "community.living-world",
  });
  activeClients.push(client);
  return client;
}

function deliver(message: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { data: message, source: window }),
  );
}

describe("连接", () => {
  test("游戏未运行时 instanceId 为 null，角色固定 controller", async () => {
    const { client } = await setup({
      connect: () => ({ context: null, replicaId: null }),
    });

    expect(client.context.role).toBe("controller");
    expect(client.context.gameId).toBe("community.living-world");
    expect(client.context.instanceId).toBeNull();
  });

  test("宿主返回的 context 会被强制成 controller 角色", async () => {
    const { client } = await setup({
      connect: () => ({
        context: createGameContext({ role: "authority" }),
        replicaId: null,
      }),
    });
    expect(client.context.role).toBe("controller");
    expect(client.context.instanceId).not.toBeNull();
  });

  test("没有任何 game.* 能力时拒绝连接", async () => {
    const host = createFakeHost({ capabilities: [] });
    await expect(
      connectLullGameWidget(host, { gameId: "community.living-world" }),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  test("connect 返回非法结构时按 bad-init 拒绝", async () => {
    const host = createFakeHost({
      connect: () => ({ context: { gameId: "x" }, replicaId: null }),
    });
    await expect(
      connectLullGameWidget(host, { gameId: "community.living-world" }),
    ).rejects.toMatchObject({ code: "bad-init" });
  });
});

describe("快照", () => {
  test("getSnapshot 首次走桥，之后返回缓存", async () => {
    const { host, client } = await setup({
      snapshot: () => createGameSnapshot({ revision: 43 }),
    });

    const first = await client.getSnapshot<{ food: number }>();
    expect(first?.revision).toBe(43);
    expect(
      host.calls.filter((call) => call.method === "game.snapshot"),
    ).toHaveLength(1);

    const second = await client.getSnapshot();
    expect(second?.revision).toBe(43);
    expect(
      host.calls.filter((call) => call.method === "game.snapshot"),
    ).toHaveLength(1);
  });

  test("游戏未运行时 getSnapshot 返回 null", async () => {
    const { client } = await setup({ snapshot: () => null });
    await expect(client.getSnapshot()).resolves.toBeNull();
    expect(client.snapshot).toBeNull();
  });

  test("game.snapshot 推送更新缓存、context 与订阅者", async () => {
    const { client } = await setup();
    const revisions: number[] = [];
    client.onSnapshot((snapshot) => revisions.push(snapshot.revision));

    deliver({
      v: 1,
      type: "game.snapshot",
      snapshot: createGameSnapshot({ revision: 44 }),
    });

    expect(revisions).toEqual([44]);
    expect(client.snapshot?.revision).toBe(44);
    expect(client.context.revision).toBe(44);
  });

  test("非法 / 旧版本推送被忽略", async () => {
    const { client } = await setup();
    const revisions: number[] = [];
    client.onSnapshot((snapshot) => revisions.push(snapshot.revision));

    deliver({
      v: 2,
      type: "game.snapshot",
      snapshot: createGameSnapshot({ revision: 45 }),
    });
    deliver({ v: 1, type: "game.snapshot", snapshot: {} });
    deliver({ v: 1, type: "game.unknown" });

    expect(revisions).toEqual([]);
    expect(client.snapshot).toBeNull();
  });
});

describe("事件与生命周期", () => {
  test("onEvent 支持精确类型与通配符", async () => {
    const { client } = await setup();
    const specific: string[] = [];
    const all: string[] = [];
    client.onEvent("world.changed", (event) => specific.push(event.type));
    client.onEvent("*", (event) => all.push(event.type));

    deliver({
      v: 1,
      type: "game.event",
      event: createGameEvent({ type: "world.changed" }),
    });
    deliver({
      v: 1,
      type: "game.event",
      event: createGameEvent({ type: "task.completed" }),
    });

    expect(specific).toEqual(["world.changed"]);
    expect(all).toEqual(["world.changed", "task.completed"]);
  });

  test("game.lifecycle 更新 context 并广播", async () => {
    const { client } = await setup();
    const states: string[] = [];
    client.onLifecycle((event) => states.push(event.state));

    deliver({
      v: 1,
      type: "game.lifecycle",
      event: createGameLifecycleEvent({
        state: "authority-changed",
        authorityEpoch: 4,
        revision: 50,
      }),
    });

    expect(states).toEqual(["authority-changed"]);
    expect(client.context.authorityEpoch).toBe(4);
    expect(client.context.revision).toBe(50);
  });
});

describe("命令", () => {
  test("command 透传 requestId / type / payload / expectedRevision", async () => {
    const { host, client } = await setup({
      command: (params) => ({
        requestId: params.requestId,
        ok: true,
        result: { revision: 43 },
      }),
    });

    const result = await client.command(
      "plant.seed",
      { seedId: "seed-1" },
      { requestId: "cmd-1", expectedRevision: 42 },
    );

    expect(result).toMatchObject({
      requestId: "cmd-1",
      ok: true,
      result: { revision: 43 },
    });
    const call = host.calls.find((entry) => entry.method === "game.command");
    expect(call?.params).toMatchObject({
      requestId: "cmd-1",
      type: "plant.seed",
      payload: { seedId: "seed-1" },
      expectedRevision: 42,
    });
  });

  test("不传 requestId 时自动生成", async () => {
    const { host, client } = await setup({
      command: (params) => ({ requestId: params.requestId, ok: true }),
    });
    await client.command("plant.water");
    const call = host.calls.find((entry) => entry.method === "game.command");
    expect(typeof call?.params.requestId).toBe("string");
    expect(String(call?.params.requestId).length).toBeGreaterThan(0);
  });

  test("缺少 game.command.send 时本地拒绝", async () => {
    const host = createFakeHost({ capabilities: ["game.state.read"] });
    const client = await connectWithHost(host);
    await expect(client.command("plant.seed")).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  test("命令超时返回 request-timeout", async () => {
    const { client } = await setup({
      command: () => new Promise(() => {}),
    });
    vi.useFakeTimers();
    const expectation = expect(
      client.command("plant.seed", {}, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "request-timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
  });
});

describe("销毁", () => {
  test("destroy 通知宿主断开、停止推送并拒绝后续调用", async () => {
    const { host, client } = await setup();
    const revisions: number[] = [];
    client.onSnapshot((snapshot) => revisions.push(snapshot.revision));

    client.destroy();
    expect(host.calls.some((call) => call.method === "game.disconnect")).toBe(
      true,
    );
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: "disposed",
    });
    deliver({
      v: 1,
      type: "game.snapshot",
      snapshot: createGameSnapshot({ revision: 99 }),
    });
    expect(revisions).toEqual([]);
    expect(() => client.onSnapshot(() => {})).toThrowError();
  });
});
