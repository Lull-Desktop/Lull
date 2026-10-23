import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SceneCatalogEntry, SceneFrame, SceneManifest } from "@/sdk/scene";
import { ExternalScene } from "./external-scene";

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
});
