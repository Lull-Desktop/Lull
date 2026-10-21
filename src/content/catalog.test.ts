import { describe, expect, test } from "vitest";
import { ContentCatalogError, loadContentSceneEntries } from "./catalog";

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

const PAYLOAD = {
  schemaVersion: 1,
  scenes: [
    {
      schemaVersion: 1,
      type: "scene",
      id: "community.mist",
      name: "雾岚",
      version: "1.0.0",
      license: "MIT",
      capabilities: ["wallpaper.viewport"],
      entry: "scenes/mist/index.html",
    },
  ],
};

describe("content catalog loader", () => {
  test("maps manifests to loadable entries", async () => {
    const fetcher = (() =>
      Promise.resolve(response(PAYLOAD))) as unknown as typeof fetch;
    const entries = await loadContentSceneEntries(fetcher);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("content");
    expect(entries[0]?.component).toBeNull();
    expect(entries[0]?.entryUrl).toBe("/content/scenes/mist/index.html");
  });

  test("reports HTTP failures without throwing raw fetch errors", async () => {
    const fetcher = (() =>
      Promise.resolve(response({}, false, 404))) as unknown as typeof fetch;
    await expect(loadContentSceneEntries(fetcher)).rejects.toBeInstanceOf(
      ContentCatalogError,
    );
  });

  test("rejects catalogs whose entry targets a different origin", async () => {
    const bad = {
      ...PAYLOAD,
      scenes: [
        {
          ...PAYLOAD.scenes[0],
          entry: "https://evil.example/scene.html",
        },
      ],
    };
    const fetcher = (() =>
      Promise.resolve(response(bad))) as unknown as typeof fetch;
    await expect(loadContentSceneEntries(fetcher)).rejects.toThrow();
  });
});
