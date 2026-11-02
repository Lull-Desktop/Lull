import { describe, expect, test } from "vitest";
import { DEFAULT_SCENE_ID } from "@/core/wallpaper/params";
import {
  BUILTIN_SCENES,
  builtinCatalogEntries,
  builtinScene,
} from "./registry";

describe("builtin scene registry", () => {
  test("declares unique namespaced ids with valid manifests", () => {
    const ids = BUILTIN_SCENES.map((scene) => scene.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scene of BUILTIN_SCENES) {
      expect(scene.manifest.id).toMatch(/^[a-z0-9][a-z0-9._-]+$/);
      expect(scene.manifest.license).toBe("GPL-3.0-or-later");
      expect(scene.manifest.capabilities).toContain("wallpaper.canvas");
    }
  });

  test("host only compiles the media scene", () => {
    expect(BUILTIN_SCENES.map((scene) => scene.manifest.id)).toEqual([
      "lull.video",
    ]);
    expect(builtinScene("lull.video")?.manifest.name).toBe("媒体");
    expect(builtinCatalogEntries()[0]?.manifest.id).toBe("lull.video");
  });

  test("default bamboo is provided by the official extension, not the host", () => {
    expect(builtinScene(DEFAULT_SCENE_ID)).toBeNull();
  });

  test("unknown id does not resolve", () => {
    expect(builtinScene("community.missing")).toBeNull();
  });
});
