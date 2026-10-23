import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SceneCatalogEntry, SceneManifest } from "@/sdk/scene";
import { WallpaperPanel } from "./wallpaper-panel";

const invoke = vi.hoisted(() => vi.fn());
const entry = vi.hoisted<{ current: SceneCatalogEntry | null }>(() => ({
  current: null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/hooks/use-scene-catalog", () => ({
  useSceneCatalog: () => ({
    entries: entry.current ? [entry.current] : [],
    error: null,
    issues: [],
  }),
}));

function manifest(): SceneManifest {
  return {
    schemaVersion: 1,
    type: "scene",
    id: "demo.param-scene",
    name: "参数演示",
    version: "1.0.0",
    license: "CC-BY-4.0",
    capabilities: [
      "wallpaper.viewport",
      "wallpaper.params",
      "wallpaper.script",
    ],
    entry: "scenes/param-demo/index.html",
    params: [
      {
        key: "glow",
        type: "number",
        label: "光晕强度",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    compatibility: { hostApi: 1, platforms: ["windows"] },
  } as SceneManifest;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "wallpaper_get_visible":
        return true;
      case "wallpaper_monitors":
        return [];
      case "wallpaper_display_get":
        return {
          mode: "mirror",
          sync: true,
          scene: "demo.param-scene",
          sceneParams: {},
        };
      default:
        return undefined;
    }
  });
  entry.current = {
    manifest: manifest(),
    source: "user",
    entryUrl:
      "http://lullcontent.localhost/demo.param-scene/scenes/param-demo/index.html",
    component: null,
  };
});

describe("WallpaperPanel external params", () => {
  test("已安装的场景包参数出现在 Setting，并能写回宿主", async () => {
    render(<WallpaperPanel />);

    const slider = await screen.findByRole("slider", { name: "光晕强度" });
    expect(screen.getByText(/参数由 Setting 实时下发到场景桥/)).toBeDefined();

    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyUp(slider, { key: "End" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_scene_params", {
        scene: "demo.param-scene",
        params: { glow: "1.00" },
      });
    });
  });

  test("没有 wallpaper.params 的场景不渲染参数控件，并给出提示", async () => {
    const current = entry.current;
    if (!current) throw new Error("entry 未初始化");
    entry.current = {
      ...current,
      manifest: {
        ...manifest(),
        capabilities: ["wallpaper.viewport"],
      } as SceneManifest,
    };
    render(<WallpaperPanel />);

    expect(await screen.findByText(/没有声明 wallpaper.params/)).toBeDefined();
    expect(screen.queryByLabelText("光晕强度")).toBeNull();
  });
});
