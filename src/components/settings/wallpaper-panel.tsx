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
  const [wallpaperMsg, setWallpaperMsg] = useState("查询中…");

  const refreshWallpaper = useCallback((): void => {
    Promise.all([
      invoke<boolean>("wallpaper_get_visible"),
      invoke<MonitorView[]>("wallpaper_monitors"),
      invoke<DisplayConfig>("wallpaper_display_get"),
    ])
      .then(([visible, list, disp]) => {
        setWallpaperVisible(visible);
        setMonitors(list);
        setDisplay(disp);
        setWallpaperMsg(
          visible ? "当前：壁纸可见" : "当前：壁纸已隐藏（总开关）",
        );
      })
      .catch(() => {
        setWallpaperVisible(null);
        setMonitors(null);
        setDisplay(null);
        setWallpaperMsg(
          "壁纸窗口未运行（dev 下用 pnpm test-mode 或 LULL_WALLPAPER=1 启动）",
        );
      });
  }, []);

  const runWallpaperCommand = useCallback(
    (command: string, args?: Record<string, unknown>): void => {
      invoke(command, args)
        .then(() => {
          refreshWallpaper();
        })
        .catch((err: unknown) => {
          setWallpaperMsg(String(err));
        });
    },
    [refreshWallpaper],
  );

  useEffect(() => {
    refreshWallpaper();
    // 后端拓扑变化 / 开关后广播：热插拔、改分辨率时清单实时刷新。
    // listen 失败（capability 权限缺失 / 纯浏览器）立即降级为仅手动刷新——catch 必须
    // 紧跟 listen，不能在 unmount 的 cleanup 里才挂（实测会产生 unhandledRejection）。
    const unlisten = listen("wallpaper-changed", () => {
      refreshWallpaper();
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
        setWallpaperMsg(v ? "当前：壁纸可见" : "当前：壁纸已隐藏（总开关）");
      })
      .catch((err: unknown) => {
        setWallpaperMsg(String(err));
      });
  }, []);

  const toggleMonitor = useCallback(
    (device: string, on: boolean): void => {
      runWallpaperCommand("wallpaper_set_monitor_visible", {
        device,
        visible: on,
      });
    },
    [runWallpaperCommand],
  );

  const updateDisplay = useCallback(
    (patch: Partial<DisplayConfig>): void => {
      runWallpaperCommand("wallpaper_set_display", patch);
    },
    [runWallpaperCommand],
  );

  const updateMonitorScene = useCallback(
    (device: string, scene: string): void => {
      runWallpaperCommand("wallpaper_set_monitor_scene", { device, scene });
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
          refreshWallpaper();
        })
        .catch((err: unknown) => {
          setWallpaperMsg(String(err));
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
          壁纸层
        </CardTitle>
        <CardDescription>
          每台显示器一个壁纸窗口。关闭某屏即销毁该窗口（省内存），重新开启时重建；
          总开关为临时显隐（窗口保持挂载）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor={wallpaperSwitchId} className="text-ink-soft">
            显示壁纸
          </Label>
          <Switch
            id={wallpaperSwitchId}
            checked={wallpaperVisible === true}
            disabled={wallpaperVisible === null}
            onCheckedChange={toggleWallpaper}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-ink-soft">显示模式</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={display?.mode}
            onValueChange={(v) =>
              v && updateDisplay({ mode: v as DisplayConfig["mode"] })
            }
          >
            <ToggleGroupItem value="mirror">复制</ToggleGroupItem>
            <ToggleGroupItem value="independent">独立</ToggleGroupItem>
            <ToggleGroupItem value="span">跨屏</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label htmlFor={syncSwitchId} className="text-ink-soft">
              动画同步
            </Label>
            {display?.mode === "span" && (
              <span className="text-xs text-muted-foreground">
                跨屏强制同步（防接缝撕裂）
              </span>
            )}
            {display?.mode === "independent" && (
              <span className="text-xs text-muted-foreground">
                独立模式各自播放
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
              <Label className="text-ink-soft">全局场景</Label>
              <Select
                value={display.scene}
                onValueChange={(v) => updateDisplay({ scene: v })}
              >
                <SelectTrigger size="sm" aria-label="全局场景" className="w-32">
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
                · {activeScene.source === "content" ? "内容包" : "内置"}
              </p>
            )}
            {activeScene?.manifest.params && (
              <SceneParamFields
                definitions={activeScene.manifest.params}
                values={display.sceneParams?.[display.scene] ?? {}}
                onChange={(key, value) =>
                  updateSceneParam(display.scene, key, value)
                }
                onReset={() => commitSceneParams(display.scene, {})}
              />
            )}
          </>
        )}
        {sceneCatalogError && (
          <p className="text-xs text-muted-foreground">
            外部内容目录未加载：{sceneCatalogError}
          </p>
        )}
        {sceneCatalogIssues.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {sceneCatalogIssues.slice(0, 5).map((issue) => (
              <li key={issue}>· {issue}</li>
            ))}
            {sceneCatalogIssues.length > 5 && (
              <li>· 另有 {sceneCatalogIssues.length - 5} 条内容包提示</li>
            )}
          </ul>
        )}
        {sortedMonitors && sortedMonitors.length > 0 && (
          <div className="space-y-3 border-t border-border/50 pt-4">
            {sortedMonitors.map((m, i) => {
              const monitorScene = sceneEntries.find(
                (entry) => entry.manifest.id === m.scene,
              );
              return (
                <div key={m.device} className="space-y-2">
                  <div
                    className="flex items-center justify-between"
                    title={m.device}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ink-soft">
                        显示器 {i + 1}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">
                        {m.w}×{m.h}
                      </span>
                      {m.primary && (
                        <Badge
                          variant="outline"
                          className="border-bamboo/40 px-1.5 py-0 text-[10px] text-bamboo"
                        >
                          主屏
                        </Badge>
                      )}
                    </div>
                    {display?.mode === "independent" && (
                      <Select
                        value={m.scene}
                        onValueChange={(v) => updateMonitorScene(m.device, v)}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={`显示器 ${i + 1} 场景`}
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
                      aria-label={`显示器 ${i + 1}`}
                      checked={m.enabled}
                      disabled={wallpaperVisible !== true}
                      onCheckedChange={(on) => toggleMonitor(m.device, on)}
                    />
                  </div>
                  {display?.mode === "independent" &&
                    monitorScene?.manifest.params && (
                      <SceneParamFields
                        definitions={monitorScene.manifest.params}
                        values={display?.sceneParams?.[m.scene] ?? {}}
                        onChange={(key, value) =>
                          updateSceneParam(m.scene, key, value)
                        }
                        onReset={() => commitSceneParams(m.scene, {})}
                      />
                    )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{wallpaperMsg}</p>
      </CardContent>
    </Card>
  );
}
