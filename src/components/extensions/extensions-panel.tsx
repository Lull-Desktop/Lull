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
import { isDesktopWindow } from "@/core/window/controls";
import { useExtensions } from "@/hooks/use-extensions";
import {
  closeExtension,
  type ExtensionInfo,
  type ExtensionKind,
  inspectExtension,
  installExtension,
  openExtension,
  openExtensionsDir,
  type PickedExtension,
  pickExtension,
  removeExtension,
  setExtensionCapability,
  setExtensionEnabled,
  stopExtension,
  toExtensionFailure,
} from "@/lib/extensions";
import { ExtensionDetailSheet } from "./extension-detail-sheet";
import {
  capabilityLabel,
  capabilityLevel,
  formatBytes,
  kindLabel,
  statusLabel,
} from "./labels";

const REMOVE_CONFIRM_MS = 5000;

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
  const [dragging, setDragging] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

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
      setMessage(`无法读取扩展包：${toExtensionFailure(error).message}`);
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
          setMessage("没有拿到拖入的文件路径：请改用「从文件安装」。");
          return;
        }
        void previewPath(first);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        setMessage("拖拽通道不可用，请用「从文件安装」。");
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
        setMessage(`选择扩展包失败：${toExtensionFailure(error).message}`);
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const confirmInstall = useCallback((): void => {
    if (!preview) return;
    setBusy(true);
    installExtension(preview.path, preview.preview.sourceDigest)
      .then(async (installed) => {
        setMessage(`已安装 ${installed.name} ${installed.version}`);
        setPreview(null);
        await refresh();
      })
      .catch((error: unknown) => {
        setMessage(`安装失败：${toExtensionFailure(error).message}`);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [preview, refresh]);

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
        setMessage(`已启用 ${target.name}`);
        setEnableTarget(null);
        await refresh();
      })
      .catch((error: unknown) => {
        setMessage(`启用失败：${toExtensionFailure(error).message}`);
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
          setMessage(`更新权限失败：${toExtensionFailure(error).message}`);
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
      removeExtension(item.kind, item.id)
        .then(async () => {
          setMessage(`已卸载 ${item.name}`);
          if (detail?.kind === item.kind && detail.id === item.id) {
            setDetail(null);
          }
          await refresh();
        })
        .catch((error: unknown) => {
          setMessage(`卸载失败：${toExtensionFailure(error).message}`);
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
      .then((path) => setMessage(`扩展目录：${path}`))
      .catch((error: unknown) => {
        setMessage(`打开目录失败：${toExtensionFailure(error).message}`);
      });
  }, [filter]);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5 text-bamboo" />
          扩展
        </CardTitle>
        <CardDescription>
          管理壁纸内容与工具扩展。安装不会自动运行；启用时才授予权限。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {items === null
              ? "正在读取扩展…"
              : `已安装 ${items.length} 个（工具 ${widgetCount} / 壁纸 ${sceneCount}）`}
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
              从文件安装
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openDir}
              className="gap-1.5"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              打开目录
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>

        <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
          <legend className="sr-only">扩展类型</legend>
          {(
            [
              ["all", "全部"],
              ["widget", "工具"],
              ["scene", "壁纸"],
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
              {label}
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
          {dragging
            ? "松开即可检查扩展包"
            : "把 .zip 或扩展包文件夹拖到这里；拖不动就点「从文件安装」。"}
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
            还没有安装扩展。从文件安装一个 `.zip`：工具包根目录含
            `widget.json`， 壁纸包根目录含 `catalog.json`。
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
                    {item.dev && <Badge variant="outline">开发</Badge>}
                    {item.kind === "widget" && item.enabled && (
                      <Badge variant="secondary">
                        {item.running
                          ? item.visible
                            ? "运行中"
                            : "后台运行"
                          : "已启用"}
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
                      {item.author ? `作者 ${item.author}` : ""}
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
                            aria-label={`关闭 ${item.name}`}
                            onClick={() =>
                              runAction(
                                () => closeExtension(item.id),
                                `已关闭 ${item.name}`,
                              )
                            }
                          >
                            关闭
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy || !item.enabled}
                            aria-label={`打开 ${item.name}`}
                            onClick={() =>
                              runAction(
                                () => openExtension("widget", item.id),
                                `已打开 ${item.name}`,
                              )
                            }
                          >
                            打开
                          </Button>
                        )}
                        {item.running && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`结束 ${item.name}`}
                            onClick={() =>
                              runAction(
                                () => stopExtension(item.id),
                                `已结束 ${item.name}`,
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
                          aria-label={`停用 ${item.name}`}
                          onClick={() =>
                            runAction(
                              () => setExtensionEnabled(item.id, false),
                              `已停用 ${item.name}`,
                            )
                          }
                        >
                          停用
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || !canEnable(item)}
                        aria-label={`启用 ${item.name}`}
                        onClick={() => {
                          setMessage("");
                          setEnableTarget(item);
                        }}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        启用
                      </Button>
                    ))}

                  {item.kind === "scene" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={onOpenWallpaperSettings}
                    >
                      壁纸设置
                    </Button>
                  )}

                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`详情 ${item.name}`}
                    onClick={() => setDetail(item)}
                  >
                    详情
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      pendingRemove === itemKey(item) ? "destructive" : "ghost"
                    }
                    disabled={busy}
                    aria-label={`卸载 ${item.name}`}
                    onClick={() => removeItem(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {pendingRemove === itemKey(item) ? "确认卸载" : "卸载"}
                  </Button>
                </div>
              </div>
            </article>
          ))}
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
                <SheetTitle>确认安装 {preview.preview.name}</SheetTitle>
                <SheetDescription>
                  {kindLabel(preview.preview.kind)} · {preview.preview.version}{" "}
                  · {formatBytes(preview.preview.bytes)}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-sm">
                {preview.preview.description && (
                  <p className="text-xs text-muted-foreground">
                    {preview.preview.description}
                  </p>
                )}
                <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-xs">
                  <dt className="text-ink-faint">ID</dt>
                  <dd className="truncate font-mono">{preview.preview.id}</dd>
                  <dt className="text-ink-faint">作者</dt>
                  <dd>{preview.preview.author ?? "未声明"}</dd>
                  <dt className="text-ink-faint">许可</dt>
                  <dd>{preview.preview.license ?? "未声明"}</dd>
                  <dt className="text-ink-faint">文件</dt>
                  <dd>{preview.preview.fileCount} 个</dd>
                  <dt className="text-ink-faint">指纹</dt>
                  <dd className="truncate font-mono text-[10px]">
                    {preview.preview.sourceDigest}
                  </dd>
                </dl>
                {preview.preview.capabilities.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-medium text-ink-soft">
                      声明能力
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
                      网络源
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
                  安装只写入文件，不执行扩展代码；启用时才确认权限。
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
                  取消
                </Button>
                <Button type="button" onClick={confirmInstall} disabled={busy}>
                  {busy ? "安装中…" : "确认安装"}
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
                <SheetTitle>启用 {enableTarget.name}</SheetTitle>
                <SheetDescription>
                  启用会授予清单声明的能力，但不会自动打开窗口。
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
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
                      该扩展未声明能力。
                    </li>
                  )}
                </ul>
                {(enableTarget.network ?? []).length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-medium text-ink-soft">
                      网络源
                    </h3>
                    <ul className="space-y-0.5 font-mono text-[11px] text-ink-faint">
                      {(enableTarget.network ?? []).map((origin) => (
                        <li key={origin}>{origin}</li>
                      ))}
                    </ul>
                  </section>
                )}
                <p className="text-[11px] text-muted-foreground">
                  强制项由宿主拦截；提示项（音频/媒体）不是安全沙箱。
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
                  取消
                </Button>
                <Button type="button" onClick={confirmEnable} disabled={busy}>
                  {busy ? "启用中…" : "确认启用"}
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
