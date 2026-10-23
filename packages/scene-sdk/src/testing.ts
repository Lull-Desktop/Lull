/**
 * 测试辅助：内存传输。只用于单元测试与非 iframe 宿主，不参与场景运行时。
 *
 * ```ts
 * const transport = createMemorySceneTransport();
 * const client = createLullSceneClient({ transport });
 * transport.receive(createSceneInitMessage());
 * const scene = await client;
 * ```
 */
import {
  isSceneHostMessage,
  SCENE_PROTOCOL,
  type SceneClientMessage,
  type SceneFrame,
  type SceneHostMessage,
  type SceneInitMessage,
} from "./protocol.js";
import type { SceneTransport } from "./transport.js";

export type MemorySceneTransport = SceneTransport & {
  /** 场景发出的消息（ready / log），按发送顺序。 */
  readonly sent: SceneClientMessage[];
  /** 注入一条宿主消息；非协议消息会被丢弃。 */
  receive(message: unknown): void;
  clear(): void;
};

export function createMemorySceneTransport(): MemorySceneTransport {
  const listeners = new Set<(message: SceneHostMessage) => void>();
  const sent: SceneClientMessage[] = [];

  return {
    sent,
    send(message) {
      sent.push(message);
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(message) {
      if (!isSceneHostMessage(message)) return;
      for (const listener of [...listeners]) listener(message);
    },
    clear() {
      sent.length = 0;
      listeners.clear();
    },
  };
}

export function createSceneFrame(
  overrides: Partial<SceneFrame> = {},
): SceneFrame {
  return {
    mode: "mirror",
    layout: "viewport",
    sync: { enabled: false, epochMs: 0 },
    viewport: { w: 1920, h: 1080, dpr: 1 },
    canvas: null,
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    dpr: 1,
    params: { mist: 0.5 },
    reducedMotion: false,
    performance: null,
    ...overrides,
  };
}

export function createSceneInitMessage(
  overrides: Partial<SceneInitMessage> = {},
): SceneInitMessage {
  return {
    v: SCENE_PROTOCOL,
    type: "init",
    protocol: SCENE_PROTOCOL,
    hostApi: 1,
    id: "demo.param-scene",
    frame: createSceneFrame(),
    visible: true,
    ...overrides,
  };
}
