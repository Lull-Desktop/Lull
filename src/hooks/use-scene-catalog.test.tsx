import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { UserContentPackage } from "@/content/user-content";
import type { SceneCatalogEntry, SceneManifest } from "@/sdk/scene";
import { useSceneCatalog } from "./use-scene-catalog";

const source = vi.hoisted(() => ({
  content: [] as SceneCatalogEntry[],
  packages: [] as UserContentPackage[],
  failCatalog: false,
}));

vi.mock("@/content/catalog", () => ({
  loadContentSceneEntries: vi.fn(async () => {
    if (source.failCatalog) throw new Error("catalog offline");
    return { entries: source.content, issues: [], signature: "valid" };
  }),
}));

vi.mock("@/content/user-content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/content/user-content")>();
  return {
    ...actual,
    listUserContentPackages: vi.fn(async () => source.packages),
  };
});

function manifest(id: string, name: string): SceneManifest {
  return {
    schemaVersion: 1,
    type: "scene",
    id,
    name,
    version: "1.0.0",
    license: "CC-BY-4.0",
    capabilities: ["wallpaper.viewport"],
    entry: "scenes/demo/index.html",
    compatibility: { hostApi: 1, platforms: ["windows"] },
  } as SceneManifest;
}

function entry(
  id: string,
  name: string,
  sourceKind: SceneCatalogEntry["source"],
): SceneCatalogEntry {
  return {
    manifest: manifest(id, name),
    source: sourceKind,
    entryUrl: `http://lullcontent.localhost/${id}/scenes/demo/index.html`,
    component: null,
  };
}

function contentPackage(
  id: string,
  name: string,
  origin: "bundled" | "user",
): UserContentPackage {
  return {
    id,
    name,
    version: "1.0.0",
    status: "ready",
    entryUrl: `http://lullcontent.localhost/${id}/scenes/demo/index.html`,
    verified: true,
    signature:
      origin === "bundled"
        ? { status: "unsigned", decision: "warn", reason: "official-bundle" }
        : { status: "verified", decision: "allow" },
    origin,
    manifest: manifest(id, name),
  };
}

describe("useSceneCatalog", () => {
  test("按 builtin > official > content > user 排序并保留同 id 高优先级", async () => {
    source.failCatalog = false;
    source.content = [
      entry("community.mist", "雾岚", "content"),
      entry("lull.bamboo", "内容目录里的同名竹影", "content"),
    ];
    source.packages = [
      contentPackage("lull.bamboo", "竹影", "bundled"),
      contentPackage("community.user", "用户场景", "user"),
    ];

    const { result } = renderHook(() => useSceneCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries.map((item) => item.manifest.id)).toEqual([
      "lull.video",
      "lull.bamboo",
      "community.mist",
      "community.user",
    ]);
    expect(result.current.entries.map((item) => item.source)).toEqual([
      "builtin",
      "official",
      "content",
      "user",
    ]);
    expect(
      result.current.entries.find((item) => item.manifest.id === "lull.bamboo")
        ?.manifest.name,
    ).toBe("竹影");
  });

  test("内容目录不可用时，官方场景与内置媒体仍可用", async () => {
    source.failCatalog = true;
    source.content = [];
    source.packages = [contentPackage("lull.bamboo", "竹影", "bundled")];

    const { result } = renderHook(() => useSceneCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("catalog offline");
    expect(result.current.entries.map((item) => item.manifest.id)).toEqual([
      "lull.video",
      "lull.bamboo",
    ]);
  });
});
