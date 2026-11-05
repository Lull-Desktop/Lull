"use client";

/**
 * 游戏列表与实例操作：设置页「游戏」页签与扩展中心共用。
 *
 * `games-changed` 由 Rust 在安装、启停、失败等状态变化后广播；
 * 每次操作成功后再拉一次列表，保证 revision / status 与宿主一致。
 * 浏览器预览下 `games_list` 不可用：退化为空列表 + 一条可读错误，不抛未捕获异常。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  GAMES_CONFIG_DEFAULT,
  type GamesConfig,
  type GameView,
  normalizeGamesConfig,
  toGameErrorBody,
} from "@/lib/games";

export type GamesState = {
  games: GameView[];
  config: GamesConfig;
  loading: boolean;
  /** 已转成可直接展示的字符串；宿主 error body 的 code 不在这里重复。 */
  error: string | null;
  refresh: () => Promise<void>;
  saveConfig: (patch: Partial<GamesConfig>) => Promise<void>;
  start: (gameId: string) => Promise<void>;
  stop: (gameId: string) => Promise<void>;
  flush: (gameId: string) => Promise<void>;
  suspend: (gameId: string) => Promise<void>;
  resume: (gameId: string) => Promise<void>;
  setBackground: (gameId: string, enabled: boolean) => Promise<void>;
  deleteSave: (gameId: string) => Promise<void>;
  setEnabled: (gameId: string, enabled: boolean) => Promise<void>;
};

export function useGames(): GamesState {
  const [games, setGames] = useState<GameView[]>([]);
  const [config, setConfig] = useState<GamesConfig>(GAMES_CONFIG_DEFAULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!aliveRef.current) return;
    setLoading(true);
    try {
      const list = await invoke<GameView[]>("games_list");
      if (!aliveRef.current) return;
      setGames(Array.isArray(list) ? list : []);
      setError(null);
    } catch (reason) {
      if (!aliveRef.current) return;
      setGames([]);
      setError(toGameErrorBody(reason).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  const saveConfig = useCallback(
    async (patch: Partial<GamesConfig>): Promise<void> => {
      try {
        const saved = await invoke<GamesConfig>("games_config_set", {
          config: { ...configRef.current, ...patch },
        });
        if (!aliveRef.current) return;
        setConfig(normalizeGamesConfig(saved));
        setError(null);
      } catch (reason) {
        if (!aliveRef.current) return;
        setError(toGameErrorBody(reason).message);
      }
    },
    [],
  );

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      const loaded = await invoke<GamesConfig>("games_config_get");
      if (!aliveRef.current) return;
      setConfig(normalizeGamesConfig(loaded));
    } catch {
      // 浏览器预览或旧宿主没有该命令：保持默认值。
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const runAction = useCallback(
    async (command: string, gameId: string): Promise<void> => {
      try {
        await invoke(command, { gameId });
        if (!aliveRef.current) return;
        setError(null);
        await refresh();
      } catch (reason) {
        if (!aliveRef.current) return;
        setError(toGameErrorBody(reason).message);
      }
    },
    [refresh],
  );

  const start = useCallback(
    (gameId: string): Promise<void> => runAction("game_start", gameId),
    [runAction],
  );
  const stop = useCallback(
    (gameId: string): Promise<void> => runAction("game_stop", gameId),
    [runAction],
  );
  const flush = useCallback(
    (gameId: string): Promise<void> => runAction("game_flush", gameId),
    [runAction],
  );
  const suspend = useCallback(
    (gameId: string): Promise<void> => runAction("game_suspend", gameId),
    [runAction],
  );
  const resume = useCallback(
    (gameId: string): Promise<void> => runAction("game_resume", gameId),
    [runAction],
  );
  const setBackground = useCallback(
    async (gameId: string, enabled: boolean): Promise<void> => {
      try {
        await invoke("game_set_background", { gameId, enabled });
        if (!aliveRef.current) return;
        setError(null);
        await refresh();
      } catch (reason) {
        if (!aliveRef.current) return;
        setError(toGameErrorBody(reason).message);
      }
    },
    [refresh],
  );
  const deleteSave = useCallback(
    (gameId: string): Promise<void> => runAction("game_save_delete", gameId),
    [runAction],
  );
  // 启停用与能力授权归扩展中心；这里只借用同一个命令给「游戏」页签做启用入口。
  const setEnabled = useCallback(
    async (gameId: string, enabled: boolean): Promise<void> => {
      try {
        await invoke("extensions_set_enabled", {
          id: gameId,
          kind: "game",
          enabled,
        });
        if (!aliveRef.current) return;
        setError(null);
        await refresh();
      } catch (reason) {
        if (!aliveRef.current) return;
        setError(toGameErrorBody(reason).message);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isDesktopWindow()) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void listen("games-changed", () => {
      void refresh();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri 事件系统；手动刷新与操作后刷新仍然可用。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);

  return {
    games,
    config,
    loading,
    error,
    refresh,
    saveConfig,
    start,
    stop,
    flush,
    suspend,
    resume,
    setBackground,
    deleteSave,
    setEnabled,
  };
}
