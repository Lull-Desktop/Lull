/**
 * 场景侧 SDK 的契约测试：锁住握手、帧/参数回放、可见性、超时与日志格式。
 *
 * 宿主侧对应实现是 `src/scenes/scene-bridge.ts` 与 `external-scene.tsx`；
 * 改字段必须同时改这两处与宿主测试。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLullSceneClient } from "./client.js";
import { LullSceneError } from "./errors.js";
import { SCENE_PROTOCOL, type ScenePointer } from "./protocol.js";
import { syncedDelayMs } from "./sync.js";
import {
  createMemorySceneTransport,
  createSceneFrame,
  createSceneInitMessage,
  createScenePointer,
} from "./testing.js";

afterEach(() => {
  vi.useRealTimers();
});

async function connect() {
  const transport = createMemorySceneTransport();
  const pending = createLullSceneClient({ transport });
  transport.receive(createSceneInitMessage());
  const client = await pending;
  return { transport, client };
}

describe("线协议", () => {
  test("协议版本固定为 1", () => {
    expect(SCENE_PROTOCOL).toBe(1);
  });

  test("连接后先发 ready，字段与宿主一致", async () => {
    const transport = createMemorySceneTransport();
    const pending = createLullSceneClient({ transport });
    expect(transport.sent[0]).toEqual({
      v: 1,
      type: "ready",
      protocol: 1,
    });
    transport.receive(createSceneInitMessage());
    await pending;
  });

  test("init 后暴露 id / hostApi / 当前参数", async () => {
    const { client } = await connect();
    expect(client.id).toBe("demo.param-scene");
    expect(client.hostApi).toBe(1);
    expect(client.protocol).toBe(1);
    expect(client.params).toEqual({ mist: 0.5 });
  });

  test("onFrame 注册时回放当前帧，之后跟随 frame 消息", async () => {
    const { transport, client } = await connect();
    const frames: number[] = [];
    const off = client.onFrame((frame) => {
      frames.push(frame.params.mist as number);
    });
    expect(frames).toEqual([0.5]);

    transport.receive({
      v: 1,
      type: "frame",
      frame: createSceneFrame({ params: { mist: 0.9 } }),
    });
    expect(frames).toEqual([0.5, 0.9]);
    expect(client.params).toEqual({ mist: 0.9 });

    off();
    transport.receive({
      v: 1,
      type: "frame",
      frame: createSceneFrame({ params: { mist: 0.1 } }),
    });
    expect(frames).toEqual([0.5, 0.9]);
  });

  test("onParams 只回放参数，onVisibility 跟随 visibility", async () => {
    const { transport, client } = await connect();
    const params: unknown[] = [];
    const visible: boolean[] = [];
    client.onParams((value) => params.push(value));
    client.onVisibility((value) => visible.push(value));

    expect(params).toEqual([{ mist: 0.5 }]);
    expect(visible).toEqual([true]);

    transport.receive({ v: 1, type: "visibility", visible: false });
    expect(client.visible).toBe(false);
    expect(visible).toEqual([true, false]);
  });

  test("onPointer 注册时回放，之后跟随 pointer 消息", async () => {
    const { transport, client } = await connect();
    expect(client.pointer).toBeNull();
    const seen: unknown[] = [];
    const off = client.onPointer((pointer) => seen.push(pointer));
    expect(seen).toEqual([]);

    transport.receive({
      v: 1,
      type: "pointer",
      pointer: createScenePointer({ x: 10, y: 20, inside: true, moving: true }),
    });
    expect(seen).toEqual([{ x: 10, y: 20, inside: true, moving: true }]);
    expect(client.pointer).toEqual({
      x: 10,
      y: 20,
      inside: true,
      moving: true,
    });

    off();
    transport.receive({
      v: 1,
      type: "pointer",
      pointer: createScenePointer({ x: 30, y: 40 }),
    });
    expect(seen).toHaveLength(1);
  });

  test("点击类消息不触发 onPointer，pointer 只暴露移动字段", async () => {
    const { transport, client } = await connect();
    const seen: ScenePointer[] = [];
    client.onPointer((pointer) => seen.push(pointer));

    transport.receive({ v: 1, type: "click", x: 1, y: 2, button: 0 });
    transport.receive({ v: 1, type: "dblclick", x: 1, y: 2 });
    transport.receive({
      v: 1,
      type: "pointer",
      pointer: {
        x: 3,
        y: 4,
        inside: true,
        moving: false,
        buttons: 1,
        detail: 2,
      },
    });

    expect(seen).toEqual([{ x: 3, y: 4, inside: true, moving: false }]);
    expect(Object.keys(seen[0] ?? {})).toEqual(["x", "y", "inside", "moving"]);
  });

  test("畸形 pointer 不触发监听，重复 init 重置 pointer", async () => {
    const { transport, client } = await connect();
    const seen: unknown[] = [];
    client.onPointer((pointer) => seen.push(pointer));

    transport.receive({
      v: 1,
      type: "pointer",
      pointer: { x: 1, y: 2, inside: true },
    });
    expect(seen).toEqual([]);

    transport.receive({
      v: 1,
      type: "pointer",
      pointer: createScenePointer(),
    });
    expect(seen).toHaveLength(1);

    transport.receive(createSceneInitMessage());
    expect(client.pointer).toBeNull();
  });

  test("log 走桥转发", async () => {
    const { transport, client } = await connect();
    client.log("参数已应用", "warn");
    expect(transport.sent.at(-1)).toMatchObject({
      v: 1,
      type: "log",
      level: "warn",
      message: "参数已应用",
    });
  });

  test("宿主不响应时按超时失败", async () => {
    vi.useFakeTimers();
    const transport = createMemorySceneTransport();
    const pending = createLullSceneClient({ transport, timeoutMs: 5 });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "init-timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(transport.sent[0]).toMatchObject({ type: "ready" });
  });

  test("不在 iframe 中时返回 not-embedded", async () => {
    await expect(createLullSceneClient()).rejects.toBeInstanceOf(
      LullSceneError,
    );
    await expect(createLullSceneClient()).rejects.toMatchObject({
      code: "not-embedded",
    });
  });
});

describe("同步相位", () => {
  test("按绝对时间锚点生成负延迟", () => {
    expect(syncedDelayMs(13000, 0)).toBe(0);
    expect(syncedDelayMs(13000, 1234)).toBe(-1234);
    expect(syncedDelayMs(13000, 26000)).toBe(0);
    expect(syncedDelayMs(0, 1234)).toBe(0);
  });
});
