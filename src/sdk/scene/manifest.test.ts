import { describe, expect, test } from "vitest";
import catalogJson from "../../../public/content/catalog.json" with {
  type: "json",
};
import {
  isSafeContentEntry,
  parseSceneCatalog,
  parseSceneManifest,
  sceneEntryUrl,
} from "./index";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "scene",
    id: "community.example",
    name: "示例",
    version: "1.0.0",
    license: "CC-BY-4.0",
    capabilities: ["wallpaper.viewport"],
    entry: "scenes/example/index.html",
    integrity: {
      algorithm: "sha256",
      scope: "package",
      digest: "b".repeat(64),
    },
    ...overrides,
  };
}

describe("scene manifest", () => {
  test("parses a minimal valid content package", () => {
    const manifest = parseSceneManifest(validManifest(), {
      requireEntry: true,
    });
    expect(manifest.id).toBe("community.example");
    expect(manifest.capabilities).toEqual(["wallpaper.viewport"]);
    expect(manifest.entry).toBe("scenes/example/index.html");
  });

  test("requires an entry for external content but not for built-ins", () => {
    const builtin = validManifest({ entry: undefined });
    expect(() => parseSceneManifest(builtin)).not.toThrow();
    expect(() => parseSceneManifest(builtin, { requireEntry: true })).toThrow(
      /entry/,
    );
  });

  test("rejects unknown capabilities and schema versions", () => {
    expect(() =>
      parseSceneManifest(
        validManifest({ capabilities: ["wallpaper.teleport"] }),
      ),
    ).toThrow(/capability/);
    expect(() =>
      parseSceneManifest(validManifest({ schemaVersion: 2 })),
    ).toThrow(/schemaVersion/);
  });

  test("rejects entry paths that escape the content root", () => {
    expect(isSafeContentEntry("scenes/example/index.html")).toBe(true);
    expect(isSafeContentEntry("../secrets.html")).toBe(false);
    expect(isSafeContentEntry("/scenes/example/index.html")).toBe(false);
    expect(isSafeContentEntry("scenes/..%2f/index.html")).toBe(false);
    expect(() =>
      parseSceneManifest(validManifest({ entry: "../secrets.html" }), {
        requireEntry: true,
      }),
    ).toThrow(/entry/);
  });

  test("skips duplicate ids instead of rejecting the whole catalog", () => {
    const duplicate = {
      schemaVersion: 1,
      scenes: [validManifest(), validManifest({ name: "另一个" })],
    };
    const catalog = parseSceneCatalog(duplicate);
    expect(catalog.scenes).toHaveLength(1);
    expect(catalog.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(catalog.issues[0]?.message).toMatch(/重复/);
  });

  test("keeps the rest of the catalog when one package is invalid", () => {
    const catalog = parseSceneCatalog({
      schemaVersion: 1,
      scenes: [
        validManifest(),
        validManifest({ id: "community.broken", entry: "../escape.html" }),
      ],
    });
    expect(catalog.scenes.map((manifest) => manifest.id)).toEqual([
      "community.example",
    ]);
    expect(catalog.issues).toHaveLength(1);
    expect(catalog.issues[0]?.code).toBe("invalid-manifest");
    expect(catalog.issues[0]?.id).toBe("community.broken");
  });

  test("still rejects a catalog that is unusable as a whole", () => {
    expect(() => parseSceneCatalog({ schemaVersion: 2, scenes: [] })).toThrow(
      /schemaVersion/,
    );
    expect(() => parseSceneCatalog({ schemaVersion: 1, scenes: {} })).toThrow(
      /scenes 必须是数组/,
    );
  });

  test("parses package integrity and rejects malformed digests", () => {
    const digest = "a".repeat(64);
    const manifest = parseSceneManifest(
      validManifest({
        integrity: { algorithm: "sha256", scope: "package", digest },
      }),
    );
    expect(manifest.integrity).toEqual({
      algorithm: "sha256",
      scope: "package",
      digest,
    });
    expect(() =>
      parseSceneManifest(
        validManifest({
          integrity: { algorithm: "sha256", scope: "package", digest: "XYZ" },
        }),
      ),
    ).toThrow(/integrity/);
    expect(() =>
      parseSceneManifest(
        validManifest({
          integrity: { algorithm: "sha512", scope: "package", digest },
        }),
      ),
    ).toThrow(/sha256/);
  });

  test("flags a package without integrity but still loads it", () => {
    const catalog = parseSceneCatalog({
      schemaVersion: 1,
      scenes: [validManifest({ integrity: undefined })],
    });
    expect(catalog.scenes).toHaveLength(1);
    expect(catalog.issues).toHaveLength(1);
    expect(catalog.issues[0]?.code).toBe("missing-integrity");
  });

  test("rejects unknown manifest fields", () => {
    expect(() =>
      parseSceneManifest(validManifest({ unexpected: true })),
    ).toThrow(/未知字段/);
  });

  test("parses params with defaults and enum options", () => {
    const manifest = parseSceneManifest(
      validManifest({
        capabilities: ["wallpaper.viewport", "wallpaper.params"],
        params: [
          {
            key: "density",
            type: "number",
            label: "密度",
            default: 0.5,
            min: 0,
            max: 1,
            step: 0.1,
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
    );
    expect(manifest.params).toHaveLength(2);
    expect(manifest.params?.[0]).toMatchObject({
      key: "density",
      default: 0.5,
      min: 0,
      max: 1,
    });
  });

  test("rejects invalid params", () => {
    expect(() =>
      parseSceneManifest(
        validManifest({
          params: [
            { key: "density", type: "number", label: "密度", default: "0.5" },
          ],
        }),
      ),
    ).toThrow(/default/);
    expect(() =>
      parseSceneManifest(
        validManifest({
          params: [
            {
              key: "tone",
              type: "enum",
              label: "色调",
              default: "hot",
              options: [{ value: "warm", label: "暖" }],
            },
          ],
        }),
      ),
    ).toThrow(/default/);
    expect(() =>
      parseSceneManifest(
        validManifest({
          params: [
            { key: "a", type: "number", label: "A", default: 0 },
            { key: "a", type: "boolean", label: "B", default: false },
          ],
        }),
      ),
    ).toThrow(/重复/);
  });

  test("requires wallpaper.params, and external params/sync require script", () => {
    const params = [
      { key: "density", type: "number", label: "密度", default: 0.5 },
    ];
    expect(() => parseSceneManifest(validManifest({ params }))).toThrow(
      /wallpaper.params/,
    );
    expect(() =>
      parseSceneManifest(
        validManifest({
          capabilities: ["wallpaper.viewport", "wallpaper.params"],
          params,
        }),
        { requireEntry: true },
      ),
    ).toThrow(/wallpaper.script/);
    expect(() =>
      parseSceneManifest(
        validManifest({
          capabilities: ["wallpaper.viewport", "wallpaper.sync"],
        }),
        { requireEntry: true },
      ),
    ).toThrow(/wallpaper.script/);
    expect(() =>
      parseSceneManifest(
        validManifest({
          capabilities: [
            "wallpaper.viewport",
            "wallpaper.params",
            "wallpaper.script",
          ],
          params,
        }),
        { requireEntry: true },
      ),
    ).not.toThrow();
  });

  test("parses performance and compatibility metadata", () => {
    const manifest = parseSceneManifest(
      validManifest({
        performance: { tier: "low", targetFps: 30 },
        compatibility: { hostApi: 1, platforms: ["windows"] },
      }),
    );
    expect(manifest.performance).toEqual({ tier: "low", targetFps: 30 });
    expect(manifest.compatibility).toEqual({
      hostApi: 1,
      platforms: ["windows"],
    });
  });

  test("rejects invalid theme colors", () => {
    expect(() =>
      parseSceneManifest(validManifest({ theme: { background: "black" } })),
    ).toThrow(/background/);
  });
});

describe("shipped content catalog", () => {
  test("is valid and exposes the mist example", () => {
    const catalog = parseSceneCatalog(catalogJson, {
      where: "test catalog",
    });
    expect(catalog.issues).toEqual([]);
    expect(catalog.scenes).toHaveLength(1);
    const [mist] = catalog.scenes;
    expect(mist.id).toBe("community.mist");
    expect(mist.integrity?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sceneEntryUrl(mist)).toBe("/content/scenes/mist/index.html");
  });
});
