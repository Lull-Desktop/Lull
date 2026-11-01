import { describe, expect, test } from "vitest";

import { createMediaClient } from "./client";
import { LullMediaError } from "./errors";
import { MEDIA_PROTOCOL } from "./protocol";
import { createMemoryTransport } from "./testing";
import type { Page, TrackSummary } from "./types";

const track: TrackSummary = {
  id: "trk_1",
  title: "雨",
  artists: ["Lull"],
  source: "online",
  available: true,
  hasCover: false,
};

const page: Page<TrackSummary> = {
  items: [track],
  total: 1,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

describe("media client", () => {
  test("sends a protocol 1 request and parses the result", async () => {
    const transport = createMemoryTransport((request) => {
      expect(request.protocol).toBe(MEDIA_PROTOCOL);
      expect(request.namespace).toBe("library");
      expect(request.method).toBe("listTracks");
      expect(request.args).toMatchObject({ keyword: "雨", page: 1 });
      return page;
    });
    const media = createMediaClient({ transport });

    const result = await media.library.listTracks({ keyword: "雨", page: 1 });

    expect(result.items[0]?.title).toBe("雨");
    expect(transport.requests).toHaveLength(1);
  });

  test("throws a typed error for a failed response", async () => {
    const transport = createMemoryTransport(() => {
      throw new LullMediaError({
        code: "capability.denied",
        message: "没有权限",
      });
    });
    const media = createMediaClient({ transport });

    await expect(media.library.listSources()).rejects.toMatchObject({
      code: "capability.denied",
    });
  });

  test("adds the request id and preserves caller args", async () => {
    const transport = createMemoryTransport(() => ({ removed: true }));
    const media = createMediaClient({ transport });

    await expect(media.library.removeSource("src_1")).resolves.toBe(true);
    expect(transport.requests[0]?.requestId).toMatch(/.+/);
    expect(transport.requests[0]?.args).toEqual({ sourceId: "src_1" });
  });

  test("routes cover URL and genre reads", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.method === "getCoverUrl") {
        return { url: "asset://localhost/cover.jpg" };
      }
      return ["Ambient", "Jazz"];
    });
    const media = createMediaClient({ transport });

    await expect(media.library.getCoverUrl("trk_1")).resolves.toBe(
      "asset://localhost/cover.jpg",
    );
    await expect(media.library.listGenres()).resolves.toEqual([
      "Ambient",
      "Jazz",
    ]);
    expect(transport.requests[0]?.args).toEqual({ trackId: "trk_1" });
  });

  test("routes player, queue and noise methods with the expected args", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.namespace === "player") {
        return { status: "playing", track, positionMs: 0 };
      }
      if (request.namespace === "queue") {
        return { trackIds: ["trk_1"], revision: 1 };
      }
      return {
        sessionId: "noise",
        active: true,
        master: 0.5,
        muted: false,
        layers: [],
        sleep: { timerMinutes: 0 },
        revision: 1,
      };
    });
    const media = createMediaClient({ transport });

    await media.player.play("trk_1");
    await media.player.seek(1200.6);
    await media.queue.add("trk_1", 0);
    await media.noise.setLayer("rain", { enabled: true, volume: 0.4 });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "play",
      "seek",
      "add",
      "setLayer",
    ]);
    expect(transport.requests[0]?.args).toEqual({ trackId: "trk_1" });
    expect(transport.requests[1]?.args).toEqual({ positionMs: 1201 });
    expect(transport.requests[2]?.args).toEqual({ trackId: "trk_1", index: 0 });
    expect(transport.requests[3]?.args).toEqual({
      soundId: "rain",
      enabled: true,
      volume: 0.4,
    });
  });

  test("routes output volume through the system namespace", async () => {
    const transport = createMemoryTransport((request) => {
      expect(request.namespace).toBe("system");
      return {
        volume: request.method === "getOutput" ? 0.5 : 0.7,
        muted: false,
      };
    });
    const media = createMediaClient({ transport });

    await expect(media.system.getOutput()).resolves.toEqual({
      volume: 0.5,
      muted: false,
    });
    await expect(media.system.setOutput({ volume: 0.7 })).resolves.toEqual({
      volume: 0.7,
      muted: false,
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "getOutput",
      "setOutput",
    ]);
    expect(transport.requests[1]?.args).toEqual({ volume: 0.7 });
  });

  test("routes playlists, favorites and history", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.namespace === "playlists") {
        if (request.method === "list") return [];
        return {
          id: "pl_1",
          name: "Mix",
          trackCount: 0,
          createdAt: 1,
          updatedAt: 2,
          entries: [],
        };
      }
      if (request.namespace === "favorites") {
        return { items: [], total: 0, page: 1, pageSize: 50, hasMore: false };
      }
      return { cleared: 0 };
    });
    const media = createMediaClient({ transport });

    await media.playlists.list();
    await media.playlists.create("Mix");
    await media.playlists.addTrack("pl_1", "trk_1");
    await media.favorites.set("trk_1", true);
    await media.history.clear();

    expect(transport.requests.map((request) => request.method)).toEqual([
      "list",
      "create",
      "addTrack",
      "set",
      "clear",
    ]);
    expect(transport.requests[1]?.args).toEqual({
      name: "Mix",
      description: undefined,
    });
    expect(transport.requests[2]?.args).toEqual({
      playlistId: "pl_1",
      trackId: "trk_1",
    });
    expect(transport.requests[3]?.args).toEqual({
      trackId: "trk_1",
      favorite: true,
    });
  });

  test("routes Noise session and track methods", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.method === "addTrack") {
        return {
          id: "track-1",
          assetId: "noise:builtin:rain",
          name: "Rain",
          state: "stopped",
          volume: 0.7,
          enabled: true,
          loop: true,
          positionMs: 0,
          order: 0,
        };
      }
      return {
        id: "session-1",
        state: "idle",
        masterVolume: 0.75,
        muted: false,
        tracks: [],
        sleep: { timerMinutes: 0 },
        revision: 1,
        createdAt: 1,
      };
    });
    const media = createMediaClient({ transport });

    await media.noise.session.getCurrent();
    await media.noise.session.play();
    await media.noise.tracks.add("noise:builtin:rain");
    await media.noise.tracks.setVolume("track-1", 0.4);
    await media.noise.tracks.setEnabled("track-1", false);
    await media.noise.tracks.reorder("track-1", 0);

    expect(transport.requests.map((request) => request.method)).toEqual([
      "getSession",
      "playSession",
      "addTrack",
      "setTrackVolume",
      "setTrackEnabled",
      "reorderTracks",
    ]);
    expect(transport.requests[2]?.args).toEqual({
      assetId: "noise:builtin:rain",
    });
    expect(transport.requests[3]?.args).toEqual({
      trackId: "track-1",
      volume: 0.4,
    });
    expect(transport.requests[4]?.args).toEqual({
      trackId: "track-1",
      enabled: false,
    });
  });

  test("routes Noise library methods", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.method === "listAssets") {
        return { items: [], total: 0, page: 1, pageSize: 30, hasMore: false };
      }
      if (request.method === "revalidateAssets") {
        return { checked: 2, missing: 1, restored: 0 };
      }
      return {
        id: "asset-1",
        name: "Rain",
        mediaKind: "file",
        format: "wav",
        sizeBytes: 10,
        tags: [],
        favorite: true,
        status: "available",
        source: "local",
        capabilities: { loop: true, seek: true, fade: true },
        createdAt: 1,
        updatedAt: 2,
      };
    });
    const media = createMediaClient({ transport });

    await media.noise.library.listAssets({
      keyword: "rain",
      favoriteOnly: true,
    });
    await media.noise.library.setAssetFavorite("asset-1", true);
    await media.noise.library.importAssets({ paths: ["rain.wav"] });
    await media.noise.library.updateAsset("asset-1", {
      name: "Rain",
      categoryId: null,
    });
    await media.noise.library.removeAsset("asset-1");
    await media.noise.library.revalidateAssets();

    expect(transport.requests.map((request) => request.method)).toEqual([
      "listAssets",
      "setAssetFavorite",
      "importAssets",
      "updateAsset",
      "removeAsset",
      "revalidateAssets",
    ]);
    expect(transport.requests[0]?.args).toEqual({
      keyword: "rain",
      favoriteOnly: true,
    });
    expect(transport.requests[2]?.args).toEqual({ paths: ["rain.wav"] });
    expect(transport.requests[3]?.args).toEqual({
      assetId: "asset-1",
      name: "Rain",
      categoryId: null,
    });
  });

  test("routes Noise taxonomy CRUD", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.method === "createTag" || request.method === "updateTag") {
        return {
          id: "tag-1",
          name: "Rain",
          assetCount: 0,
          sourceType: "user",
        };
      }
      if (request.method === "createCategory" || request.method === "updateCategory") {
        return {
          id: "cat-1",
          name: "Weather",
          sortOrder: 100,
          assetCount: 0,
          sourceType: "user",
        };
      }
      return { removed: true };
    });
    const media = createMediaClient({ transport });

    await media.noise.library.createCategory({ name: "Weather" });
    await media.noise.library.updateCategory("cat-1", { name: "Climate" });
    await media.noise.library.deleteCategory("cat-1");
    await media.noise.library.createTag("Rain");
    await media.noise.library.updateTag("tag-1", "Storm");
    await media.noise.library.deleteTag("tag-1");

    expect(transport.requests.map((request) => request.method)).toEqual([
      "createCategory",
      "updateCategory",
      "deleteCategory",
      "createTag",
      "updateTag",
      "deleteTag",
    ]);
    expect(transport.requests[1]?.args).toEqual({
      categoryId: "cat-1",
      name: "Climate",
    });
    expect(transport.requests[4]?.args).toEqual({
      tagId: "tag-1",
      name: "Storm",
    });
  });

  test("routes Noise preset methods", async () => {
    const transport = createMemoryTransport((request) => {
      if (request.method === "listPresets") {
        return { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };
      }
      if (request.method === "loadPreset") {
        return { resolved: [], missing: [] };
      }
      if (request.method === "exportPreset") {
        return { fileName: "night.lull-noise.json" };
      }
      if (request.method === "importPreset") {
        return { preset: { id: "preset-1" }, tracks: [] };
      }
      if (request.method === "setPresetFavorite") {
        return { id: "preset-1", name: "Night" };
      }
      return { preset: { id: "preset-1" }, tracks: [] };
    });
    const media = createMediaClient({ transport });

    await media.noise.presets.listPresets({ favoriteOnly: true });
    await media.noise.presets.savePreset({ name: "Night" });
    await media.noise.presets.updatePreset("preset-1", { name: "Night 2" });
    await media.noise.presets.deletePreset("preset-1");
    await media.noise.presets.loadPreset("preset-1");
    await media.noise.presets.exportPreset("preset-1", "out.json");
    await media.noise.presets.importPreset("in.json");
    await media.noise.presets.mapPresetTrack("preset-1", "track-1", "asset-1");
    await media.noise.presets.setPresetFavorite("preset-1", true);

    expect(transport.requests.map((request) => request.method)).toEqual([
      "listPresets",
      "savePreset",
      "updatePreset",
      "deletePreset",
      "loadPreset",
      "exportPreset",
      "importPreset",
      "mapPresetTrack",
      "setPresetFavorite",
    ]);
    expect(transport.requests[0]?.args).toEqual({ favoriteOnly: true });
    expect(transport.requests[5]?.args).toEqual({
      presetId: "preset-1",
      path: "out.json",
    });
    expect(transport.requests[7]?.args).toEqual({
      presetId: "preset-1",
      presetTrackId: "track-1",
      assetId: "asset-1",
    });
  });
});
