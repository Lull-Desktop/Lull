import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AudioFrame,
  AudioSnapshot,
  AudioStatus,
  SceneCatalogEntry,
  SceneFrame,
  SceneManifest,
} from "@/sdk/scene";
import { ExternalScene } from "./external-scene";

type AudioHarnessConnection = {
  options: { sources: string[]; features: string[] };
  snapshot: AudioSnapshot;
  status: AudioStatus;
  whenReady: Promise<void>;
  getSnapshot(): AudioSnapshot;
  getStatus(): AudioStatus;
  subscribeFrames(listener: (frames: AudioFrame[]) => void): () => void;
  subscribeStatus(listener: (status: AudioStatus) => void): () => void;
  disconnect: () => void;
  setSnapshot(next: AudioSnapshot): void;
  emitFrames(frames: AudioFrame[]): void;
  emitStatus(next: AudioStatus): void;
};

const environmentHarness = vi.hoisted(() => ({ handlers: [] as Array<(snapshot: { targets: Record<string, number>; timestamp: number; revision: number }) => void>, unlisten: vi.fn() }));
vi.mock("./environment-stream", () => ({ listenWallpaperEnvironment: (handler: typeof environmentHarness.handlers[number]) => { environmentHarness.handlers.push(handler); return environmentHarness.unlisten; } }));

const audioHarness = vi.hoisted(() => ({
  connections: [] as AudioHarnessConnection[],
}));

const pointerHarness = vi.hoisted(() => ({
  handlers: [] as Array<
    (sample: {
      x: number;
      y: number;
      overDesktop: boolean;
      moving: boolean;
    }) => void
  >,
  unlisten: () => {},
}));

vi.mock("./pointer-stream", () => ({
  listenWallpaperPointer: (
    handler: (sample: {
      x: number;
      y: number;
      overDesktop: boolean;
      moving: boolean;
    }) => void,
  ) => {
    pointerHarness.handlers.push(handler);
    return pointerHarness.unlisten;
  },
}));

vi.mock("./audio-stream", () => ({
  connectWallpaperAudio: (options: {
    sources: string[];
    features: string[];
  }): AudioHarnessConnection => {
    const frameListeners = new Set<(frames: AudioFrame[]) => void>();
    const statusListeners = new Set<(status: AudioStatus) => void>();
    const connection: AudioHarnessConnection = {
      options,
      snapshot: {
        protocol: 1,
        timestamp: 0,
        sources: { music: null, noise: null, mix: null, master: null },
      },
      status: {
        available: false,
        sources: { music: false, noise: false, mix: false, master: false },
        reason: "inactive",
      },
      whenReady: Promise.resolve(),
      getSnapshot() {
        return connection.snapshot;
      },
      getStatus() {
        return connection.status;
      },
      subscribeFrames(listener) {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      subscribeStatus(listener) {
        statusListeners.add(listener);
        listener(connection.status);
        return () => statusListeners.delete(listener);
      },
      disconnect: vi.fn(),
      setSnapshot(next) {
        connection.snapshot = next;
      },
      emitFrames(frames) {
        for (const listener of [...frameListeners]) listener(frames);
      },
      emitStatus(next) {
        connection.status = next;
        for (const listener of [...statusListeners]) listener(next);
      },
    };
    audioHarness.connections.push(connection);
    return connection;
  },
}));

beforeEach(() => {
  environmentHarness.handlers.length = 0;
  pointerHarness.handlers.length = 0;
  audioHarness.connections.length = 0;
});

function manifest(): SceneManifest {
  return {
    schemaVersion: 1,
    type: "scene",
    id: "demo.param-scene",
    name: "参数演示",
    version: "1.0.0",
    license: "MIT",
    capabilities: [
      "wallpaper.viewport",
      "wallpaper.params",
      "wallpaper.script",
    ],
    entry: "scenes/param-demo/index.html",
    params: [
      {
        key: "glow",
        type: "number",
        label: "光晕",
        default: 0.5,
        min: 0,
        max: 1,
      },
    ],
    compatibility: { hostApi: 1, platforms: ["windows"] },
  } as SceneManifest;
}

const FRAME: SceneFrame = {
  mode: "mirror",
  layout: "viewport",
  sync: { enabled: false, epochMs: 0 },
  viewport: { w: 1920, h: 1080, dpr: 1 },
  canvas: null,
  view: { x: 0, y: 0, w: 1920, h: 1080 },
  dpr: 1,
  params: { glow: 0.8 },
  reducedMotion: false,
  performance: null,
};

const ENTRY: SceneCatalogEntry = {
  manifest: manifest(),
  source: "user",
  entryUrl:
    "http://lullcontent.localhost/demo.param-scene/scenes/param-demo/index.html",
  component: null,
};

function pointerEntry(): SceneCatalogEntry {
  return {
    ...ENTRY,
    manifest: {
      ...manifest(),
      capabilities: [
        "wallpaper.viewport",
        "wallpaper.params",
        "wallpaper.script",
        "wallpaper.pointer",
      ],
    } as SceneManifest,
  };
}

describe("ExternalScene", () => {
  test("脚本场景在 ready 后收到带参数的 init，参数变化再收 frame", () => {
    const { rerender } = render(<ExternalScene entry={ENTRY} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.contentWindow).not.toBeNull();
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;

    const postMessage = vi.spyOn(contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );

    const sent = postMessage.mock.calls.map(
      ([message]) => message as { type?: string; frame?: SceneFrame },
    );
    const init = sent.find((message) => message.type === "init");
    expect(init?.frame?.params).toEqual({ glow: 0.8 });
    expect(sent.some((message) => message.type === "visibility")).toBe(true);

    // Setting 改参数后 SceneHost 重渲染，桥应再推一帧。
    const before = postMessage.mock.calls.length;
    rerender(
      <ExternalScene
        entry={ENTRY}
        frame={{ ...FRAME, params: { glow: 0.2 } }}
      />,
    );
    const updates = postMessage.mock.calls
      .slice(before)
      .map(([message]) => message as { type?: string; frame?: SceneFrame })
      .filter((message) => message.type === "frame");
    expect(updates.at(-1)?.frame?.params).toEqual({ glow: 0.2 });
    postMessage.mockRestore();
  });

  test("静态场景保持空 sandbox，不建立桥", () => {
    const staticEntry: SceneCatalogEntry = {
      ...ENTRY,
      manifest: {
        ...manifest(),
        capabilities: ["wallpaper.viewport"],
        params: undefined,
      } as SceneManifest,
    };
    render(<ExternalScene entry={staticEntry} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene");
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("data-runtime")).toBe("static");
  });

  test("声明 wallpaper.pointer 的脚本场景在 ready 后收到 pointer", () => {
    render(<ExternalScene entry={pointerEntry()} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    expect(pointerHarness.handlers).toHaveLength(1);
    const postMessage = vi.spyOn(contentWindow, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    pointerHarness.handlers[0]?.({
      x: 300,
      y: 450,
      overDesktop: true,
      moving: true,
    });

    const messages = postMessage.mock.calls.map(
      ([message]) => message,
    ) as Array<{
      type?: string;
      pointer?: unknown;
    }>;
    expect(messages.find((message) => message.type === "pointer")).toEqual({
      v: 1,
      type: "pointer",
      pointer: { x: 300, y: 450, inside: true, moving: true },
    });
    postMessage.mockRestore();
  });

  test("未声明 wallpaper.pointer 的脚本场景不订阅指针事件", () => {
    render(<ExternalScene entry={ENTRY} frame={FRAME} />);
    expect(pointerHarness.handlers).toHaveLength(0);
  });

  test("页面隐藏时补发 inside=false 的取消样本", () => {
    render(<ExternalScene entry={pointerEntry()} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    const postMessage = vi.spyOn(contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    pointerHarness.handlers[0]?.({
      x: 320,
      y: 480,
      overDesktop: true,
      moving: true,
    });

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    const messages = postMessage.mock.calls.map(
      ([message]) => message,
    ) as Array<{
      type?: string;
      pointer?: unknown;
    }>;
    expect(messages.at(-1)).toMatchObject({
      type: "pointer",
      pointer: { x: 320, y: 480, inside: false, moving: false },
    });
    visibility.mockRestore();
    postMessage.mockRestore();
  });
});

function audioFrame(source: AudioFrame["source"], timestamp = 10): AudioFrame {
  return {
    protocol: 1,
    timestamp,
    sequence: 1,
    source,
    active: true,
    level: { rms: 0.2, peak: 0.4, normalized: 0.5 },
    bands: { bass: 0.5, lowMid: 0.4, mid: 0.3, highMid: 0.2, treble: 0.1 },
  };
}

function audioEntry(): SceneCatalogEntry {
  return {
    ...ENTRY,
    manifest: {
      ...manifest(),
      capabilities: [...manifest().capabilities, "wallpaper.audio"],
      audio: { sources: ["music", "noise"], features: ["level", "bands"] },
      compatibility: { hostApi: 5, platforms: ["windows"] },
    } as SceneManifest,
  };
}

describe("ExternalScene 音频响应", () => {
  test("声明 wallpaper.audio 的场景连接后收到 audio.init，订阅后只转发声明的来源", async () => {
    render(<ExternalScene entry={audioEntry()} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    const postMessage = vi.spyOn(contentWindow, "postMessage");
    await Promise.resolve();

    const connection = audioHarness.connections[0];
    expect(connection?.options.sources).toEqual(["music", "noise"]);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    let sent = postMessage.mock.calls.map(([message]) => message) as Array<{
      type?: string;
      frames?: AudioFrame[];
    }>;
    expect(
      sent.filter((message) => message.type === "audio.init"),
    ).toHaveLength(1);

    // 场景收窄到 music；noise 帧不应被转发。
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: {
          v: 1,
          type: "audio.subscribe",
          options: { sources: ["music"], features: ["level"] },
        },
      }),
    );
    connection?.emitFrames([audioFrame("music"), audioFrame("noise")]);

    sent = postMessage.mock.calls.map(([message]) => message) as Array<{
      type?: string;
      frames?: AudioFrame[];
    }>;
    const frameMessage = sent.find((message) => message.type === "audio.frame");
    expect(frameMessage?.frames?.map((frame) => frame.source)).toEqual([
      "music",
    ]);
    postMessage.mockRestore();
  });

  test("未声明 wallpaper.audio 的脚本场景不建立连接，也丢弃音频请求", async () => {
    render(<ExternalScene entry={ENTRY} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    const postMessage = vi.spyOn(contentWindow, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "audio.subscribe", options: {} },
      }),
    );

    expect(audioHarness.connections).toHaveLength(0);
    const sent = postMessage.mock.calls.map(([message]) => message) as Array<{
      type?: string;
    }>;
    expect(sent.some((message) => message.type?.startsWith("audio."))).toBe(
      false,
    );
    postMessage.mockRestore();
  });

  test("audio.requestSnapshot 返回当前缓存快照", async () => {
    render(<ExternalScene entry={audioEntry()} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    const postMessage = vi.spyOn(contentWindow, "postMessage");
    await Promise.resolve();

    const connection = audioHarness.connections[0];
    connection?.setSnapshot({
      protocol: 1,
      timestamp: 12,
      sources: {
        music: audioFrame("music", 12),
        noise: null,
        mix: null,
        master: null,
      },
    });
    await Promise.resolve();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "audio.requestSnapshot", requestId: "req-1" },
      }),
    );

    const sent = postMessage.mock.calls.map(([message]) => message) as Array<{
      type?: string;
      requestId?: string;
      snapshot?: AudioSnapshot;
    }>;
    const reply = sent.find((message) => message.type === "audio.snapshot");
    expect(reply?.requestId).toBe("req-1");
    expect(reply?.snapshot?.sources.music?.timestamp).toBe(12);
    postMessage.mockRestore();
  });

  test("订阅未声明的来源时拒绝转发，而不是回退成全量", async () => {
    render(<ExternalScene entry={audioEntry()} frame={FRAME} />);
    const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) return;
    const postMessage = vi.spyOn(contentWindow, "postMessage");
    await Promise.resolve();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: { v: 1, type: "ready", protocol: 1 },
      }),
    );
    const before = postMessage.mock.calls.length;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: contentWindow,
        data: {
          v: 1,
          type: "audio.subscribe",
          options: { sources: ["master"] },
        },
      }),
    );
    audioHarness.connections[0]?.emitFrames([
      audioFrame("music"),
      audioFrame("noise"),
    ]);
    const sent = postMessage.mock.calls
      .slice(before)
      .map(([message]) => message) as Array<{ type?: string }>;
    expect(sent.some((message) => message.type === "audio.frame")).toBe(false);
    postMessage.mockRestore();
  });

  test("卸载时断开音频连接", async () => {
    const { unmount } = render(
      <ExternalScene entry={audioEntry()} frame={FRAME} />,
    );
    await Promise.resolve();
    const connection = audioHarness.connections[0];
    unmount();
    expect(connection?.disconnect).toHaveBeenCalled();
  });
});


test("只有声明环境能力的场景收到缓存和更新", () => {
  const entry = { ...ENTRY, manifest: { ...manifest(), capabilities: [...manifest().capabilities, "wallpaper.environment"] } as SceneManifest };
  const view = render(<ExternalScene entry={entry} frame={FRAME} />);
  expect(environmentHarness.handlers).toHaveLength(1);
  const iframe = screen.getByTestId("external-scene") as HTMLIFrameElement;
  const child = iframe.contentWindow!;
  const sent = vi.spyOn(child, "postMessage");
  environmentHarness.handlers[0]({ targets: { rain: 0.7 }, revision: 1, timestamp: 1 });
  window.dispatchEvent(new MessageEvent("message", { source: child, data: { v: 1, type: "ready", protocol: 1 } }));
  expect(sent.mock.calls.some(([m]) => m.type === "environment.targets" && m.snapshot.targets.rain === 0.7)).toBe(true);
  environmentHarness.handlers[0]({ targets: {}, revision: 2, timestamp: 2 });
  expect(sent.mock.calls.some(([m]) => m.type === "environment.targets" && m.snapshot.revision === 2)).toBe(true);
  view.unmount();
  expect(environmentHarness.unlisten).toHaveBeenCalled();
  environmentHarness.handlers.length = 0;
  render(<ExternalScene entry={ENTRY} frame={FRAME} />);
  expect(environmentHarness.handlers).toHaveLength(0);
});
