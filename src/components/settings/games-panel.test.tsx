import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GameInstanceView, GameView } from "@/lib/games";
import { GamesPanel } from "./games-panel";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

function instanceView(
  overrides: Partial<GameInstanceView> = {},
): GameInstanceView {
  return {
    gameId: "community.living-world",
    instanceId: "0192f3a6aabbccddeeff001122334455",
    authorityEpoch: 1,
    revision: 0,
    simulationTimeMs: 0,
    status: "stopped",
    replicas: 0,
    controllers: 0,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function gameView(overrides: Partial<GameView> = {}): GameView {
  return {
    id: "community.living-world",
    name: "Living World",
    version: "1.0.0",
    description: "桌面生态",
    author: "Community",
    license: "MIT",
    status: "ready",
    enabled: true,
    granted: ["game.state.read", "game.state.write"],
    capabilities: ["game.state.read", "game.state.write", "game.event.publish"],
    stateSchemaVersion: 1,
    controllers: [],
    instance: null,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("GamesPanel", () => {
  test("没有安装游戏时展示空态并指向扩展页签", async () => {
    invoke.mockResolvedValue([]);

    render(<GamesPanel />);

    expect(await screen.findByTestId("games-empty")).toBeTruthy();
    expect(screen.getByText("还没有安装游戏。")).toBeTruthy();
    expect(screen.getByText(/扩展/)).toBeTruthy();
  });

  test("运行中的实例展示状态、revision、模拟时长、副本与能力", async () => {
    invoke.mockResolvedValue([
      gameView({
        instance: instanceView({
          status: "running",
          revision: 42,
          simulationTimeMs: 1_234_567,
          replicas: 2,
        }),
      }),
    ]);

    render(<GamesPanel />);

    expect(await screen.findByText("Living World")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("revision 42")).toBeTruthy();
    expect(screen.getByText("模拟时间 20分钟 34秒")).toBeTruthy();
    expect(screen.getByText("副本 2")).toBeTruthy();
    expect(screen.getByText("game.state.write")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即保存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "清除数据" })).toBeTruthy();
  });

  test("清除数据需二次确认，确认后停止、删除存档并重启", async () => {
    let cleared = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: cleared
              ? instanceView({ status: "running", revision: 0 })
              : instanceView({
                  status: "running",
                  revision: 42,
                  simulationTimeMs: 1_000,
                }),
          }),
        ];
      }
      if (command === "game_stop") {
        return instanceView({ status: "stopped" });
      }
      if (command === "game_save_delete") {
        cleared = true;
        return null;
      }
      if (command === "game_start") {
        return instanceView({ status: "running", revision: 0 });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "清除数据" }));

    expect(await screen.findByText(/全部状态和进度/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除并重置" }));

    await waitFor(() => {
      const commands = invoke.mock.calls
        .map(([command]) => command)
        .filter((command) =>
          ["game_stop", "game_save_delete", "game_start"].includes(command),
        );
      expect(commands).toEqual(["game_stop", "game_save_delete", "game_start"]);
    });
    expect(await screen.findByText("revision 0")).toBeTruthy();
  });

  test("已停止的游戏不显示清除数据", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [gameView({ instance: instanceView({ status: "stopped" }) })];
      }
      return null;
    });

    render(<GamesPanel />);
    expect(await screen.findByText("Living World")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清除数据" })).toBeNull();
  });

  test("取消清除数据时不调用停止、删档或重启", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [gameView({ instance: instanceView({ status: "running" }) })];
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "清除数据" }));
    expect(await screen.findByText(/全部状态和进度/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByText(/全部状态和进度/)).toBeNull();
    });
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("game_stop");
    expect(commands).not.toContain("game_save_delete");
    expect(commands).not.toContain("game_start");
  });

  test("清除后重启失败时展示错误并刷新为停止状态", async () => {
    let cleared = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: cleared
              ? instanceView({ status: "stopped" })
              : instanceView({ status: "running" }),
          }),
        ];
      }
      if (command === "game_stop") {
        return instanceView({ status: "stopped" });
      }
      if (command === "game_save_delete") {
        cleared = true;
        return null;
      }
      if (command === "game_start") {
        return Promise.reject({
          code: "authority.not_ready",
          message: "重启失败",
        });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "清除数据" }));
    fireEvent.click(await screen.findByRole("button", { name: "清除并重置" }));

    expect(await screen.findByText("操作失败：重启失败")).toBeTruthy();
    expect(await screen.findByText("已停止")).toBeTruthy();
  });

  test("未运行时点击启动调用 game_start 并刷新列表", async () => {
    let running = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: running ? instanceView({ status: "running" }) : null,
          }),
        ];
      }
      if (command === "game_start") {
        running = true;
        return instanceView({ status: "starting" });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "启动" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_start", {
        gameId: "community.living-world",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("运行中")).toBeTruthy();
    });
  });

  test("自动启动开关写入 games_config_set", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") return [];
      if (command === "games_config_get") {
        return {
          schemaVersion: 1,
          autoStartWithWallpaper: true,
          resumeOnLaunch: false,
          maxRunning: 2,
          offlineMaxMs: 604_800_000,
        };
      }
      if (command === "games_config_set") {
        return {
          schemaVersion: 1,
          autoStartWithWallpaper: false,
          resumeOnLaunch: false,
          maxRunning: 2,
          offlineMaxMs: 604_800_000,
        };
      }
      return null;
    });

    render(<GamesPanel />);
    const toggle = await screen.findByRole("switch", {
      name: "随壁纸自动启动",
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("games_config_set", {
        config: {
          schemaVersion: 1,
          autoStartWithWallpaper: false,
          resumeOnLaunch: false,
          maxRunning: 2,
          offlineMaxMs: 604_800_000,
          controllerFollowsGame: true,
        },
      });
    });
  });

  test("后台运行与回到前台调用 game_set_background", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [gameView({ instance: instanceView({ status: "running" }) })];
      }
      if (command === "game_set_background") {
        return instanceView({ status: "background" });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "后台运行" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_set_background", {
        gameId: "community.living-world",
        enabled: true,
      });
    });
  });

  test("运行中点击停止调用 game_stop", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [gameView({ instance: instanceView({ status: "running" }) })];
      }
      if (command === "game_stop") {
        return instanceView({ status: "stopped" });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_stop", {
        gameId: "community.living-world",
      });
    });
  });

  test("读取列表失败时展示本地化错误而不是空白", async () => {
    invoke.mockRejectedValue({ code: "io.error", message: "无法读取游戏目录" });

    render(<GamesPanel />);

    expect(
      await screen.findByText("读取游戏列表失败：无法读取游戏目录"),
    ).toBeTruthy();
    expect(screen.queryByTestId("games-empty")).toBeNull();
  });

  test("操作失败时展示 action failed 文案", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [gameView({ instance: instanceView({ status: "running" }) })];
      }
      if (command === "game_stop") {
        return Promise.reject({ code: "io.error", message: "磁盘不可写" });
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));

    expect(await screen.findByText("操作失败：磁盘不可写")).toBeTruthy();
  });

  test("自带 replica 的游戏可设为壁纸并切换为取消", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            entryReplicaUrl:
              "http://lullgame.localhost/community.living-world/replica/index.html",
          }),
        ];
      }
      if (command === "wallpaper_display_get") {
        return { game: null };
      }
      return null;
    });

    render(<GamesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "设为壁纸" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("wallpaper_set_game", {
        gameId: "community.living-world",
      });
    });
    expect(
      await screen.findByRole("button", { name: "取消游戏壁纸" }),
    ).toBeTruthy();
  });

  test("运行中实例展示控制器开关，打开调用 game_open_controller", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: instanceView({ status: "running" }),
            controllers: [
              {
                id: "panel",
                kind: "package",
                label: "世界控制台",
                entry: "controllers/panel/index.html",
                installed: true,
                enabled: true,
                autoOpen: true,
                windowOpen: false,
                connected: false,
              },
            ],
          }),
        ];
      }
      return null;
    });

    render(<GamesPanel />);
    const toggle = await screen.findByRole("switch", { name: "世界控制台" });
    expect(
      screen.getByTestId("game-controllers-community.living-world"),
    ).toBeTruthy();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_open_controller", {
        gameId: "community.living-world",
        controllerId: "panel",
      });
    });
  });

  test("已打开的控制器再次切换调用 game_close_controller", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: instanceView({ status: "running" }),
            controllers: [
              {
                id: "remote",
                kind: "widget",
                label: "Remote",
                widgetId: "example-ambient-controller",
                installed: true,
                enabled: true,
                autoOpen: true,
                windowOpen: true,
                connected: true,
              },
            ],
          }),
        ];
      }
      return null;
    });

    render(<GamesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Remote" });
    expect((toggle as HTMLButtonElement).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("已连接")).toBeTruthy();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("game_close_controller", {
        gameId: "community.living-world",
        controllerId: "remote",
      });
    });
  });

  test("游戏未运行时控制器开关不出现", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            controllers: [
              {
                id: "panel",
                kind: "package",
                installed: true,
                enabled: true,
                autoOpen: true,
                windowOpen: false,
                connected: false,
              },
            ],
          }),
        ];
      }
      return null;
    });

    render(<GamesPanel />);
    await screen.findByText("Living World");
    expect(
      screen.queryByTestId("game-controllers-community.living-world"),
    ).toBeNull();
  });

  test("控制器不可用时开关置灰", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "games_list") {
        return [
          gameView({
            instance: instanceView({ status: "running" }),
            controllers: [
              {
                id: "ambient",
                kind: "widget",
                label: "Ambient",
                widgetId: "example-ambient-controller",
                installed: false,
                enabled: false,
                autoOpen: true,
                windowOpen: false,
                connected: false,
              },
            ],
          }),
        ];
      }
      return null;
    });

    render(<GamesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Ambient" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});
