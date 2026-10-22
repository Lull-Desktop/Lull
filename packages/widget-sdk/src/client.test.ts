/**
 * 插件侧 SDK 的契约测试。
 *
 * 这里同时锁两件事：
 * 1. 行为（握手、typed request、状态、订阅、超时、销毁）；
 * 2. 线上格式（字段名与协议版本），改动会让宿主壳与已发布插件错位。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { connectLullWidget, createLullWidgetClient } from "./client.js";
import { LullWidgetError } from "./errors.js";
import {
  WIDGET_PROTOCOL,
  type WidgetInitMessage,
  type WidgetTheme,
} from "./protocol.js";
import { createInitMessage, createMemoryTransport } from "./testing.js";

function setup(overrides: Partial<WidgetInitMessage> = {}) {
  const transport = createMemoryTransport();
  const client = createLullWidgetClient(createInitMessage(overrides), {
    transport,
  });
  return { transport, client };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("线上格式", () => {
  test("协议版本固定为 1", () => {
    expect(WIDGET_PROTOCOL).toBe(1);
  });

  test("request 报文字段与宿主壳约定一致", async () => {
    const { transport, client } = setup();
    const pending = client.getState("count");

    const message = transport.lastRequest();
    expect(message).not.toBeNull();
    if (!message) throw new Error("没有发出请求");
    expect(Object.keys(message).sort()).toEqual([
      "id",
      "method",
      "params",
      "token",
      "type",
      "v",
    ]);
    expect(message).toMatchObject({
      v: 1,
      type: "request",
      method: "state.get",
      params: { key: "count" },
      token: "test-token",
    });

    transport.respond(message.id, { value: 3 });
    await expect(pending).resolves.toBe(3);
  });
});

describe("握手", () => {
  test("发送 ready，收到 init 后返回客户端", async () => {
    const transport = createMemoryTransport();
    const pending = connectLullWidget({ transport, timeoutMs: 1000 });

    expect(transport.sent[0]).toMatchObject({
      v: 1,
      type: "ready",
      protocol: 1,
    });

    transport.receive(createInitMessage({ id: "community-demo" }));
    const client = await pending;
    expect(client.id).toBe("community-demo");
    expect(client.hostApi).toBe(1);
  });

  test("宿主不回应时按 init-timeout 失败", async () => {
    vi.useFakeTimers();
    const transport = createMemoryTransport();
    const pending = connectLullWidget({ transport, timeoutMs: 50 });
    const expectation = expect(pending).rejects.toMatchObject({
      code: "init-timeout",
    });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });

  test("顶层页面直接失败，不会静默挂起", async () => {
    await expect(connectLullWidget()).rejects.toMatchObject({
      code: "not-embedded",
    });
  });

  test("缺少 token 或版本不符时拒绝建客户端", () => {
    expect(() =>
      createLullWidgetClient(createInitMessage({ token: "" })),
    ).toThrow(LullWidgetError);
    const wrongVersion = {
      ...createInitMessage(),
      v: 2,
    } as unknown as WidgetInitMessage;
    expect(() => createLullWidgetClient(wrongVersion)).toThrow(LullWidgetError);
  });
});

describe("客户端", () => {
  test("能力按白名单收窄，未知能力不算授权", () => {
    const { client } = setup({
      granted: ["widget.state", "widget.native", "widget.theme"],
    });
    expect(client.capabilities).toEqual(["widget.state", "widget.theme"]);
    expect(client.has("widget.state")).toBe(true);
    expect(client.has("widget.native")).toBe(false);
  });

  test("getState 在宿主返回空值时回落到 fallback", async () => {
    const { transport, client } = setup();
    const pending = client.getState("theme-id", "fallback");

    const message = transport.lastRequest();
    if (!message) throw new Error("没有发出请求");
    transport.respond(message.id, { value: null });
    await expect(pending).resolves.toBe("fallback");
  });

  test("setState 透传 key/value 并等待宿主确认", async () => {
    const { transport, client } = setup();
    const pending = client.setState("loop", 25);

    const message = transport.lastRequest();
    if (!message) throw new Error("没有发出请求");
    expect(message).toMatchObject({
      method: "state.set",
      params: { key: "loop", value: 25 },
    });

    transport.respond(message.id, { saved: true });
    await expect(pending).resolves.toBeUndefined();
  });

  test("宿主错误收敛为 host-error", async () => {
    const { transport, client } = setup();
    const pending = client.setState("loop", 25);
    const expectation = expect(pending).rejects.toMatchObject({
      code: "host-error",
      message: "插件未启用",
    });

    const message = transport.lastRequest();
    if (!message) throw new Error("没有发出请求");
    transport.fail(message.id, "插件未启用");
    await expectation;
  });

  test("请求超时给出 timeout 而不是永久挂起", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const pending = client.getState("slow");
    const expectation = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(8000);
    await expectation;
  });

  test("订阅会立刻回放当前值，退订后不再触发", () => {
    const { transport, client } = setup();
    const themes: WidgetTheme[] = [];
    const stop = client.onTheme((theme) => themes.push(theme));
    expect(themes).toHaveLength(1);
    expect(client.theme?.id).toBe("bamboo");

    const next: WidgetTheme = {
      ...(client.theme as WidgetTheme),
      id: "aurora",
    };
    transport.receive({ v: 1, type: "theme", theme: next });
    expect(themes).toHaveLength(2);
    expect(client.theme?.id).toBe("aurora");

    stop();
    transport.receive({ v: 1, type: "theme", theme: null });
    expect(themes).toHaveLength(2);
  });

  test("视口与可见性跟随宿主消息更新", () => {
    const { transport, client } = setup();
    const sizes: number[] = [];
    const visibilities: boolean[] = [];
    client.onViewport((viewport) => sizes.push(viewport.width));
    client.onVisibility((visible) => visibilities.push(visible));

    transport.receive({
      v: 1,
      type: "viewport",
      viewport: { width: 520, height: 700, dpr: 1.5 },
    });
    transport.receive({ v: 1, type: "visibility", visible: false });

    expect(sizes).toEqual([480, 520]);
    expect(visibilities).toEqual([true, false]);
    expect(client.visible).toBe(false);
  });

  test("setTransparent 会同步本地状态与页面底色", async () => {
    const { transport, client } = setup();
    expect(client.transparent).toBe(true);

    const pending = client.setTransparent(false, "#101820");
    const message = transport.lastRequest();
    if (!message) throw new Error("没有发出请求");
    expect(message).toMatchObject({
      method: "window.setTransparent",
      params: { transparent: false, color: "#101820" },
    });
    transport.respond(message.id, { transparent: false });
    await pending;

    expect(client.transparent).toBe(false);
    expect(document.documentElement.style.backgroundColor).not.toBe("");

    const back = client.setTransparent(true);
    const second = transport.lastRequest();
    if (!second) throw new Error("没有发出请求");
    transport.respond(second.id, { transparent: true });
    await back;
    expect(document.documentElement.style.backgroundColor).toBe("");
  });

  test("requestAudio 按宿主返回的 granted 判断", async () => {
    const { transport, client } = setup();
    const pending = client.requestAudio();
    const message = transport.lastRequest();
    if (!message) throw new Error("没有发出请求");
    transport.respond(message.id, { granted: true });
    await expect(pending).resolves.toBe(true);
  });

  test("destroy 拒绝未完成请求并关闭后续调用", async () => {
    const { client } = setup();
    const pending = client.getState("inflight");
    const expectation = expect(pending).rejects.toMatchObject({
      code: "disposed",
    });

    client.destroy();
    await expectation;
    await expect(client.getState("after")).rejects.toMatchObject({
      code: "disposed",
    });
  });
});
