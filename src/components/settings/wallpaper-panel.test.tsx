import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GameView } from "@/lib/games";
import { m } from "@/paraglide/messages";
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
    loading: false,
    error: null,
    issues: [],
  }),
}));

function game(overrides: Partial<GameView> = {}): GameView {
  return {
    id: "community.living-world",
    name: "Living World",
    version: "1.2.0",
    status: "ready",
    enabled: true,
    granted: ["game.state.read", "game.state.write"],
    capabilities: ["game.state.read", "game.state.write"],
    entryReplicaUrl:
      "http://lullgame.localhost/community.living-world/replica/index.html",
    stateSchemaVersion: 1,
    controllers: [],
    ...overrides,
  };
}

function runningInstance(): NonNullable<GameView["instance"]> {
  return {
    gameId: "community.living-world",
    instanceId: "instance-1",
    authorityEpoch: 1,
    revision: 4,
    simulationTimeMs: 12_000,
    status: "running",
    lastError: null,
    replicas: 1,
    controllers: 0,
    updatedAt: 1,
  };
}

function mockDisplayWithGames(
  display: Record<string, unknown>,
  games: GameView[],
  monitors: Array<Record<string, unknown>> = [],
): void {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "wallpaper_get_visible":
        return true;
      case "wallpaper_monitors":
        return monitors;
      case "wallpaper_display_get":
        return display;
      case "games_list":
        return games;
      case "games_config_get":
        return undefined;
      default:
        return undefined;
    }
  });
}

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

describe("WallpaperPanel game sources", () => {
  const display = {
    mode: "mirror",
    sync: true,
    scene: "demo.param-scene",
    sceneParams: {},
  };
  const monitor = {
    device: "\\\\.\\DISPLAY1",
    index: 0,
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
    dpi: 96,
    primary: true,
    enabled: true,
    scene: "demo.param-scene",
    game: null,
  };

  async function choose(
    triggerName: string,
    optionName: string,
  ): Promise<void> {
    const trigger = await screen.findByRole("combobox", {
      name: triggerName,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = await screen.findByRole("option", { name: optionName });
    fireEvent.keyDown(option, { key: "ArrowDown" });
    fireEvent.keyDown(option, { key: "Enter" });
  }

  test("复制模式的壁纸类型下拉列出游戏，选中即设为壁纸", async () => {
    mockDisplayWithGames(display, [game()]);
    render(<WallpaperPanel />);

    await choose(m.wallpaper_scene_global(), "Living World");

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_game", {
        gameId: "community.living-world",
      });
    });
  });

  test("独立模式下，其他显示器正在使用的游戏不可重复选择", async () => {
    const secondary = {
      ...monitor,
      device: "\\\\.\\DISPLAY2",
      index: 1,
      x: -2560,
      primary: false,
      game: null,
    };
    const primary = {
      ...monitor,
      device: "\\\\.\\DISPLAY1",
      index: 0,
      x: 0,
      primary: true,
      game: "community.living-world",
    };
    mockDisplayWithGames(
      { ...display, mode: "independent" },
      [game(), game({ id: "community.other", name: "Other Living World" })],
      [secondary, primary],
    );
    render(<WallpaperPanel />);

    expect(
      await screen.findByText(m.wallpaper_games_exclusive_hint()),
    ).toBeDefined();

    const trigger = await screen.findByRole("combobox", {
      name: m.wallpaper_monitor_scene_aria({ index: "1" }),
    });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const usedOption = await screen.findByRole("option", {
      name: `Living World${m.wallpaper_game_used_elsewhere()}`,
    });
    expect(usedOption.getAttribute("data-disabled")).not.toBeNull();

    const otherGame = await screen.findByRole("option", {
      name: "Other Living World",
    });
    expect(otherGame.getAttribute("data-disabled")).toBeNull();

    const sceneOption = await screen.findByRole("option", {
      name: "参数演示",
    });
    expect(sceneOption.getAttribute("data-disabled")).toBeNull();
  });

  test("独立模式每台显示器可选择各自的游戏", async () => {
    mockDisplayWithGames(
      { ...display, mode: "independent" },
      [game()],
      [monitor],
    );
    render(<WallpaperPanel />);

    await choose(
      m.wallpaper_monitor_scene_aria({ index: "1" }),
      "Living World",
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_monitor_game", {
        device: "\\\\.\\DISPLAY1",
        gameId: "community.living-world",
      });
    });
  });

  test("切换正在运行的游戏时可选择停止，再应用新壁纸", async () => {
    mockDisplayWithGames({ ...display, game: "community.living-world" }, [
      game({ instance: runningInstance() }),
    ]);
    render(<WallpaperPanel />);

    await choose(m.wallpaper_scene_global(), "参数演示");

    expect(await screen.findByTestId("wallpaper-game-switch")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: m.wallpaper_game_switch_stop() }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_stop", {
        gameId: "community.living-world",
      });
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_display", {
        scene: "demo.param-scene",
      });
    });
  });

  test("切换正在运行的游戏时可选择后台继续", async () => {
    mockDisplayWithGames({ ...display, game: "community.living-world" }, [
      game({ instance: runningInstance() }),
    ]);
    render(<WallpaperPanel />);

    await choose(m.wallpaper_scene_global(), "参数演示");

    expect(await screen.findByTestId("wallpaper-game-switch")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", {
        name: m.wallpaper_game_switch_background(),
      }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_set_background", {
        gameId: "community.living-world",
        enabled: true,
      });
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_display", {
        scene: "demo.param-scene",
      });
    });
  });

  test("取消切换时保留旧壁纸且不停游戏", async () => {
    mockDisplayWithGames({ ...display, game: "community.living-world" }, [
      game({ instance: runningInstance() }),
    ]);
    render(<WallpaperPanel />);

    await choose(m.wallpaper_scene_global(), "参数演示");
    expect(await screen.findByTestId("wallpaper-game-switch")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: m.dialog_cancel() }));

    await waitFor(() => {
      expect(screen.queryByTestId("wallpaper-game-switch")).toBeNull();
    });
    expect(invoke).not.toHaveBeenCalledWith("game_stop", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      "wallpaper_set_display",
      expect.anything(),
    );
  });
});

describe("WallpaperPanel external params", () => {
  test("已安装的场景包参数出现在壁纸库，并能写回宿主", async () => {
    render(<WallpaperPanel />);

    const slider = await screen.findByRole("slider", { name: "光晕强度" });
    expect(screen.getByText(/参数由壁纸库窗口实时下发到场景桥/)).toBeDefined();

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
