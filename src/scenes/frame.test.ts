import { expect, test } from "vitest";
import type { WallpaperParams } from "@/core/wallpaper/params";
import {
  parseSceneManifest,
  type SceneCatalogEntry,
  type SceneManifest,
} from "@/sdk/scene";
import { resolveSceneFrame, type SceneEnvironment } from "./frame";

const BASE_PARAMS: WallpaperParams = {
  mode: "mirror",
  sync: true,
  scene: "test.scene",
  canvas: { x: -1920, y: 0, w: 3840, h: 1080 },
  view: { x: 0, y: 0, w: 1920, h: 1080 },
  params: {},
};

const ENV: SceneEnvironment = {
  viewportW: 1920,
  viewportH: 1080,
  dpr: 1.5,
  epochMs: 1234,
  reducedMotion: false,
};

function scene(overrides: Record<string, unknown> = {}): SceneCatalogEntry {
  const manifest: SceneManifest = parseSceneManifest({
    schemaVersion: 1,
    type: "scene",
    id: "test.scene",
    name: "测试场景",
    version: "1.0.0",
    license: "Apache-2.0",
    capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
    ...overrides,
  });
  return {
    manifest,
    source: "builtin",
    entryUrl: null,
    component: null,
  };
}

test("mirror keeps viewport layout and exposes mode and monitor rect", () => {
  const frame = resolveSceneFrame(scene(), BASE_PARAMS, ENV);
  expect(frame).toMatchObject({
    mode: "mirror",
    layout: "viewport",
    canvas: null,
    view: { x: 0, y: 0, w: 1920, h: 1080 },
    viewport: { w: 1920, h: 1080, dpr: 1.5 },
    dpr: 1.5,
  });
  expect(frame?.sync).toEqual({ enabled: true, epochMs: 1234 });
});

test("independent forces sync off but keeps viewport geometry", () => {
  const frame = resolveSceneFrame(
    scene(),
    { ...BASE_PARAMS, mode: "independent", sync: true },
    ENV,
  );
  expect(frame?.mode).toBe("independent");
  expect(frame?.layout).toBe("viewport");
  expect(frame?.canvas).toBeNull();
  expect(frame?.sync.enabled).toBe(false);
});

test("span uses shared canvas when the scene declares the capability", () => {
  const frame = resolveSceneFrame(
    scene(),
    { ...BASE_PARAMS, mode: "span", sync: false },
    ENV,
  );
  expect(frame?.layout).toBe("canvas");
  expect(frame?.canvas).toEqual({ x: -1920, y: 0, w: 3840, h: 1080 });
  expect(frame?.sync.enabled).toBe(true);
});

test("span degrades to viewport when canvas capability is missing", () => {
  const frame = resolveSceneFrame(
    scene({ capabilities: ["wallpaper.viewport", "wallpaper.sync"] }),
    { ...BASE_PARAMS, mode: "span" },
    ENV,
  );
  expect(frame?.layout).toBe("viewport");
  expect(frame?.canvas).toBeNull();
});

test("sync is disabled when the scene does not declare wallpaper.sync", () => {
  const frame = resolveSceneFrame(
    scene({ capabilities: ["wallpaper.viewport"] }),
    BASE_PARAMS,
    ENV,
  );
  expect(frame?.sync.enabled).toBe(false);
});

test("external static content never receives sync even if it declares it", () => {
  const external: SceneCatalogEntry = {
    ...scene(),
    source: "content",
    entryUrl: "/content/test/index.html",
  };
  const frame = resolveSceneFrame(external, BASE_PARAMS, ENV);
  expect(frame?.sync.enabled).toBe(false);
});

test("external scripted content receives sync through the bridge", () => {
  const external: SceneCatalogEntry = {
    ...scene({
      capabilities: [
        "wallpaper.viewport",
        "wallpaper.sync",
        "wallpaper.script",
      ],
    }),
    source: "user",
    entryUrl: "/content/test/index.html",
  };
  const frame = resolveSceneFrame(external, BASE_PARAMS, ENV);
  expect(frame?.sync).toEqual({ enabled: true, epochMs: 1234 });
});

test("scene params resolve from stored strings and manifest defaults", () => {
  const frame = resolveSceneFrame(
    scene({
      capabilities: [
        "wallpaper.viewport",
        "wallpaper.canvas",
        "wallpaper.sync",
        "wallpaper.params",
      ],
      params: [
        {
          key: "density",
          type: "number",
          label: "密度",
          default: 0.5,
          min: 0,
          max: 1,
        },
        {
          key: "tone",
          type: "enum",
          label: "色调",
          default: "warm",
          options: [
            { value: "warm", label: "暖" },
            { value: "cool", label: "冷" },
          ],
        },
      ],
    }),
    { ...BASE_PARAMS, params: { density: "0.8", tone: "cool" } },
    ENV,
  );
  expect(frame?.params).toEqual({ density: 0.8, tone: "cool" });
});

test("incompatible host API or platform returns null", () => {
  expect(
    resolveSceneFrame(
      scene({ compatibility: { hostApi: 2 } }),
      BASE_PARAMS,
      ENV,
    ),
  ).toBeNull();
  expect(
    resolveSceneFrame(
      scene({ compatibility: { hostApi: 1, platforms: ["macos"] } }),
      BASE_PARAMS,
      ENV,
    ),
  ).toBeNull();
});

test("passes reduced motion and performance hints to the scene", () => {
  const frame = resolveSceneFrame(
    scene({ performance: { tier: "low", targetFps: 30 } }),
    BASE_PARAMS,
    { ...ENV, reducedMotion: true },
  );
  expect(frame?.reducedMotion).toBe(true);
  expect(frame?.performance).toEqual({ tier: "low", targetFps: 30 });
});
