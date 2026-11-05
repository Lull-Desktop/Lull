/**
 * 壁纸库窗口：壁纸层总开关、显示模式、场景参数与每台显示器的独立配置。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Monitor } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { GameSwitchDialog } from "@/components/library/game-switch-dialog";
import { SceneParamFields } from "@/components/scene-params";
import { MediaPanel } from "@/components/settings/media-panel";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DEFAULT_SCENE_ID } from "@/core/wallpaper/params";
import { useGames } from "@/hooks/use-games";
import { useSceneCatalog } from "@/hooks/use-scene-catalog";
import { localizeError } from "@/i18n/errors";
import { useLocale } from "@/i18n/locale";
import type { GameView } from "@/lib/games";
import { m } from "@/paraglide/messages";
import { type SceneCatalogEntry, sceneSupportsParams } from "@/sdk/scene";

/** 与 Rust 侧 `wallpaper::MonitorView` 对应。 */
type MonitorView = {
  device: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dpi: number;
  primary: boolean;
  enabled: boolean;
  /** 生效场景（每屏覆盖 → 全局回退）。 */
  scene: string;
  /** 生效游戏（independent 下每屏覆盖优先；null = 使用场景）。 */
  game?: string | null;
};

const GAME_PREFIX = "game:";
const SCENE_PREFIX = "scene:";

type ContentChoice = { kind: "game" | "scene"; id: string };

function parseContentValue(value: string): ContentChoice | null {
  if (value.startsWith(GAME_PREFIX)) {
    return { kind: "game", id: value.slice(GAME_PREFIX.length) };
  }
  if (value.startsWith(SCENE_PREFIX)) {
    return { kind: "scene", id: value.slice(SCENE_PREFIX.length) };
  }
  return null;
}

/** 运行中的实例才需要询问“停止还是后台继续”；已停止/失败不打扰用户。 */
function instanceRunning(game: GameView | undefined): boolean {
  const status = game?.instance?.status;
  return status === "running" || status === "hidden" || status === "background";
}

function gameSelectable(game: GameView): boolean {
  return game.enabled && game.status === "ready";
}

function gameOptionLabel(game: GameView, usedElsewhere: boolean): string {
  if (!gameSelectable(game)) {
    return `${game.name}${m.wallpaper_game_disabled_suffix()}`;
  }
  return usedElsewhere
    ? `${game.name}${m.wallpaper_game_used_elsewhere()}`
    : game.name;
}

/** 场景与游戏共用一个下拉：前缀区分 id，避免两类 id 同名时选错。 */
function WallpaperContentOptions({
  scenes,
  games,
  usedGames,
}: {
  scenes: readonly SceneCatalogEntry[];
  games: readonly GameView[];
  usedGames?: ReadonlySet<string>;
}) {
  return (
    <>
      <SelectGroup>
        <SelectLabel>{m.wallpaper_group_scenes()}</SelectLabel>
        {scenes.map(({ manifest }) => (
          <SelectItem
            key={`${SCENE_PREFIX}${manifest.id}`}
            value={`${SCENE_PREFIX}${manifest.id}`}
          >
            {manifest.name}
          </SelectItem>
        ))}
      </SelectGroup>
      {games.length > 0 && (
        <>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>{m.wallpaper_group_games()}</SelectLabel>
            {games.map((game) => {
              const usedElsewhere = usedGames?.has(game.id) ?? false;
              return (
                <SelectItem
                  key={`${GAME_PREFIX}${game.id}`}
                  value={`${GAME_PREFIX}${game.id}`}
                  disabled={!gameSelectable(game) || usedElsewhere}
                >
                  {gameOptionLabel(game, usedElsewhere)}
                </SelectItem>
              );
            })}
          </SelectGroup>
        </>
      )}
    </>
  );
}

function sceneSourceLabel(source: SceneCatalogEntry["source"]): string {
  if (source === "builtin") return m.wallpaper_source_builtin();
  if (source === "official") return m.wallpaper_source_official();
  if (source === "content") return m.wallpaper_source_content();
  return m.wallpaper_source_user();
}

/** 壁纸运行状态。存状态而不是成品文案，语言切换时提示才会跟着变。 */
type WallpaperStatus = "querying" | "visible" | "hidden" | "not-running";

function statusText(status: WallpaperStatus): string {
  switch (status) {
    case "visible":
      return m.wallpaper_status_visible();
    case "hidden":
      return m.wallpaper_status_hidden();
    case "not-running":
      return m.wallpaper_status_not_running();
    default:
      return m.wallpaper_status_querying();
  }
}

/** 与 Rust 侧 `config::DisplayConfig` 对应。 */
type DisplayConfig = {
  mode: "mirror" | "independent" | "span";
  sync: boolean;
  scene: string;
  /** 非空 = 壁纸直接渲染游戏包自带 replica；由「游戏」页签切换。 */
  game?: string | null;
  /** 按场景 id 保存的参数；值统一为字符串，由 Scene SDK 还原类型。 */
  sceneParams?: Record<string, Record<string, string>>;
};

export function WallpaperPanel() {
  const wallpaperSwitchId = useId();
  const syncSwitchId = useId();
  const {
    entries: sceneEntries,
    loading: sceneCatalogLoading,
    error: sceneCatalogError,
    issues: sceneCatalogIssues,
  } = useSceneCatalog();
  const [wallpaperVisible, setWallpaperVisible] = useState<boolean | null>(
    null,
  );
  const [monitors, setMonitors] = useState<MonitorView[] | null>(null);
  const [display, setDisplay] = useState<DisplayConfig | null>(null);
  const { games, loading: gamesLoading, refresh: refreshGames } = useGames();
  const [pendingSwitch, setPendingSwitch] = useState<{
    gameId: string;
    gameName: string;
    apply: () => Promise<void>;
  } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  // 订阅语言：整块面板的文案都跟着界面语言走。
  useLocale();
  const [wallpaperStatus, setWallpaperStatus] =
    useState<WallpaperStatus>("querying");
  const [wallpaperError, setWallpaperError] = useState("");
  // 单台显示器的开关是"重建窗口"级操作，可能耗时几百毫秒；期间锁住开关，
  // 避免用户连点造成 create/destroy 竞态与画面抖动。
  const [pendingDevice, setPendingDevice] = useState<string | null>(null);

  const refreshWallpaper = useCallback((): Promise<void> => {
    return Promise.all([
      invoke<boolean>("wallpaper_get_visible"),
      invoke<MonitorView[]>("wallpaper_monitors"),
      invoke<DisplayConfig>("wallpaper_display_get"),
    ])
      .then(([visible, list, disp]) => {
        setWallpaperVisible(visible);
        setMonitors(list);
        setDisplay(disp);
        setWallpaperError("");
        setWallpaperStatus(visible ? "visible" : "hidden");
      })
      .catch(() => {
        setWallpaperVisible(null);
        setMonitors(null);
        setDisplay(null);
        setWallpaperStatus("not-running");
      });
  }, []);

  const runWallpaperCommand = useCallback(
    (command: string, args?: Record<string, unknown>): Promise<void> => {
      return invoke(command, args)
        .then(() => refreshWallpaper())
        .catch((err: unknown) => {
          setWallpaperError(localizeError(err));
        });
    },
    [refreshWallpaper],
  );

  useEffect(() => {
    void refreshWallpaper();
    // 后端拓扑变化 / 开关后广播：热插拔、改分辨率时清单实时刷新。
    // listen 失败（capability 权限缺失 / 纯浏览器）立即降级为仅手动刷新——catch 必须
    // 紧跟 listen，不能在 unmount 的 cleanup 里才挂（实测会产生 unhandledRejection）。
    const unlisten = listen("wallpaper-changed", () => {
      void refreshWallpaper();
    }).catch(() => () => {});
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [refreshWallpaper]);

  // 按几何排序（上→下、左→右）展示；与 native 枚举序（index/attach 用）无关。
  const sortedMonitors = useMemo(
    () =>
      monitors ? [...monitors].sort((a, b) => a.y - b.y || a.x - b.x) : null,
    [monitors],
  );

  const gameById = useMemo(
    () => new Map(games.map((game) => [game.id, game])),
    [games],
  );
  // 只有带 entry.replica 的包才能直接当壁纸；停用的仍展示但不可选。
  const wallpaperGames = useMemo(
    () => games.filter((game) => Boolean(game.entryReplicaUrl)),
    [games],
  );

  const requestContentSwitch = useCallback(
    (oldGameId: string | null, apply: () => Promise<void>): void => {
      const oldGame = oldGameId ? gameById.get(oldGameId) : undefined;
      if (!oldGameId || !oldGame || !instanceRunning(oldGame)) {
        void apply();
        return;
      }
      setPendingSwitch({ gameId: oldGameId, gameName: oldGame.name, apply });
    },
    [gameById],
  );

  const resolveGameSwitch = useCallback(
    async (choice: "stop" | "background" | "cancel"): Promise<void> => {
      if (!pendingSwitch || switchBusy) return;
      if (choice === "cancel") {
        setPendingSwitch(null);
        return;
      }
      const { gameId, apply } = pendingSwitch;
      setSwitchBusy(true);
      try {
        if (choice === "stop") {
          await invoke("game_stop", { gameId });
        } else {
          await invoke("game_set_background", { gameId, enabled: true });
        }
        setPendingSwitch(null);
        await apply();
        await refreshGames();
      } catch (error: unknown) {
        setPendingSwitch(null);
        setWallpaperError(localizeError(error));
      } finally {
        setSwitchBusy(false);
      }
    },
    [pendingSwitch, refreshGames, switchBusy],
  );

  const selectContent = useCallback(
    (device: string | null, value: string): void => {
      const choice = parseContentValue(value);
      if (!choice || !display) return;
      const monitor = device
        ? sortedMonitors?.find((item) => item.device === device)
        : undefined;
      if (device && !monitor) return;
      const currentGame = device
        ? (monitor?.game ?? null)
        : (display.game ?? null);
      const currentScene = device ? monitor?.scene : display.scene;
      if (choice.kind === "game") {
        if (choice.id === currentGame) return;
        const apply = device
          ? () =>
              runWallpaperCommand("wallpaper_set_monitor_game", {
                device,
                gameId: choice.id,
              })
          : () =>
              runWallpaperCommand("wallpaper_set_game", { gameId: choice.id });
        requestContentSwitch(currentGame, apply);
        return;
      }
      if (!currentGame && choice.id === currentScene) return;
      const apply = device
        ? () =>
            runWallpaperCommand("wallpaper_set_monitor_scene", {
              device,
              scene: choice.id,
            })
        : () =>
            runWallpaperCommand("wallpaper_set_display", { scene: choice.id });
      requestContentSwitch(currentGame, apply);
    },
    [display, requestContentSwitch, runWallpaperCommand, sortedMonitors],
  );

  const toggleWallpaper = useCallback((on: boolean): void => {
    invoke<boolean>("wallpaper_set_visible", { visible: on })
      .then((v) => {
        setWallpaperVisible(v);
        setWallpaperError("");
        setWallpaperStatus(v ? "visible" : "hidden");
      })
      .catch((err: unknown) => {
        setWallpaperError(localizeError(err));
      });
  }, []);

  const toggleMonitor = useCallback(
    (device: string, on: boolean): void => {
      if (pendingDevice) return;
      setPendingDevice(device);
      void runWallpaperCommand("wallpaper_set_monitor_visible", {
        device,
        visible: on,
      }).finally(() => setPendingDevice(null));
    },
    [pendingDevice, runWallpaperCommand],
  );

  const updateDisplay = useCallback(
    (patch: Partial<DisplayConfig>): void => {
      void runWallpaperCommand("wallpaper_set_display", patch);
    },
    [runWallpaperCommand],
  );

  const commitSceneParams = useCallback(
    (scene: string, params: Record<string, string>): void => {
      // 先乐观更新控件，再写盘并热更壁纸窗；失败时用后端值回滚。
      setDisplay((current) =>
        current
          ? {
              ...current,
              sceneParams: {
                ...(current.sceneParams ?? {}),
                [scene]: params,
              },
            }
          : current,
      );
      invoke("wallpaper_set_scene_params", { scene, params })
        .then(() => {
          void refreshWallpaper();
        })
        .catch((err: unknown) => {
          setWallpaperError(localizeError(err));
          void refreshWallpaper();
        });
    },
    [refreshWallpaper],
  );

  const updateSceneParam = useCallback(
    (scene: string, key: string, value: string): void => {
      commitSceneParams(scene, {
        ...(display?.sceneParams?.[scene] ?? {}),
        [key]: value,
      });
    },
    [commitSceneParams, display],
  );

  // 默认场景固定排在下拉第一位：新配置和目录加载完成前都优先展示竹影。
  const sceneOptions = useMemo(() => {
    const list = [...sceneEntries];
    const defaultIndex = list.findIndex(
      (entry) => entry.manifest.id === DEFAULT_SCENE_ID,
    );
    if (defaultIndex > 0) {
      const [preferred] = list.splice(defaultIndex, 1);
      if (preferred) list.unshift(preferred);
    }
    return list;
  }, [sceneEntries]);

  const defaultSceneId = sceneOptions[0]?.manifest.id ?? DEFAULT_SCENE_ID;
  const selectedSceneId =
    display && sceneOptions.some((entry) => entry.manifest.id === display.scene)
      ? display.scene
      : defaultSceneId;

  const currentGlobalGame = display?.game
    ? gameById.get(display.game)
    : undefined;
  const globalContentValue =
    display?.game && currentGlobalGame?.entryReplicaUrl
      ? `${GAME_PREFIX}${display.game}`
      : `${SCENE_PREFIX}${selectedSceneId}`;

  const monitorContentValue = (monitor: MonitorView): string => {
    const game = monitor.game ? gameById.get(monitor.game) : undefined;
    return monitor.game && game?.entryReplicaUrl
      ? `${GAME_PREFIX}${monitor.game}`
      : `${SCENE_PREFIX}${monitor.scene}`;
  };

  // 同一游戏只允许在一台显示器上实际生效；视频/图片等场景不参与互斥。
  const gamesUsedByOtherMonitors = (device: string): ReadonlySet<string> => {
    const used = new Set<string>();
    for (const monitor of sortedMonitors ?? []) {
      if (monitor.device !== device && monitor.game) {
        used.add(monitor.game);
      }
    }
    return used;
  };

  // 旧配置可能指向已删除的场景（lull.aurora / lull.dusk / 旧内容包）。
  // 目录加载完成后回退到默认竹影并写回宿主，保证下一次启动也稳定。
  const normalizedSceneRef = useRef<string | null>(null);
  useEffect(() => {
    if (sceneCatalogLoading || !display || sceneOptions.length === 0) return;
    if (sceneOptions.some((entry) => entry.manifest.id === display.scene)) {
      return;
    }
    // 官方竹影暂时缺失（未构建 / 被隔离）时保留原配置，等扩展恢复后自动重新出现。
    if (display.scene === DEFAULT_SCENE_ID) return;
    if (normalizedSceneRef.current === display.scene) return;
    normalizedSceneRef.current = display.scene;
    updateDisplay({ scene: defaultSceneId });
  }, [
    sceneCatalogLoading,
    display,
    sceneOptions,
    defaultSceneId,
    updateDisplay,
  ]);

  const activeScene = sceneOptions.find(
    (entry) => entry.manifest.id === selectedSceneId,
  );
  // 视频面板只在场景真的顶上时出现：游戏壁纸优先，逐屏游戏屏也不算视频场景。
  const showMediaPanel =
    display?.mode === "independent"
      ? (sortedMonitors?.some(
          (monitor) => !monitor.game && monitor.scene === "lull.video",
        ) ?? false)
      : !display?.game && activeScene?.manifest.id === "lull.video";

  return (
    <Card className="flex max-h-full min-h-0 w-full flex-col">
      <CardHeader className="shrink-0">
        <CardTitle className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-bamboo" />
          {m.wallpaper_title()}
        </CardTitle>
        <CardDescription>{m.wallpaper_description()}</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Label htmlFor={wallpaperSwitchId} className="text-ink-soft">
            {m.wallpaper_show()}
          </Label>
          <Switch
            id={wallpaperSwitchId}
            checked={wallpaperVisible === true}
            disabled={wallpaperVisible === null}
            onCheckedChange={toggleWallpaper}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-ink-soft">{m.wallpaper_mode_label()}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={display?.mode}
            onValueChange={(v) =>
              v && updateDisplay({ mode: v as DisplayConfig["mode"] })
            }
          >
            <ToggleGroupItem value="mirror">
              {m.wallpaper_mode_mirror()}
            </ToggleGroupItem>
            <ToggleGroupItem value="independent">
              {m.wallpaper_mode_independent()}
            </ToggleGroupItem>
            <ToggleGroupItem value="span">
              {m.wallpaper_mode_span()}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label htmlFor={syncSwitchId} className="text-ink-soft">
              {m.wallpaper_sync()}
            </Label>
            {display?.mode === "span" && (
              <span className="text-xs text-muted-foreground">
                {m.wallpaper_sync_span_hint()}
              </span>
            )}
            {display?.mode === "independent" && (
              <span className="text-xs text-muted-foreground">
                {m.wallpaper_sync_independent_hint()}
              </span>
            )}
          </div>
          <Switch
            id={syncSwitchId}
            checked={display?.mode === "span" ? true : display?.sync === true}
            disabled={display === null || display.mode !== "mirror"}
            onCheckedChange={(on) => updateDisplay({ sync: on })}
          />
        </div>
        {display && (display.mode === "mirror" || display.mode === "span") && (
          <>
            <div className="flex items-center justify-between">
              <Label className="text-ink-soft">
                {m.wallpaper_scene_global()}
              </Label>
              <Select
                value={globalContentValue}
                onValueChange={(v) => selectContent(null, v)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={m.wallpaper_scene_global()}
                  className="w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <WallpaperContentOptions
                    scenes={sceneOptions}
                    games={wallpaperGames}
                  />
                </SelectContent>
              </Select>
            </div>
            {!gamesLoading &&
              display.game &&
              !currentGlobalGame?.entryReplicaUrl && (
                <p className="text-xs text-destructive">
                  {m.wallpaper_game_unavailable()}
                </p>
              )}
            {!display.game && activeScene && (
              <p className="text-xs text-muted-foreground">
                {activeScene.manifest.description} · v
                {activeScene.manifest.version} · {activeScene.manifest.license}{" "}
                · {sceneSourceLabel(activeScene.source)}
              </p>
            )}
            {!display.game &&
              activeScene?.manifest.params &&
              activeScene.manifest.params.length > 0 &&
              sceneSupportsParams(activeScene.manifest) && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {m.wallpaper_params_hint({
                      target:
                        activeScene.source === "builtin"
                          ? m.wallpaper_params_target_builtin()
                          : m.wallpaper_params_target_bridge(),
                    })}
                  </p>
                  <SceneParamFields
                    definitions={activeScene.manifest.params}
                    values={display.sceneParams?.[selectedSceneId] ?? {}}
                    onChange={(key, value) =>
                      updateSceneParam(selectedSceneId, key, value)
                    }
                    onReset={() => commitSceneParams(selectedSceneId, {})}
                  />
                </div>
              )}
            {!display.game &&
              activeScene?.manifest.params &&
              activeScene.manifest.params.length > 0 &&
              !sceneSupportsParams(activeScene.manifest) && (
                <p className="text-xs text-destructive">
                  {m.wallpaper_params_unsupported()}
                </p>
              )}
          </>
        )}
        {showMediaPanel ? <MediaPanel /> : null}
        {sceneCatalogError && (
          <p className="text-xs text-muted-foreground">
            {m.wallpaper_catalog_error({ reason: sceneCatalogError })}
          </p>
        )}
        {sceneCatalogIssues.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {sceneCatalogIssues.slice(0, 5).map((issue) => (
              <li key={issue}>· {issue}</li>
            ))}
            {sceneCatalogIssues.length > 5 && (
              <li>
                ·{" "}
                {m.wallpaper_catalog_more_issues({
                  count: String(sceneCatalogIssues.length - 5),
                })}
              </li>
            )}
          </ul>
        )}
        {sortedMonitors && sortedMonitors.length > 0 && (
          <div className="space-y-3 border-t border-border/50 pt-4">
            {sortedMonitors.map((monitor, i) => {
              const monitorScene = sceneEntries.find(
                (entry) => entry.manifest.id === monitor.scene,
              );
              return (
                <div key={monitor.device} className="space-y-2">
                  <div
                    className="flex items-center justify-between"
                    title={monitor.device}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ink-soft">
                        {m.wallpaper_monitor_label({ index: String(i + 1) })}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">
                        {monitor.w}×{monitor.h}
                      </span>
                      {monitor.primary && (
                        <Badge
                          variant="outline"
                          className="border-bamboo/40 px-1.5 py-0 text-[10px] text-bamboo"
                        >
                          {m.wallpaper_monitor_primary()}
                        </Badge>
                      )}
                    </div>
                    {display?.mode === "independent" && (
                      <Select
                        value={monitorContentValue(monitor)}
                        onValueChange={(v) => selectContent(monitor.device, v)}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={m.wallpaper_monitor_scene_aria({
                            index: String(i + 1),
                          })}
                          className="w-40"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <WallpaperContentOptions
                            scenes={sceneOptions}
                            games={wallpaperGames}
                            usedGames={gamesUsedByOtherMonitors(monitor.device)}
                          />
                        </SelectContent>
                      </Select>
                    )}
                    <Switch
                      aria-label={m.wallpaper_monitor_label({
                        index: String(i + 1),
                      })}
                      checked={monitor.enabled}
                      disabled={wallpaperVisible !== true}
                      onCheckedChange={(on) =>
                        toggleMonitor(monitor.device, on)
                      }
                    />
                  </div>
                  {display?.mode === "independent" &&
                    !gamesLoading &&
                    monitor.game &&
                    !gameById.get(monitor.game)?.entryReplicaUrl && (
                      <p className="text-xs text-destructive">
                        {m.wallpaper_game_unavailable()}
                      </p>
                    )}
                  {display?.mode === "independent" &&
                    !monitor.game &&
                    monitorScene?.manifest.params &&
                    monitorScene.manifest.params.length > 0 &&
                    sceneSupportsParams(monitorScene.manifest) && (
                      <SceneParamFields
                        definitions={monitorScene.manifest.params}
                        values={display?.sceneParams?.[monitor.scene] ?? {}}
                        onChange={(key, value) =>
                          updateSceneParam(monitor.scene, key, value)
                        }
                        onReset={() => commitSceneParams(monitor.scene, {})}
                      />
                    )}
                </div>
              );
            })}
            {display?.mode === "independent" && sortedMonitors.length > 1 && (
              <p className="text-xs text-muted-foreground">
                {m.wallpaper_games_exclusive_hint()}
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {wallpaperError || statusText(wallpaperStatus)}
        </p>
      </CardContent>
      <GameSwitchDialog
        gameName={pendingSwitch?.gameName ?? null}
        busy={switchBusy}
        onChoose={(choice) => {
          void resolveGameSwitch(choice);
        }}
      />
    </Card>
  );
}
