import { describe, expect, test } from "vitest";
import { isGameAuthorityContext } from "./game-authority-shell";

function context(mode: unknown) {
  return {
    protocol: 1,
    hostApi: 1,
    gameId: "community.stability-probe",
    instanceId: "0192f3a0000000000000000000000001",
    authorityId: "6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    authorityEpoch: 1,
    role: "authority",
    mode,
    entryUrl:
      "http://lullgame.localhost/community.stability-probe/authority/index.html",
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
  };
}

describe("game authority context", () => {
  test("accepts both host-tick and self-loop authority modes", () => {
    expect(isGameAuthorityContext(context("host-tick"))).toBe(true);
    expect(isGameAuthorityContext(context("self-loop"))).toBe(true);
  });

  test("rejects unknown modes and missing token", () => {
    expect(isGameAuthorityContext(context("per-monitor"))).toBe(false);
    expect(isGameAuthorityContext({ ...context("self-loop"), token: "" })).toBe(
      false,
    );
  });
});
