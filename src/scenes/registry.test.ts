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

  test("default id resolves to a builtin scene", () => {
    const scene = builtinScene(DEFAULT_SCENE_ID);
    expect(scene?.manifest.name).toBe("竹影");
    expect(builtinCatalogEntries()[0]?.manifest.id).toBe(DEFAULT_SCENE_ID);
  });

  test("unknown id does not resolve", () => {
    expect(builtinScene("community.missing")).toBeNull();
  });
});
