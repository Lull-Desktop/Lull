/**
 * 测试辅助：内存传输。只用于单元测试与非 iframe 宿主，不参与插件运行时。
 *
 * ```ts
 * const transport = createMemoryTransport();
 * const client = createLullWidgetClient(createInitMessage(), { transport });
 * const pending = client.setState("count", 1);
 * transport.respond(transport.lastRequest()!.id, { saved: true });
 * await pending;
 * ```
 */
import {
  isWidgetHostMessage,
  WIDGET_PROTOCOL,
  type WidgetClientMessage,
  type WidgetHostMessage,
  type WidgetInitMessage,
  type WidgetRequestMessage,
} from "./protocol.js";
import type { WidgetBridgeTransport } from "./transport.js";

export interface MemoryTransport extends WidgetBridgeTransport {
  /** 所有已发出的消息（ready / request），按发送顺序。 */
  readonly sent: WidgetClientMessage[];
  /** 注入一条宿主消息；非协议消息会被丢弃。 */
  receive(message: unknown): void;
  /** 成功应答某个请求 id。 */
  respond(id: number, result?: unknown): void;
  /** 失败应答某个请求 id。 */
  fail(id: number, error: string): void;
  /** 最近一条请求（没有则 null）。 */
  lastRequest(): WidgetRequestMessage | null;
  clear(): void;
}

export function createMemoryTransport(): MemoryTransport {
  const listeners = new Set<(message: WidgetHostMessage) => void>();
  const sent: WidgetClientMessage[] = [];

  const deliver = (message: unknown): void => {
    if (!isWidgetHostMessage(message)) return;
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
      deliver({ v: WIDGET_PROTOCOL, type: "response", id, ok: true, result });
    },
    fail(id, error) {
      deliver({ v: WIDGET_PROTOCOL, type: "response", id, ok: false, error });
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

/** 构造宿主 init 消息，字段与 `widget-plugin-shell.tsx` 的 `sendInit()` 逐项对齐。 */
export function createInitMessage(
  overrides: Partial<WidgetInitMessage> = {},
): WidgetInitMessage {
  return {
    v: WIDGET_PROTOCOL,
    type: "init",
    protocol: WIDGET_PROTOCOL,
    hostApi: 1,
    id: "community-test",
    name: "测试插件",
    version: "1.0.0",
    granted: ["widget.theme", "widget.state", "widget.audio"],
    requested: ["widget.theme", "widget.state", "widget.audio"],
    minimizable: true,
    window: {
      width: 480,
      height: 640,
      minWidth: 360,
      minHeight: 480,
      resizable: false,
      transparent: true,
      chrome: "host",
    },
    theme: {
      id: "bamboo",
      colors: {
        a: "#0f1a18",
        b: "#1d3934",
        c: "#9fc7c2",
        accentLight: "#bfe0da",
        accentDark: "#5d8d86",
        onAccentLight: "#0b1210",
        onAccentDark: "#f2fbf9",
      },
    },
    viewport: { width: 480, height: 640, dpr: 2 },
    token: "test-token",
    ...overrides,
  };
}
