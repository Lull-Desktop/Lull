"use client";

/**
 * 设置页「游戏」页签：列出已安装游戏、实例状态与能力授权，并提供启动 / 停止 /
 * 立即保存 / 删除存档。安装、启停用与能力授权仍归扩展中心，这里只在空态与
 * 说明里指路。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Copy,
  Gamepad2,
  Monitor,
  Moon,
  Pause,
  Play,
  Power,
  Save,
  Square,
  Sun,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { useGames } from "@/hooks/use-games";
import { useLocale } from "@/i18n/locale";
import type { GameStatus, GameView } from "@/lib/games";
import { toGameErrorBody } from "@/lib/games";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

/** 仍占用运行名额的状态；与 Rust `InstanceStatus::is_active` 保持一致。 */
const ACTIVE_STATUSES: readonly GameStatus[] = [
  "starting",
  "ready",
  "running",
  "hidden",
  "suspended",
  "background",
  "stopping",
];

/** 控制器开关只在这些"运行中"状态出现；与 Rust `InstanceStatus::accepts_controller` 一致。 */
const CONTROLLER_STATUSES: readonly GameStatus[] = [
  "running",
  "hidden",
  "suspended",
  "background",
];

function statusLabel(status: GameStatus | null): string {
  switch (status) {
    case "starting":
      return m.games_status_starting();
    case "ready":
      return m.games_status_ready();
    case "running":
      return m.games_status_running();
    case "hidden":
      return m.games_status_hidden();
    case "suspended":
      return m.games_status_suspended();
    case "background":
      return m.games_status_background();
    case "stopping":
      return m.games_status_stopping();
    case "stopped":
      return m.games_status_stopped();
    case "failed":
      return m.games_status_failed();
    case "interrupted":
      return m.games_status_interrupted();
    default:
      return m.games_status_idle();
  }
}

function statusVariant(
  status: GameStatus | null,
): "secondary" | "outline" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "running" || status === "ready" || status === "background") {
    return "secondary";
  }
  return "outline";
}

function statusClass(status: GameStatus | null): string {
  if (status === "running" || status === "background") {
    return "border-bamboo/50 bg-bamboo-mist text-bamboo";
  }
  if (status === "ready") {
    return "border-bamboo/40 text-bamboo";
  }
  if (status === "suspended" || status === "interrupted") {
    return "border-dashed border-border/70 text-muted-foreground";
  }
  return "";
}

function packageStatusLabel(status: GameView["status"]): string | null {
  if (status === "invalid") return m.games_package_invalid();
  if (status === "disabled") return m.games_package_disabled();
  return null;
}

/** 毫秒 → 本地化可读时长；最多保留三档，避免长运行时间挤爆一行。 */
function formatSimulationTime(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: Array<{
    value: number;
    unit: "day" | "hour" | "minute" | "second";
  }> = [];
  if (days > 0) parts.push({ value: days, unit: "day" });
  if (hours > 0) parts.push({ value: hours, unit: "hour" });
  if (minutes > 0) parts.push({ value: minutes, unit: "minute" });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: "second" });
  }
  return parts
    .slice(0, 3)
    .map(({ value, unit }) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
      }).format(value),
    )
    .join(" ");
}

function GameCard({
  game,
  locale,
  pending,
  onStart,
  onStop,
  onFlush,
  onDelete,
  onEnable,
  onSuspend,
  onResume,
  onBackground,
  onForeground,
  controllerPendingKey,
  onToggleController,
  wallpaperActive,
  onSetWallpaper,
}: {
  game: GameView;
  locale: string;
  pending: boolean;
  onStart: () => void;
  onStop: () => void;
  onFlush: () => void;
  onDelete: () => void;
  onEnable: () => void;
  onSuspend: () => void;
  onResume: () => void;
  onBackground: () => void;
  onForeground: () => void;
  controllerPendingKey: string | null;
  onToggleController: (controllerId: string, open: boolean) => void;
  wallpaperActive: boolean;
  onSetWallpaper: () => void;
}) {
  const instance = game.instance ?? null;
  const status = instance?.status ?? null;
  const active = status !== null && ACTIVE_STATUSES.includes(status);
  const canSave =
    status === "ready" ||
    status === "running" ||
    status === "hidden" ||
    status === "background";
  const canDelete = status === "stopped" || status === "interrupted";
  const packageIssue = packageStatusLabel(game.status);
  const startBlockedReason = !game.enabled
    ? m.games_package_disabled()
    : game.status !== "ready"
      ? (packageIssue ?? game.error ?? undefined)
      : undefined;
  const summary = [game.description, game.author, game.license]
    .filter(Boolean)
    .join(" · ");
  const granted = new Set(game.granted ?? []);
  const capabilities = [
    ...new Set([...(game.capabilities ?? []), ...(game.granted ?? [])]),
  ];

  return (
    <article
      className="space-y-3 rounded-xl border border-border/60 p-3.5"
      data-testid={`game-card-${game.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-ink">
              {game.name}
            </h3>
            <Badge
              variant={statusVariant(status)}
              className={cn("px-1.5 py-0 text-[10px]", statusClass(status))}
            >
              {statusLabel(status)}
            </Badge>
            {packageIssue && (
              <Badge
                variant="outline"
                className="border-destructive/50 px-1.5 py-0 text-[10px] text-destructive"
              >
                {packageIssue}
              </Badge>
            )}
            {wallpaperActive && (
              <Badge
                variant="secondary"
                className="border-bamboo/40 bg-bamboo-mist/60 px-1.5 py-0 text-[10px] text-bamboo"
              >
                {m.games_wallpaper_active()}
              </Badge>
            )}
            <span className="font-mono text-[10px] text-ink-faint">
              v{game.version}
            </span>
          </div>
          {summary && (
            <p className="text-xs text-muted-foreground">{summary}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!game.enabled && !active && (
            <Button
              type="button"
              size="sm"
              variant="bamboo"
              className="h-7 px-2.5 text-xs"
              disabled={pending || game.status === "invalid"}
              title={packageIssue ?? game.error ?? undefined}
              onClick={onEnable}
            >
              <Power className="h-3.5 w-3.5" />
              {m.games_enable()}
            </Button>
          )}
          {!active && game.enabled && (
            <Button
              type="button"
              size="sm"
              variant="bamboo"
              className="h-7 px-2.5 text-xs"
              disabled={pending || game.status !== "ready"}
              title={startBlockedReason}
              onClick={onStart}
            >
              <Play className="h-3.5 w-3.5" />
              {m.games_start()}
            </Button>
          )}
          {game.entryReplicaUrl && !wallpaperActive && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending || game.status !== "ready"}
              title={m.games_wallpaper_hint()}
              onClick={onSetWallpaper}
            >
              <Monitor className="h-3.5 w-3.5" />
              {m.games_set_wallpaper()}
            </Button>
          )}
          {wallpaperActive && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onSetWallpaper}
            >
              <Monitor className="h-3.5 w-3.5" />
              {m.games_clear_wallpaper()}
            </Button>
          )}
          {active && status !== "stopping" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onStop}
            >
              <Square className="h-3.5 w-3.5" />
              {m.games_stop()}
            </Button>
          )}
          {(status === "running" || status === "background") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onSuspend}
            >
              <Pause className="h-3.5 w-3.5" />
              {m.games_suspend()}
            </Button>
          )}
          {(status === "running" || status === "hidden") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onBackground}
            >
              <Moon className="h-3.5 w-3.5" />
              {m.games_background()}
            </Button>
          )}
          {status === "background" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onForeground}
            >
              <Sun className="h-3.5 w-3.5" />
              {m.games_foreground()}
            </Button>
          )}
          {status === "suspended" && (
            <Button
              type="button"
              size="sm"
              variant="bamboo"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onResume}
            >
              <Play className="h-3.5 w-3.5" />
              {m.games_resume()}
            </Button>
          )}
          {canSave && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={pending}
              onClick={onFlush}
            >
              <Save className="h-3.5 w-3.5" />
              {m.games_save_now()}
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={pending}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {m.games_delete_save()}
            </Button>
          )}
        </div>
      </div>

      {instance &&
        status !== null &&
        CONTROLLER_STATUSES.includes(status) &&
        (game.controllers ?? []).length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2.5 py-2 text-[11px]"
            data-testid={`game-controllers-${game.id}`}
          >
            <span className="text-muted-foreground">
              {m.games_controller()}
            </span>
            {(game.controllers ?? []).map((controller) => {
              const key = `${game.id}:${controller.id}`;
              const unavailable = !controller.installed || !controller.enabled;
              const busy = controllerPendingKey === key;
              return (
                <span
                  key={controller.id}
                  className="flex items-center gap-1.5"
                  data-testid={`game-controller-${game.id}-${controller.id}`}
                >
                  <Switch
                    size="sm"
                    checked={controller.windowOpen}
                    disabled={unavailable || busy}
                    aria-label={controller.label ?? controller.id}
                    title={
                      unavailable
                        ? controller.installed
                          ? m.games_controller_disabled()
                          : m.games_controller_missing()
                        : undefined
                    }
                    onCheckedChange={(checked) =>
                      onToggleController(controller.id, checked)
                    }
                  />
                  <span className="max-w-40 truncate text-ink-soft">
                    {controller.label ?? controller.id}
                  </span>
                  <Badge
                    variant="outline"
                    className="px-1 py-0 text-[10px] text-muted-foreground"
                  >
                    {controller.kind === "package"
                      ? m.games_controller_kind_package()
                      : m.games_controller_kind_widget()}
                  </Badge>
                  {controller.connected && (
                    <span className="text-bamboo">
                      {m.games_controller_connected()}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}

      {instance && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            {m.games_revision({ revision: String(instance.revision) })}
          </span>
          <span>
            {m.games_simulation({
              duration: formatSimulationTime(instance.simulationTimeMs, locale),
            })}
          </span>
          <span>{m.games_replicas({ count: String(instance.replicas) })}</span>
          {instance.controllers > 0 && (
            <span>
              {m.games_controllers({ count: String(instance.controllers) })}
            </span>
          )}
        </div>
      )}

      {game.error && <p className="text-xs text-destructive">{game.error}</p>}
      {instance?.lastError && (
        <p className="text-xs text-destructive" data-testid="games-last-error">
          {m.games_last_error({
            code: instance.lastError.code,
            message: instance.lastError.message,
          })}
        </p>
      )}

      {capabilities.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            {m.games_capabilities()}
          </p>
          <ul className="flex flex-wrap gap-1">
            {capabilities.map((capability) => (
              <li key={capability}>
                <span
                  className={cn(
                    "inline-block rounded border px-1.5 py-0.5 font-mono text-[10px]",
                    granted.has(capability)
                      ? "border-bamboo/40 bg-bamboo-mist/60 text-bamboo"
                      : "border-dashed border-border/70 text-muted-foreground",
                  )}
                >
                  {capability}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export function GamesPanel() {
  const locale = useLocale();
  const {
    games,
    config,
    loading,
    error,
    refresh,
    start,
    stop,
    flush,
    suspend,
    resume,
    setBackground,
    deleteSave,
    setEnabled,
    saveConfig,
  } = useGames();
  const { confirm, dialog } = useConfirmDialog();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [wallpaperGame, setWallpaperGame] = useState<string | null>(null);
  const [wallpaperPendingId, setWallpaperPendingId] = useState<string | null>(
    null,
  );
  const [wallpaperError, setWallpaperError] = useState("");
  const [controllerError, setControllerError] = useState("");
  const [controllerPendingKey, setControllerPendingKey] = useState<
    string | null
  >(null);

  const toggleController = async (
    gameId: string,
    controllerId: string,
    open: boolean,
  ): Promise<void> => {
    const key = `${gameId}:${controllerId}`;
    setControllerPendingKey(key);
    try {
      await invoke(open ? "game_open_controller" : "game_close_controller", {
        gameId,
        controllerId,
      });
      setControllerError("");
      await refresh();
    } catch (reason) {
      setControllerError(toGameErrorBody(reason).message);
    } finally {
      setControllerPendingKey(null);
    }
  };

  const refreshWallpaper = useCallback((): void => {
    invoke<{ game?: string | null }>("wallpaper_display_get")
      .then((display) => {
        setWallpaperGame(display.game ?? null);
        setWallpaperError("");
      })
      .catch(() => {
        // 浏览器预览 / 壁纸子系统未启动：保留最后一次已知状态。
      });
  }, []);

  useEffect(() => {
    void refreshWallpaper();
    const unlisten = listen("wallpaper-changed", () =>
      refreshWallpaper(),
    ).catch(() => () => {});
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [refreshWallpaper]);

  const setWallpaper = async (gameId: string | null): Promise<void> => {
    setWallpaperPendingId(gameId ?? wallpaperGame);
    try {
      await invoke("wallpaper_set_game", { gameId });
      setWallpaperGame(gameId);
      setWallpaperError("");
    } catch (reason) {
      setWallpaperError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setWallpaperPendingId(null);
    }
  };

  const copyDiagnostics = async (): Promise<void> => {
    try {
      const data = await invoke("game_runtime_diagnostics");
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setDiagnostics("copied");
    } catch {
      setDiagnostics("failed");
    }
    window.setTimeout(() => setDiagnostics("idle"), 2_500);
  };

  const run = async (
    gameId: string,
    action: (id: string) => Promise<void>,
  ): Promise<void> => {
    setPendingId(gameId);
    try {
      await action(gameId);
    } finally {
      setPendingId(null);
    }
  };

  const requestDelete = async (game: GameView): Promise<void> => {
    const confirmed = await confirm({
      title: m.games_delete_save(),
      description: m.games_delete_confirm({ name: game.name }),
      confirmLabel: m.games_delete_confirm_action(),
      danger: true,
    });
    if (!confirmed) return;
    await run(game.id, deleteSave);
  };

  return (
    <>
      <Card
        className="flex h-full max-h-full min-h-0 w-full flex-col"
        data-testid="settings-games-card"
      >
        <CardHeader className="shrink-0 p-5 pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gamepad2 className="h-4 w-4 text-bamboo" />
              {m.games_title()}
            </CardTitle>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-[11px]"
              onClick={() => void copyDiagnostics()}
            >
              <Copy className="h-3.5 w-3.5" />
              {diagnostics === "copied"
                ? m.games_diagnostics_copied()
                : diagnostics === "failed"
                  ? m.games_diagnostics_failed()
                  : m.games_copy_diagnostics()}
            </Button>
          </div>
          <CardDescription>{m.games_description()}</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-5 pt-0">
          <div
            className="space-y-2 rounded-lg border border-border/70 bg-card/40 p-3"
            data-testid="games-config"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.games_auto_start()}</p>
                <p className="text-[11px] text-muted-foreground">
                  {m.games_auto_start_hint()}
                </p>
              </div>
              <Switch
                size="sm"
                checked={config.autoStartWithWallpaper}
                aria-label={m.games_auto_start()}
                onCheckedChange={(checked) => {
                  void saveConfig({ autoStartWithWallpaper: checked });
                }}
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {m.games_resume_on_launch()}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {m.games_resume_on_launch_hint()}
                </p>
              </div>
              <Switch
                size="sm"
                checked={config.resumeOnLaunch}
                aria-label={m.games_resume_on_launch()}
                onCheckedChange={(checked) => {
                  void saveConfig({ resumeOnLaunch: checked });
                }}
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {m.games_controller_follows()}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {m.games_controller_follows_hint()}
                </p>
              </div>
              <Switch
                size="sm"
                checked={config.controllerFollowsGame}
                aria-label={m.games_controller_follows()}
                onCheckedChange={(checked) => {
                  void saveConfig({ controllerFollowsGame: checked });
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-ink-soft">
                {m.games_max_running()}
              </span>
              <select
                className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                aria-label={m.games_max_running()}
                value={config.maxRunning}
                onChange={(event) => {
                  void saveConfig({ maxRunning: Number(event.target.value) });
                }}
              >
                {[1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading && games.length === 0 && (
            <p className="text-xs text-muted-foreground">{m.games_loading()}</p>
          )}

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {games.length === 0
                ? m.games_load_failed({ reason: error })
                : m.games_action_failed({ reason: error })}
            </p>
          )}

          {wallpaperError && (
            <p className="text-xs text-destructive" role="alert">
              {m.games_wallpaper_failed({ reason: wallpaperError })}
            </p>
          )}

          {controllerError && (
            <p className="text-xs text-destructive" role="alert">
              {m.games_controller_open_failed({ reason: controllerError })}
            </p>
          )}

          {!loading && games.length === 0 && !error && (
            <div
              className="rounded-lg border border-dashed border-border/70 p-5 text-center"
              data-testid="games-empty"
            >
              <p className="text-sm text-ink-soft">{m.games_empty()}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {m.games_empty_hint()}
              </p>
            </div>
          )}

          {games.map((game) => {
            const pending = pendingId === game.id;
            const wallpaperActive = wallpaperGame === game.id;
            return (
              <GameCard
                key={game.id}
                game={game}
                locale={locale}
                pending={pending || wallpaperPendingId === game.id}
                wallpaperActive={wallpaperActive}
                onSetWallpaper={() =>
                  void setWallpaper(wallpaperActive ? null : game.id)
                }
                onStart={() => void run(game.id, start)}
                onStop={() => void run(game.id, stop)}
                onFlush={() => void run(game.id, flush)}
                onDelete={() => void requestDelete(game)}
                onEnable={() => void run(game.id, (id) => setEnabled(id, true))}
                onSuspend={() => void run(game.id, suspend)}
                onResume={() => void run(game.id, resume)}
                onBackground={() =>
                  void run(game.id, (id) => setBackground(id, true))
                }
                onForeground={() =>
                  void run(game.id, (id) => setBackground(id, false))
                }
                controllerPendingKey={controllerPendingKey}
                onToggleController={(controllerId, open) =>
                  void toggleController(game.id, controllerId, open)
                }
              />
            );
          })}
        </CardContent>
      </Card>
      {dialog}
    </>
  );
}
