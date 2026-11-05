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
});
