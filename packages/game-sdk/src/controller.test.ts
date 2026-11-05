import { describe, expect, test } from "vitest";
import { connectLullGameController } from "./controller.js";
import { LullGameError } from "./errors.js";
import {
  GAME_PROTOCOL,
  type GameControllerClientMessage,
  type GameHostMessage,
} from "./protocol.js";
import {
  createGameContext,
  createGameEvent,
  createGameEventMessage,
  createGameInitErrorMessage,
  createGameInitMessage,
  createGameLifecycleMessage,
  createGameSnapshot,
  createGameSnapshotMessage,
} from "./testing.js";

type MemoryControllerTransport = {
  post(message: GameControllerClientMessage): void;
  listen(listener: (message: GameHostMessage) => void): () => void;
  readonly sent: GameControllerClientMessage[];
  receive(message: GameHostMessage): void;
};

function memoryTransport(): MemoryControllerTransport {
  const listeners = new Set<(message: GameHostMessage) => void>();
  const sent: GameControllerClientMessage[] = [];
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
      for (const listener of [...listeners]) listener(message);
    },
  };
}

function initMessage() {
  return createGameInitMessage({
    context: createGameContext({
      role: "controller",
      controllerId: "panel",
    }),
  });
}

function lastRequest(transport: MemoryControllerTransport) {
  for (let index = transport.sent.length - 1; index >= 0; index -= 1) {
    const message = transport.sent[index];
    if (message?.type === "request") return message;
  }
  return null;
}

describe("connectLullGameController", () => {
  test("握手：发送 ready，等待 init 后返回 controller 上下文", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    expect(transport.sent[0]).toMatchObject({ type: "ready" });
    transport.receive(initMessage());
    const client = await pending;
    expect(client.context.role).toBe("controller");
    expect(client.context.controllerId).toBe("panel");
    expect(client.snapshot?.revision).toBe(42);
  });

  test("init 超时抛 init-timeout", async () => {
    const transport = memoryTransport();
    await expect(
      connectLullGameController({ transport, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "init-timeout" });
  });

  test("host init-error 直接拒绝并带上错误体", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(
      createGameInitErrorMessage({
        error: {
          code: "game.controller_not_active",
          message: "游戏未运行",
        },
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(LullGameError);
    await expect(pending).rejects.toMatchObject({
      code: "host-error",
      body: { code: "game.controller_not_active" },
    });
  });

  test("command 走 command.send 并返回结果", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(initMessage());
    const client = await pending;

    const command = client.command("plant.seed", { seed: 1 });
    const request = lastRequest(transport);
    expect(request).toMatchObject({
      method: "command.send",
      params: { type: "plant.seed", payload: { seed: 1 } },
    });
    if (request?.type === "request") {
      transport.receive({
        v: GAME_PROTOCOL,
        type: "response",
        id: request.id,
        ok: true,
        result: {
          requestId: "cmd-1",
          ok: true,
          result: { accepted: true },
          revision: 43,
        },
      });
    }
    await expect(command).resolves.toMatchObject({
      ok: true,
      revision: 43,
    });
  });

  test("宿主失败响应转换为 host-error", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(initMessage());
    const client = await pending;

    const command = client.command("world.reset");
    const request = lastRequest(transport);
    if (request?.type === "request") {
      transport.receive({
        v: GAME_PROTOCOL,
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "game.command_not_allowed", message: "不允许" },
      });
    }
    await expect(command).rejects.toMatchObject({
      code: "host-error",
      body: { code: "game.command_not_allowed" },
    });
  });

  test("快照与事件推送只触发匹配监听器", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(initMessage());
    const client = await pending;

    const snapshots: number[] = [];
    const events: string[] = [];
    const anyEvents: string[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot.revision));
    client.onEvent("world.changed", (event) => events.push(event.type));
    client.onEvent("*", (event) => anyEvents.push(event.type));

    transport.receive(
      createGameSnapshotMessage(createGameSnapshot({ revision: 44 })),
    );
    transport.receive(createGameEventMessage(createGameEvent()));
    transport.receive(
      createGameEventMessage(createGameEvent({ type: "embers.pulsed" })),
    );

    expect(snapshots).toEqual([44]);
    expect(client.snapshot?.revision).toBe(44);
    expect(events).toEqual(["world.changed"]);
    expect(anyEvents).toEqual(["world.changed", "embers.pulsed"]);
  });

  test("lifecycle 更新 epoch/revision 并通知监听器", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(initMessage());
    const client = await pending;

    const lifecycles: string[] = [];
    client.onLifecycle((event) => lifecycles.push(event.state));
    transport.receive(
      createGameLifecycleMessage({
        gameId: client.context.gameId,
        instanceId: "i1",
        authorityEpoch: 4,
        revision: 45,
        state: "authority-changed",
      }),
    );
    expect(lifecycles).toEqual(["authority-changed"]);
    expect(client.context.authorityEpoch).toBe(4);
    expect(client.context.revision).toBe(45);
  });

  test("destroy 后请求被拒绝并发送 disconnect", async () => {
    const transport = memoryTransport();
    const pending = connectLullGameController({ transport, timeoutMs: 200 });
    transport.receive(initMessage());
    const client = await pending;

    client.destroy();
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: "disposed",
    });
    expect(lastRequest(transport)).toMatchObject({ method: "disconnect" });
  });
});
