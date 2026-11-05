import { describe, expect, test } from "vitest";
import {
  controllerIdentityLabel,
  isGameControllerContext,
} from "./game-controller-shell";

function context(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    hostApi: 1,
    role: "controller",
    gameId: "community.living-world",
    instanceId: "0192f3a0000000000000000000000001",
    controllerId: "panel",
    label: "Living World 控制台",
    entryUrl:
      "http://lullgame.localhost/community.living-world/controllers/panel/index.html",
    token: "a".repeat(64),
    limits: {
      maxStateBytes: 1024,
      maxEventBytes: 1024,
      maxEventsPerCommit: 8,
      maxRenderStateBytes: 1024,
      maxReplicas: 2,
      tickMs: 1000,
    },
    locale: "zh-CN",
    allowedCommands: ["plant.seed"],
    window: {
      width: 380,
      height: 520,
      minWidth: 380,
      minHeight: 520,
      resizable: false,
      alwaysOnTop: false,
    },
    ...overrides,
  };
}

describe("game controller context", () => {
  test("accepts the host-injected controller context", () => {
    expect(isGameControllerContext(context())).toBe(true);
  });

  test("rejects wrong role, missing token and non-http entry", () => {
    expect(isGameControllerContext(context({ role: "authority" }))).toBe(false);
    expect(isGameControllerContext(context({ token: "" }))).toBe(false);
    expect(
      isGameControllerContext(context({ entryUrl: "javascript:alert(1)" })),
    ).toBe(false);
    const { controllerId: _controllerId, ...withoutId } = context();
    expect(isGameControllerContext(withoutId)).toBe(false);
  });

  test("controller identity includes game and short instance id", () => {
    const label = controllerIdentityLabel({
      gameId: "community.phaser-demo",
      controllerId: "ambient-phaser",
      instanceId: "0192f3a0000000000000000000000001",
    });
    expect(label).toContain("community.phaser-demo");
    expect(label).toContain("0192f3a0…0001");
  });
});
