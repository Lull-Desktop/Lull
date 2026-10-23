/**
 * 场景宿主：来源分支的回归测试。
 *
 * 曾经的 bug：渲染条件写成 `source === "content"`，用户安装（`user`）的场景既没有内置组件、
 * 又不进 iframe 分支，最终只渲染了主题背景色 —— 表现为「壁纸全黑、没有内容」。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SceneCatalogEntry, SceneManifest } from "@/sdk/scene";
import { SceneHost } from "./host";

const harness = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock("@/hooks/use-scene-catalog", () => ({
  useSceneCatalog: () => ({
    entries: harness.entries,
    error: null,
    issues: [],
  }),
}));

function manifest(id: string): SceneManifest {
  return {
    schemaVersion: 1,
    type: "scene",
    id,
    name: id,
    version: "1.0.0",
    license: "CC-BY-4.0",
    capabilities: ["wallpaper.viewport", "wallpaper.canvas"],
    entry: "scenes/demo/index.html",
    theme: { background: "#04120f", accent: "#f2c98a" },
    compatibility: { hostApi: 1, platforms: ["windows"] },
  } as unknown as SceneManifest;
}

const params = {
  mode: "mirror" as const,
  sync: false,
  scene: "demo.fireflies",
  canvas: null,
  view: null,
  params: {},
};

describe("SceneHost", () => {
  test("用户安装的内容包走 iframe 渲染，而不是空白背景", () => {
    const entry: SceneCatalogEntry = {
      manifest: manifest("demo.fireflies"),
      source: "user",
      entryUrl:
        "http://lullcontent.localhost/demo.fireflies/scenes/demo/index.html",
      component: null,
    };
    harness.entries = [entry];

    render(<SceneHost params={params} />);

    const frame = screen.getByTestId("external-scene");
    expect(frame.getAttribute("src")).toBe(entry.entryUrl);
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  test("随包内容同样走 iframe", () => {
    harness.entries = [
      {
        manifest: manifest("community.mist"),
        source: "content",
        entryUrl:
          "http://lullcontent.localhost/community.mist/scenes/demo/index.html",
        component: null,
      } satisfies SceneCatalogEntry,
    ];

    render(<SceneHost params={{ ...params, scene: "community.mist" }} />);

    expect(screen.getByTestId("external-scene")).toBeDefined();
  });

  test("内置场景用组件渲染，不套 iframe", () => {
    harness.entries = [
      {
        manifest: manifest("lull.bamboo"),
        source: "builtin",
        entryUrl: null,
        component: () => <div data-testid="builtin-scene" />,
      } satisfies SceneCatalogEntry,
    ];

    render(<SceneHost params={{ ...params, scene: "lull.bamboo" }} />);

    expect(screen.getByTestId("builtin-scene")).toBeDefined();
    expect(screen.queryByTestId("external-scene")).toBeNull();
  });
});
