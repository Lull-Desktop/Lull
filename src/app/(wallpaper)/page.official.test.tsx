/**
 * 官方随包场景：Rust 的 content_packages 返回 origin=bundled 的竹影时，
 * 壁纸页把它挂到 allow-scripts 的脚本 iframe，而不是内置组件。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Page from "./page";

const official = vi.hoisted(() => ({
  id: "lull.bamboo",
  name: "竹影",
  version: "1.2.0",
  status: "ready",
  entryUrl: "http://lullcontent.localhost/lull.bamboo/scenes/bamboo/index.html",
  verified: true,
  signature: {
    status: "unsigned",
    decision: "warn",
    reason: "official-bundle",
  },
  origin: "bundled",
  manifest: {
    schemaVersion: 1,
    type: "scene",
    id: "lull.bamboo",
    name: "竹影",
    version: "1.2.0",
    license: "GPL-3.0-or-later",
    capabilities: [
      "wallpaper.viewport",
      "wallpaper.canvas",
      "wallpaper.sync",
      "wallpaper.params",
      "wallpaper.script",
    ],
    entry: "scenes/bamboo/index.html",
    params: [
      {
        key: "mist",
        type: "number",
        label: "薄雾浓度",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    compatibility: { hostApi: 1, platforms: ["windows"] },
  },
}));

vi.mock("@/content/user-content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/content/user-content")>();
  return {
    ...actual,
    listUserContentPackages: vi.fn(async () => [official]),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("bundled bamboo renders through the scripted scene iframe", async () => {
  // 没有随包内容目录也不影响官方场景；这里显式让 fetch 404，避免测试联网。
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
      }),
    ),
  );
  window.location.hash = "#scene=lull.bamboo";
  render(<Page />);

  const frame = await screen.findByTestId("external-scene");
  expect(frame.getAttribute("src")).toBe(official.entryUrl);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("data-runtime")).toBe("scripted");
  expect(screen.queryByTestId("scene-video")).toBeNull();
});
