import { describe, expect, test, vi } from "vitest";
import { connectLullGameRender, isSceneGameHostMessage } from "./scene.js";
import {
  createGameEvent,
  createGameLifecycleEvent,
  createGameRenderContext,
  createGameRenderState,
  createGameSnapshot,
  createMemorySceneGameTransport,
  createSceneGameEventMessage,
  createSceneGameInitMessage,
  createSceneGameLifecycleMessage,
  createSceneGameRenderMessage,
  createSceneGameSnapshotMessage,
  createSceneGameUnavailableMessage,
} from "./testing.js";

describe("scene render bridge", () => {
  test("posts game.ready and resolves with replica context", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    expect(transport.sent[0]?.type).toBe("game.ready");
    transport.receive(createSceneGameInitMessage());
    const game = await pending;
    expect(game).not.toBeNull();
    expect(game?.context.role).toBe("replica");
    expect(game?.context.gameId).toBe("community.living-world");
    expect(game?.render.mode).toBe("mirror");
    expect(game?.render.viewport.width).toBe(1920);
    const snapshot = await game?.getSnapshot();
    expect(snapshot?.revision).toBe(42);
  });

  test("resolves null when host reports unavailable", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    transport.receive(
      createSceneGameUnavailableMessage("game.instance_not_running"),
    );
    await expect(pending).resolves.toBeNull();
  });

  test("rejects non-replica init and init without valid render context", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    transport.receive(
      createSceneGameInitMessage({
        context: {
          ...createSceneGameInitMessage().context,
          role: "authority",
        },
      }),
    );
    await expect(pending).resolves.toBeNull();

    const secondTransport = createMemorySceneGameTransport();
    const second = connectLullGameRender({ transport: secondTransport });
    secondTransport.receive(
      createSceneGameInitMessage({
        context: {
          ...createSceneGameInitMessage().context,
          render: null,
        },
      }),
    );
    await expect(second).resolves.toBeNull();
  });

  test("times out to null when the host never answers", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMemorySceneGameTransport();
      const pending = connectLullGameRender({ transport, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("delivers snapshots, events, render state and lifecycle", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    transport.receive(createSceneGameInitMessage());
    const game = await pending;
    expect(game).not.toBeNull();
    if (!game) return;

    const snapshots: number[] = [];
    const events: string[] = [];
    const renders: number[] = [];
    const lifecycles: string[] = [];
    game.onSnapshot((snapshot) => snapshots.push(snapshot.revision));
    game.onEvent("world.changed", (event) => events.push(event.type));
    game.onEvent("*", (event) => events.push(`*:${event.type}`));
    game.onRenderState((state) => renders.push(state.revision));
    game.onLifecycle((event) => lifecycles.push(event.state));

    transport.receive(
      createSceneGameSnapshotMessage(createGameSnapshot({ revision: 43 })),
    );
    transport.receive(
      createSceneGameEventMessage(
        createGameEvent({ revision: 43, type: "world.changed" }),
      ),
    );
    transport.receive(
      createSceneGameRenderMessage(createGameRenderState({ revision: 43 })),
    );
    transport.receive(
      createSceneGameLifecycleMessage(
        createGameLifecycleEvent({ state: "resumed", offlineMs: 1_000 }),
      ),
    );

    expect(snapshots).toEqual([42, 43]);
    expect(events).toEqual(["world.changed", "*:world.changed"]);
    expect(renders).toEqual([43]);
    expect(lifecycles).toEqual(["resumed"]);
  });

  test("requests a snapshot when an event revision is missing", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    transport.receive(createSceneGameInitMessage());
    const game = await pending;
    if (!game) throw new Error("client not connected");

    let delivered = 0;
    game.onEvent("*", () => {
      delivered += 1;
    });
    transport.receive(
      createSceneGameEventMessage(createGameEvent({ revision: 99 })),
    );
    expect(
      transport.sent.some((message) => message.type === "game.requestSnapshot"),
    ).toBe(true);
    expect(delivered).toBe(0);
  });

  test("destroy posts game.detach", async () => {
    const transport = createMemorySceneGameTransport();
    const pending = connectLullGameRender({ transport });
    transport.receive(createSceneGameInitMessage());
    const game = await pending;
    game?.destroy();
    expect(transport.sent.at(-1)?.type).toBe("game.detach");
  });

  test("host message validator rejects unrelated payloads", () => {
    expect(isSceneGameHostMessage(null)).toBe(false);
    expect(isSceneGameHostMessage({ v: 1, type: "unrelated" })).toBe(false);
    expect(isSceneGameHostMessage(createSceneGameInitMessage())).toBe(true);
    expect(
      isSceneGameHostMessage({
        v: 1,
        type: "game.render",
        renderState: createGameRenderState(),
      }),
    ).toBe(true);
    expect(createGameRenderContext({ displayId: "" })).toMatchObject({
      protocol: 1,
    });
  });
});
