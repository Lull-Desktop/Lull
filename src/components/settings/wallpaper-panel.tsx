/**
 * 设置页「壁纸」页签：壁纸层总开关、显示模式、场景参数与每台显示器的独立配置。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Monitor } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { SceneParamFields } from "@/components/scene-params";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSceneCatalog } from "@/hooks/use-scene-catalog";
import { localizeError } from "@/i18n/errors";
import { useLocale } from "@/i18n/locale";
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
};

function sceneSourceLabel(source: SceneCatalogEntry["source"]): string {
  if (source === "builtin") return m.wallpaper_source_builtin();
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
  /** 按场景 id 保存的参数；值统一为字符串，由 Scene SDK 还原类型。 */
  sceneParams?: Record<string, Record<string, string>>;
};

export function WallpaperPanel() {
  const wallpaperSwitchId = useId();
  const syncSwitchId = useId();
  const {
    entries: sceneEntries,
    error: sceneCatalogError,
    issues: sceneCatalogIssues,
  } = useSceneCatalog();
  const [wallpaperVisible, setWallpaperVisible] = useState<boolean | null>(
    null,
  );
  const [monitors, setMonitors] = useState<MonitorView[] | null>(null);
  const [display, setDisplay] = useState<DisplayConfig | null>(null);
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

  const updateMonitorScene = useCallback(
    (device: string, scene: string): void => {
      void runWallpaperCommand("wallpaper_set_monitor_scene", {
        device,
        scene,
      });
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
          refreshWallpaper();
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

  const activeScene = sceneEntries.find(
    (entry) => entry.manifest.id === display?.scene,
  );

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-bamboo" />
          {m.wallpaper_title()}
        </CardTitle>
        <CardDescription>{m.wallpaper_description()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            <ToggleGroupItem value="span">{m.wallpaper_mode_span()}</ToggleGroupItem>
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
                value={display.scene}
                onValueChange={(v) => updateDisplay({ scene: v })}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={m.wallpaper_scene_global()}
                  className="w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sceneEntries.map(({ manifest }) => (
                    <SelectItem key={manifest.id} value={manifest.id}>
                      {manifest.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {activeScene && (
              <p className="text-xs text-muted-foreground">
                {activeScene.manifest.description} · v
                {activeScene.manifest.version} · {activeScene.manifest.license}{" "}
                · {sceneSourceLabel(activeScene.source)}
              </p>
            )}
            {activeScene?.manifest.params &&
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
                    values={display.sceneParams?.[display.scene] ?? {}}
                    onChange={(key, value) =>
                      updateSceneParam(display.scene, key, value)
                    }
                    onReset={() => commitSceneParams(display.scene, {})}
                  />
                </div>
              )}
            {activeScene?.manifest.params &&
              activeScene.manifest.params.length > 0 &&
              !sceneSupportsParams(activeScene.manifest) && (
                <p className="text-xs text-destructive">
                  {m.wallpaper_params_unsupported()}
                </p>
              )}
          </>
        )}
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
                        value={monitor.scene}
                        onValueChange={(v) =>
                          updateMonitorScene(monitor.device, v)
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={m.wallpaper_monitor_scene_aria({
                            index: String(i + 1),
                          })}
                          className="w-28"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {sceneEntries.map(({ manifest }) => (
                            <SelectItem key={manifest.id} value={manifest.id}>
                              {manifest.name}
                            </SelectItem>
                          ))}
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
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {wallpaperError || statusText(wallpaperStatus)}
        </p>
      </CardContent>
    </Card>
  );
}
