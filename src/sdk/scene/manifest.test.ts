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

  test("rejects duplicate ids inside one catalog", () => {
    const duplicate = {
      schemaVersion: 1,
      scenes: [validManifest(), validManifest({ name: "另一个" })],
    };
    expect(() => parseSceneCatalog(duplicate)).toThrow(/重复/);
  });
});

describe("shipped content catalog", () => {
  test("is valid and exposes the mist example", () => {
    const catalog = parseSceneCatalog(catalogJson, {
      where: "test catalog",
    });
    expect(catalog.scenes).toHaveLength(1);
    const [mist] = catalog.scenes;
    expect(mist.id).toBe("community.mist");
    expect(sceneEntryUrl(mist)).toBe("/content/scenes/mist/index.html");
  });
});
