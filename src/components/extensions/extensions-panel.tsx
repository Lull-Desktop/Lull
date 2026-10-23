"use client";

/**
 * 设置页的扩展中心：统一列出壁纸内容与工具扩展，提供导入、启用、打开与卸载。
 *
 * 安装与授权分离：安装只落盘，启用才授予能力；打开才创建窗口。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  Package,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { isDesktopWindow } from "@/core/window/controls";
import { useExtensions } from "@/hooks/use-extensions";
import {
  closeExtension,
  type ExtensionInfo,
  type ExtensionKind,
  getDevState,
  inspectExtension,
  installExtension,
  openExtension,
  openExtensionsDir,
  type PickedExtension,
  pickDevPackage,
  pickExtension,
  reloadDevPackage,
  removeDevPackage,
  removeExtension,
  setDevMode as setDeveloperMode,
  setExtensionCapability,
  setExtensionEnabled,
  stopExtension,
  toExtensionFailure,
} from "@/lib/extensions";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";
import { ExtensionDetailSheet } from "./extension-detail-sheet";
import {
  capabilityLabel,
  capabilityLevel,
  formatBytes,
  kindLabel,
  statusLabel,
} from "./labels";

const REMOVE_CONFIRM_MS = 5000;

/** 卸载按钮的两段式文案：第一次点「卸载」，5 秒内再点变成「确认卸载」。 */
function removeLabel(item: ExtensionInfo, pending: boolean): string {
  if (pending) {
    return item.dev ? m.ext_confirm_remove() : m.ext_confirm_uninstall();
  }
  return item.dev ? m.ext_action_remove() : m.ext_action_uninstall();
}

type Filter = "all" | ExtensionKind;

function statusVariant(
  item: ExtensionInfo,
): "secondary" | "outline" | "destructive" {
  if (item.status === "tampered" || item.status === "invalid") {
    return "destructive";
  }
  if (item.status === "unverified" || item.status === "needs-review") {
    return "outline";
  }
  return "secondary";
}

function canEnable(item: ExtensionInfo): boolean {
  return (
    item.status !== "invalid" &&
    item.status !== "tampered" &&
    item.status !== "needs-review"
  );
}

function itemKey(item: ExtensionInfo): string {
  return `${item.kind}:${item.id}`;
}

type Props = {
  onOpenWallpaperSettings: () => void;
};

export function ExtensionsPanel({ onOpenWallpaperSettings }: Props) {
  const { items, issues, refresh } = useExtensions();
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<PickedExtension | null>(null);
  const [enableTarget, setEnableTarget] = useState<ExtensionInfo | null>(null);
  const [detail, setDetail] = useState<ExtensionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // 订阅语言：整块扩展中心（含两个抽屉）随界面语言重渲染。
  useLocale();
  const [dragging, setDragging] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [devMode, setDevMode] = useState<boolean | null>(null);

  const visibleItems = useMemo(() => {
    const list = items ?? [];
    return filter === "all"
      ? list
      : list.filter((item) => item.kind === filter);
  }, [filter, items]);

  const widgetCount = (items ?? []).filter(
    (item) => item.kind === "widget",
  ).length;
  const sceneCount = (items ?? []).filter(
    (item) => item.kind === "scene",
  ).length;
  const installedPreview = preview
    ? (items ?? []).find(
        (item) =>
          item.kind === preview.preview.kind && item.id === preview.preview.id,
      )
    : undefined;
  const isSceneUpdate =
    preview?.preview.kind === "scene" && installedPreview !== undefined;

  useEffect(() => {
    getDevState()
      .then((state) => setDevMode(state.devMode))
      .catch(() => setDevMode(false));
  }, []);

  useEffect(() => {
    if (!pendingRemove) return;
    const timer = window.setTimeout(
      () => setPendingRemove(null),
      REMOVE_CONFIRM_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pendingRemove]);

  const previewPath = useCallback(async (path: string): Promise<void> => {
    setMessage("");
    setBusy(true);
    try {
      const next = await inspectExtension(path);
      setPreview({ path, preview: next });
    } catch (error) {
      setMessage(
        m.ext_error_inspect({ reason: toExtensionFailure(error).message }),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  // 拖拽安装：Tauri 原生 drop 事件给的是文件系统路径。
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragging(false);
          return;
        }
        setDragging(false);
        if (event.payload.type !== "drop") return;
        const first = (event.payload.paths ?? [])[0];
        if (!first) {
          setMessage(m.ext_drop_no_path());
          return;
        }
        void previewPath(first);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        setMessage(m.ext_drop_unavailable());
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [previewPath]);

  const pickAndPreview = useCallback((): void => {
    setMessage("");
    setBusy(true);
    pickExtension()
      .then((picked) => {
        if (picked) setPreview(picked);
      })
      .catch((error: unknown) => {
        setMessage(
          m.ext_error_pick({ reason: toExtensionFailure(error).message }),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const toggleDevMode = useCallback(
    (enabled: boolean): void => {
      setBusy(true);
      setDeveloperMode(enabled)
        .then(async (state) => {
          setDevMode(state.devMode);
          setMessage(enabled ? m.ext_dev_on() : m.ext_dev_off());
          await refresh();
        })
        .catch((error: unknown) => {
          setMessage(
            m.ext_error_dev_toggle({ reason: toExtensionFailure(error).message }),
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [refresh],
  );

  const pickDev = useCallback((): void => {
    setBusy(true);
    pickDevPackage()
      .then(async (info) => {
        if (info) setMessage(m.ext_toast_dev_mounted({ name: info.name }));
        await refresh();
      })
      .catch((error: unknown) => {
        setMessage(
          m.ext_error_dev_mount({ reason: toExtensionFailure(error).message }),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }, [refresh]);

  const confirmInstall = useCallback((): void => {
    if (!preview) return;
    setBusy(true);
    installExtension(preview.path, preview.preview.sourceDigest)
      .then(async (installed) => {
        const toastArgs = {
          name: installed.name,
          version: installed.version,
        };
        setMessage(
          isSceneUpdate
            ? m.ext_toast_updated(toastArgs)
            : m.ext_toast_installed(toastArgs),
        );
        setPreview(null);
        await refresh();
      })
      .catch((error: unknown) => {
        setMessage(
          m.ext_error_install({ reason: toExtensionFailure(error).message }),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }, [isSceneUpdate, preview, refresh]);

  const runAction = useCallback(
    (action: () => Promise<unknown>, success: string): void => {
      setBusy(true);
      action()
        .then(async () => {
          setMessage(success);
          await refresh();
        })
        .catch((error: unknown) => {
          setMessage(toExtensionFailure(error).message);
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [refresh],
  );

  const confirmEnable = useCallback((): void => {
    if (!enableTarget) return;
    const target = enableTarget;
    setBusy(true);
    setExtensionEnabled(target.id, true)
      .then(async () => {
        setMessage(m.ext_toast_enabled({ name: target.name }));
        setEnableTarget(null);
        await refresh();
      })
      .catch((error: unknown) => {
        setMessage(
          m.ext_error_enable({ reason: toExtensionFailure(error).message }),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }, [enableTarget, refresh]);

  const toggleCapability = useCallback(
    (capability: string, granted: boolean): void => {
      if (!detail) return;
      setBusy(true);
      setExtensionCapability(detail.id, capability, granted)
        .then(async (updated) => {
          setDetail(updated);
          await refresh();
        })
        .catch((error: unknown) => {
          setMessage(
            m.ext_error_update_caps({
              reason: toExtensionFailure(error).message,
            }),
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [detail, refresh],
  );

  const removeItem = useCallback(
    (item: ExtensionInfo): void => {
      const key = itemKey(item);
      if (pendingRemove !== key) {
        setPendingRemove(key);
        return;
      }
      setPendingRemove(null);
      setBusy(true);
      const removal = item.dev
        ? removeDevPackage(item.id)
        : removeExtension(item.kind, item.id);
      removal
        .then(async () => {
          setMessage(
            item.dev
              ? m.ext_toast_removed({ name: item.name })
              : m.ext_toast_uninstalled({ name: item.name }),
          );
          if (detail?.kind === item.kind && detail.id === item.id) {
            setDetail(null);
          }
          await refresh();
        })
        .catch((error: unknown) => {
          setMessage(
            m.ext_error_uninstall({ reason: toExtensionFailure(error).message }),
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [detail, pendingRemove, refresh],
  );

  const openDir = useCallback((): void => {
    const kind: ExtensionKind = filter === "scene" ? "scene" : "widget";
    openExtensionsDir(kind)
      .then((path) => setMessage(m.ext_toast_open_dir({ path })))
      .catch((error: unknown) => {
        setMessage(
          m.ext_error_open_dir({ reason: toExtensionFailure(error).message }),
        );
      });
  }, [filter]);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5 text-bamboo" />
          {m.ext_title()}
        </CardTitle>
        <CardDescription>{m.ext_description()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {items === null
              ? m.ext_loading()
              : m.ext_installed_count({
                  count: String(items.length),
                  widgets: String(widgetCount),
                  scenes: String(sceneCount),
                })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={pickAndPreview}
              disabled={busy}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {m.ext_install_from_file()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openDir}
              className="gap-1.5"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {m.ext_open_dir()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {m.ext_refresh()}
            </Button>
          </div>
        </div>

        <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
          <legend className="sr-only">{m.ext_type_legend()}</legend>
          {(
            [
              ["all", m.ext_filter_all],
              ["widget", m.ext_filter_widget],
              ["scene", m.ext_filter_scene],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === value
                  ? "border-bamboo bg-bamboo/10 text-bamboo"
                  : "border-border/70 text-muted-foreground hover:border-bamboo/60"
              }`}
            >
              {label()}
            </button>
          ))}
        </fieldset>

        <div
          data-testid="extensions-drop-zone"
          className={`rounded-lg border border-dashed p-4 text-xs transition-colors ${
            dragging
              ? "border-bamboo bg-bamboo/10 text-ink-soft"
              : "border-border/70 text-muted-foreground"
          }`}
        >
          {dragging ? m.ext_drop_active() : m.ext_drop_hint()}
        </div>

        {issues.length > 0 && (
          <ul className="space-y-1">
            {issues.map((issue) => (
              <li key={issue} className="text-xs text-destructive">
                {issue}
              </li>
            ))}
          </ul>
        )}

        {items?.length === 0 && (
          <p className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
            {m.ext_empty()}
          </p>
        )}

        <div className="space-y-3">
          {visibleItems.map((item) => (
            <article
              key={`${item.kind}-${item.id}`}
              className="rounded-xl border border-border/60 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="truncate text-sm text-ink-soft">
                      {item.name}
                    </span>
                    <span className="text-[10px] text-ink-faint">
                      {item.version} · {item.id}
                    </span>
                    <Badge variant="outline">{kindLabel(item.kind)}</Badge>
                    <Badge variant={statusVariant(item)}>
                      {statusLabel(item.status)}
                    </Badge>
                    {item.dev && (
                      <Badge variant="outline">{m.ext_dev_badge()}</Badge>
                    )}
                    {item.kind === "widget" && item.enabled && (
                      <Badge variant="secondary">
                        {item.running
                          ? item.visible
                            ? m.ext_state_running()
                            : m.ext_state_background()
                          : m.ext_state_enabled()}
                      </Badge>
                    )}
                  </div>
                  {item.description && (
                    <p className="text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                  {item.error && (
                    <p className="text-[11px] text-destructive">
                      {item.error.code}：{item.error.message}
                    </p>
                  )}
                  {(item.author || item.license) && (
                    <p className="text-[11px] text-ink-faint">
                      {item.author ? m.ext_author({ name: item.author }) : ""}
                      {item.author && item.license ? " · " : ""}
                      {item.license ?? ""}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {item.kind === "widget" &&
                    (item.enabled ? (
                      <>
                        {item.running && item.visible ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            aria-label={m.ext_aria_action({ action: m.ext_action_close(), name: item.name })}
                            onClick={() =>
                              runAction(
                                () => closeExtension(item.id),
                                m.ext_toast_closed({ name: item.name }),
                              )
                            }
                          >
                            {m.ext_action_close()}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy || !item.enabled}
                            aria-label={m.ext_aria_action({ action: m.ext_action_open(), name: item.name })}
                            onClick={() =>
                              runAction(
                                () => openExtension("widget", item.id),
                                m.ext_toast_opened({ name: item.name }),
                              )
                            }
                          >
                            {m.ext_action_open()}
                          </Button>
                        )}
                        {item.running && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={m.ext_aria_action({ action: m.ext_action_stop(), name: item.name })}
                            onClick={() =>
                              runAction(
                                () => stopExtension(item.id),
                                m.ext_toast_stopped({ name: item.name }),
                              )
                            }
                          >
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={m.ext_aria_action({ action: m.ext_action_disable(), name: item.name })}
                          onClick={() =>
                            runAction(
                              () => setExtensionEnabled(item.id, false),
                              m.ext_toast_disabled({ name: item.name }),
                            )
                          }
                        >
                          {m.ext_action_disable()}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || !canEnable(item)}
                        aria-label={m.ext_aria_action({ action: m.ext_action_enable(), name: item.name })}
                        onClick={() => {
                          setMessage("");
                          setEnableTarget(item);
                        }}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {m.ext_action_enable()}
                      </Button>
                    ))}

                  {item.kind === "scene" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={onOpenWallpaperSettings}
                    >
                      {m.ext_action_wallpaper_settings()}
                    </Button>
                  )}

                  {item.dev && item.kind === "widget" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || !item.enabled}
                      aria-label={m.ext_aria_action({ action: m.ext_action_reload(), name: item.name })}
                      onClick={() =>
                        runAction(
                          () => reloadDevPackage(item.id),
                          m.ext_toast_reloaded({ name: item.name }),
                        )
                      }
                    >
                      {m.ext_action_reload()}
                    </Button>
                  )}

                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={m.ext_aria_action({ action: m.ext_action_details(), name: item.name })}
                    onClick={() => setDetail(item)}
                  >
                    {m.ext_action_details()}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      pendingRemove === itemKey(item) ? "destructive" : "ghost"
                    }
                    disabled={busy}
                    aria-label={m.ext_aria_action({
                      action: item.dev
                        ? m.ext_action_remove()
                        : m.ext_action_uninstall(),
                      name: item.name,
                    })}
                    onClick={() => removeItem(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {removeLabel(item, pendingRemove === itemKey(item))}
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="space-y-2 rounded-xl border border-dashed border-border/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm text-ink-soft">{m.ext_dev_mode()}</p>
              <p className="text-xs text-muted-foreground">
                {m.ext_dev_description()}
              </p>
            </div>
            <Switch
              aria-label={m.ext_dev_mode()}
              checked={devMode === true}
              disabled={busy || devMode === null}
              onCheckedChange={toggleDevMode}
            />
          </div>
          {devMode === true && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={pickDev}
                disabled={busy}
                className="gap-1.5"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {m.ext_dev_add()}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {m.ext_dev_add_hint()}
              </span>
            </div>
          )}
        </div>

        {message && (
          <p className="text-xs text-muted-foreground break-all">{message}</p>
        )}
      </CardContent>

      <Sheet
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {preview && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {isSceneUpdate ? m.ext_confirm_update() : m.ext_confirm_install()}{" "}
                  {preview.preview.name}
                </SheetTitle>
                <SheetDescription>
                  {kindLabel(preview.preview.kind)} · {preview.preview.version}{" "}
                  · {formatBytes(preview.preview.bytes)}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-sm">
                {isSceneUpdate && installedPreview && (
                  <p className="rounded-lg border border-bamboo/30 bg-bamboo/5 p-2 text-[11px] text-ink-soft">
                    {m.ext_update_notice({
                      current: installedPreview.version,
                      next: preview.preview.version,
                    })}
                  </p>
                )}
                {preview.preview.description && (
                  <p className="text-xs text-muted-foreground">
                    {preview.preview.description}
                  </p>
                )}
                <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-xs">
                  <dt className="text-ink-faint">ID</dt>
                  <dd className="truncate font-mono">{preview.preview.id}</dd>
                  <dt className="text-ink-faint">{m.ext_field_author()}</dt>
                  <dd>
                    {preview.preview.author ?? m.ext_undeclared()}
                  </dd>
                  <dt className="text-ink-faint">{m.ext_field_license()}</dt>
                  <dd>
                    {preview.preview.license ?? m.ext_undeclared()}
                  </dd>
                  <dt className="text-ink-faint">{m.ext_field_files()}</dt>
                  <dd>
                    {m.ext_file_count({
                      count: String(preview.preview.fileCount),
                    })}
                  </dd>
                  <dt className="text-ink-faint">{m.ext_field_digest()}</dt>
                  <dd className="truncate font-mono text-[10px]">
                    {preview.preview.sourceDigest}
                  </dd>
                </dl>
                {preview.preview.capabilities.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-medium text-ink-soft">
                      {m.ext_field_capabilities()}
                    </h3>
                    <div className="flex flex-wrap gap-1">
                      {preview.preview.capabilities.map((capability) => (
                        <Badge key={capability} variant="secondary">
                          {capabilityLabel(capability)} ·{" "}
                          {capabilityLevel(capability)}
                        </Badge>
                      ))}
                    </div>
                  </section>
                )}
                {preview.preview.network.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-medium text-ink-soft">
                      {m.ext_field_network()}
                    </h3>
                    <ul className="space-y-0.5 font-mono text-[11px] text-ink-faint">
                      {preview.preview.network.map((origin) => (
                        <li key={origin}>{origin}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {preview.preview.warnings.length > 0 && (
                  <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700">
                    {preview.preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {isSceneUpdate
                    ? m.ext_install_note_update()
                    : m.ext_install_note()}
                </p>
                {message && (
                  <p className="text-xs text-destructive">{message}</p>
                )}
              </div>
              <div className="mt-auto flex justify-end gap-2 border-t border-border/60 p-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPreview(null)}
                  disabled={busy}
                >
                  {m.ext_cancel()}
                </Button>
                <Button type="button" onClick={confirmInstall} disabled={busy}>
                  {busy
                    ? m.ext_installing()
                    : isSceneUpdate
                      ? m.ext_confirm_update()
                      : m.ext_confirm_install()}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Sheet
        open={enableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEnableTarget(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {enableTarget && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {m.ext_enable_title({ name: enableTarget.name })}
                </SheetTitle>
                <SheetDescription>
                  {m.ext_enable_description()}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
                {enableTarget.status === "needs-review" && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700">
                    {m.ext_enable_manifest_changed()}
                  </p>
                )}
                <ul className="space-y-2">
                  {(enableTarget.capabilities ?? []).map((capability) => (
                    <li
                      key={capability}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-2.5 text-xs"
                    >
                      <div>
                        <p className="text-ink-soft">
                          {capabilityLabel(capability)}
                        </p>
                        <p className="font-mono text-[10px] text-ink-faint">
                          {capability}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {capabilityLevel(capability)}
                      </Badge>
                    </li>
                  ))}
                  {(enableTarget.capabilities ?? []).length === 0 && (
                    <li className="text-xs text-muted-foreground">
                      {m.ext_no_capabilities()}
                    </li>
                  )}
                </ul>
                {(enableTarget.network ?? []).length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-medium text-ink-soft">
                      {m.ext_field_network()}
                    </h3>
                    <ul className="space-y-0.5 font-mono text-[11px] text-ink-faint">
                      {(enableTarget.network ?? []).map((origin) => (
                        <li key={origin}>{origin}</li>
                      ))}
                    </ul>
                  </section>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {m.ext_capabilities_note()}
                </p>
                {message && (
                  <p className="text-xs text-destructive">{message}</p>
                )}
              </div>
              <div className="mt-auto flex justify-end gap-2 border-t border-border/60 p-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEnableTarget(null)}
                  disabled={busy}
                >
                  {m.ext_cancel()}
                </Button>
                <Button type="button" onClick={confirmEnable} disabled={busy}>
                  {busy ? m.ext_enabling() : m.ext_confirm_enable()}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ExtensionDetailSheet
        item={detail}
        busy={busy}
        onClose={() => setDetail(null)}
        onToggleCapability={toggleCapability}
      />
    </Card>
  );
}
