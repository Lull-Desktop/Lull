/**
 * 场景侧 SDK 的契约测试：锁住握手、帧/参数回放、可见性、超时与日志格式。
 *
 * 宿主侧对应实现是 `src/scenes/scene-bridge.ts` 与 `external-scene.tsx`；
 * 改字段必须同时改这两处与宿主测试。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AudioStatus } from "./audio-types.js";
import { createLullSceneClient } from "./client.js";
import { LullSceneError } from "./errors.js";
import { SCENE_PROTOCOL, type ScenePointer } from "./protocol.js";
import { syncedDelayMs } from "./sync.js";
import {
  createAudioFrame,
  createAudioSnapshot,
  createAudioStatus,
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

describe("音频响应", () => {
  async function connectAudio(hostApi = 5) {
    const transport = createMemorySceneTransport();
    const pending = createLullSceneClient({ transport });
    transport.receive(createSceneInitMessage({ hostApi }));
    const client = await pending;
    return { transport, client };
  }

  test("旧宿主（hostApi < 5）降级为 not-supported 且不发音频消息", async () => {
    const { transport, client } = await connectAudio(1);
    const statuses: AudioStatus[] = [];
    client.audio.onStatus((status) => statuses.push(status));
    expect(statuses.at(-1)).toMatchObject({
      available: false,
      reason: "inactive",
    });

    const snapshot = await client.audio.getSnapshot();
    expect(snapshot.sources.music).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ reason: "not-supported" });

    client.audio.onData(() => {});
    await Promise.resolve();
    expect(
      transport.sent.some((message) => message.type.startsWith("audio.")),
    ).toBe(false);
  });

  test("getSnapshot 走 requestSnapshot / audio.snapshot", async () => {
    const { transport, client } = await connectAudio();
    const pending = client.audio.getSnapshot();
    const request = transport.sent.at(-1);
    expect(request?.type).toBe("audio.requestSnapshot");
    if (request?.type !== "audio.requestSnapshot") return;

    const snapshot = createAudioSnapshot({
      timestamp: 5,
      sources: {
        music: createAudioFrame({ timestamp: 5 }),
        noise: null,
        mix: null,
        master: null,
      },
    });
    transport.receive({
      v: 1,
      type: "audio.snapshot",
      requestId: request.requestId,
      snapshot,
    });
    await expect(pending).resolves.toEqual(snapshot);
  });

  test("audio.init 提供首帧快照与状态", async () => {
    const { transport, client } = await connectAudio();
    const snapshot = createAudioSnapshot({
      timestamp: 9,
      sources: {
        music: createAudioFrame({ timestamp: 9 }),
        noise: null,
        mix: null,
        master: null,
      },
    });
    const status = createAudioStatus();
    transport.receive({ v: 1, type: "audio.init", snapshot, status });

    await expect(client.audio.getSnapshot()).resolves.toEqual(snapshot);
    const statuses: AudioStatus[] = [];
    client.audio.onStatus((value) => statuses.push(value));
    expect(statuses.at(-1)).toEqual(status);
  });

  test("onData 合并订阅、按来源分发、退订时收窄", async () => {
    const { transport, client } = await connectAudio();
    const music: number[] = [];
    const noise: number[] = [];
    const offMusic = client.audio.onData(
      (frame) => music.push(frame.timestamp),
      {
        sources: ["music"],
      },
    );
    const offNoise = client.audio.onData(
      (frame) => noise.push(frame.timestamp),
      {
        sources: ["noise"],
      },
    );

    await Promise.resolve();
    const subscribe = transport.sent.at(-1);
    expect(subscribe?.type).toBe("audio.subscribe");
    if (subscribe?.type !== "audio.subscribe") return;
    expect(subscribe.options.sources).toEqual(["music", "noise"]);

    transport.receive({
      v: 1,
      type: "audio.frame",
      frames: [
        createAudioFrame({ timestamp: 10 }),
        createAudioFrame({ source: "noise", timestamp: 10 }),
      ],
    });
    expect(music).toEqual([10]);
    expect(noise).toEqual([10]);

    offMusic();
    await Promise.resolve();
    const narrowed = transport.sent.at(-1);
    expect(narrowed?.type).toBe("audio.subscribe");
    if (narrowed?.type !== "audio.subscribe") return;
    expect(narrowed.options.sources).toEqual(["noise"]);

    offNoise();
    await Promise.resolve();
    expect(transport.sent.at(-1)?.type).toBe("audio.unsubscribe");
  });

  test("onData 注册时回放快照中的匹配帧", async () => {
    const { transport, client } = await connectAudio();
    transport.receive({
      v: 1,
      type: "audio.init",
      snapshot: createAudioSnapshot({
        timestamp: 3,
        sources: {
          music: createAudioFrame({ timestamp: 3 }),
          noise: null,
          mix: null,
          master: null,
        },
      }),
      status: createAudioStatus(),
    });

    const seen: number[] = [];
    client.audio.onData((frame) => seen.push(frame.timestamp), {
      sources: ["music"],
    });
    expect(seen).toEqual([3]);
  });

  test("destroy 清理监听并停止后续分发", async () => {
    const { transport, client } = await connectAudio();
    const seen: number[] = [];
    client.audio.onData((frame) => seen.push(frame.timestamp), {
      sources: ["music"],
    });
    await Promise.resolve();

    client.audio.destroy();
    transport.receive({
      v: 1,
      type: "audio.frame",
      frames: [createAudioFrame({ timestamp: 99 })],
    });
    expect(seen).toEqual([]);

    const before = transport.sent.length;
    client.audio.onData(() => {});
    await Promise.resolve();
    expect(transport.sent.length).toBe(before);
  });
});


test("环境目标回放最新值，忽略过期及非法消息并支持退订", async () => {
  const { transport, client } = await connect();
  const seen: number[] = [];
  transport.receive({ v: 1, type: "environment.targets", snapshot: { targets: { rain: 0.6 }, revision: 2, timestamp: 2 } });
  const off = client.onEnvironment(s => seen.push(s.targets.rain ?? 0));
  transport.receive({ v: 1, type: "environment.targets", snapshot: { targets: { rain: 0.2 }, revision: 1, timestamp: 1 } });
  transport.receive({ v: 1, type: "environment.targets", snapshot: { targets: { rain: 2 }, revision: 3, timestamp: 3 } });
  expect(seen).toEqual([0.6]);
  off();
  transport.receive({ v: 1, type: "environment.targets", snapshot: { targets: {}, revision: 4, timestamp: 4 } });
  expect(seen).toEqual([0.6]);
  expect(client.environment?.targets).toEqual({});
  client.destroy();
});
