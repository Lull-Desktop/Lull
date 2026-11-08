import { describe, expect, test } from "vitest";
import { SCENE_HOST_API, type SceneFrame } from "@/sdk/scene";
import {
  isScenePluginMessage,
  SCENE_BRIDGE_PROTOCOL,
  sceneFrameMessage,
  sceneInitMessage,
  scenePointerMessage,
  sceneVisibilityMessage,
} from "./scene-bridge";

const FRAME: SceneFrame = {
  mode: "mirror",
  layout: "viewport",
  sync: { enabled: false, epochMs: 0 },
  viewport: { w: 1920, h: 1080, dpr: 1 },
  canvas: null,
  view: { x: 0, y: 0, w: 1920, h: 1080 },
  dpr: 1,
  params: { mist: 0.5, tint: "#9fc7c2" },
  reducedMotion: false,
  performance: null,
};

describe("scene bridge protocol", () => {
  test("init carries hostApi, id, frame and visibility", () => {
    expect(sceneInitMessage("demo.param-scene", FRAME, true)).toEqual({
      v: SCENE_BRIDGE_PROTOCOL,
      type: "init",
      protocol: SCENE_BRIDGE_PROTOCOL,
      hostApi: SCENE_HOST_API,
      id: "demo.param-scene",
      frame: FRAME,
      visible: true,
    });
  });

  test("frame and visibility messages stay minimal", () => {
    expect(sceneFrameMessage(FRAME)).toEqual({
      v: 1,
      type: "frame",
      frame: FRAME,
    });
    expect(sceneVisibilityMessage(false)).toEqual({
      v: 1,
      type: "visibility",
      visible: false,
    });
  });

  test("pointer message carries only move state and local coordinates", () => {
    const pointer = { x: 12.5, y: 30, inside: true, moving: false };
    const message = scenePointerMessage(pointer);
    expect(message).toEqual({ v: 1, type: "pointer", pointer });
    expect(Object.keys(message)).toEqual(["v", "type", "pointer"]);
    expect(Object.keys(pointer)).toEqual(["x", "y", "inside", "moving"]);
  });

  test("accepts only ready/log from the scene", () => {
    expect(isScenePluginMessage({ v: 1, type: "ready", protocol: 1 })).toBe(
      true,
    );
    expect(
      isScenePluginMessage({
        v: 1,
        type: "log",
        level: "warn",
        message: "参数已应用",
      }),
    ).toBe(true);
    expect(isScenePluginMessage({ v: 2, type: "ready", protocol: 1 })).toBe(
      false,
    );
    expect(isScenePluginMessage({ v: 1, type: "ready", protocol: 2 })).toBe(
      false,
    );
    expect(isScenePluginMessage({ v: 1, type: "log", level: "warn" })).toBe(
      false,
    );
    expect(isScenePluginMessage(null)).toBe(false);
  });
});
