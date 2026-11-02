/**
 * 壁纸库窗口的「素材管理」页签。
 *
 * 只做导入 / 预览 / 管理：素材文件不复制、不转码，也不生成派生素材，
 * 所以这里没有裁剪与滤镜，预览直接读 Tauri asset URL。
 *
 * 常驻挂载（页签切换只做 CSS 隐藏），`active` 首次为 true 时才拉数据，
 * 之后靠 `media-changed` 增量刷新，切页签不会重复 invoke。
 */
"use client";

import { Trash2, Upload, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  activateMediaAsset,
  getMediaAssetUrl,
  importMediaAssets,
  listMediaAssets,
  pruneMediaAssets,
  removeMediaAsset,
  renameMediaAsset,
} from "@/core/media/media-api";
import { onMediaChanged } from "@/core/media/media-events";
import { formatBytes } from "@/core/media/media-state";
import type { MediaAsset } from "@/core/media/types";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type SortMode = "recent" | "name";

type Busy = "import" | "rename" | "remove" | "prune" | "activate" | null;

const SORTERS: Record<SortMode, (a: MediaAsset, b: MediaAsset) => number> = {
  recent: (a, b) => b.addedAt - a.addedAt,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** 失败明细只显示前几项，避免一次导入几十个坏文件时糊满整屏。 */
const MAX_FAILED_NAMES = 3;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MediaManagerPanel({ active }: { active: boolean }) {
  useLocale();
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("recent");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadedRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await listMediaAssets();
    setAssets(list);
    setSelectedId((current) =>
      current && list.some((asset) => asset.id === current)
        ? current
        : (list[0]?.id ?? null),
    );
    // 只预取图片；视频等到被选中才取 URL，避免一次挂上一堆解码器。
    const images = list.filter(
      (asset) => asset.kind === "image" && asset.available,
    );
    const entries = await Promise.all(
      images.map(async (asset) => {
        const url = await getMediaAssetUrl(asset.id);
        return [asset.id, url] as const;
      }),
    );
    setUrls((current) => {
      const next = { ...current };
      for (const [id, url] of entries) {
        if (url) next[id] = url;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  // 常驻订阅：页签隐藏时「壁纸层」的媒体面板仍能导入/移除素材，
  // 漏掉这些 `media-changed` 会让切回素材页签时看到旧列表。
  useEffect(() => onMediaChanged(() => void refresh()), [refresh]);

  const sorted = useMemo(
    () => [...(assets ?? [])].sort(SORTERS[sort]),
    [assets, sort],
  );
  const selected = useMemo(
    () => (assets ?? []).find((asset) => asset.id === selectedId) ?? null,
    [assets, selectedId],
  );

  const selectedUrl = selected ? (urls[selected.id] ?? null) : null;

  // 重命名输入框出现时立即聚焦，替代会被 a11y 规则拦下的 autoFocus。
  useEffect(() => {
    if (!editing) return;
    const input = nameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  useEffect(() => {
    if (!selected || selected.kind !== "video" || !selected.available) return;
    if (selectedUrl) return;
    let cancelled = false;
    void getMediaAssetUrl(selected.id).then((url) => {
      if (cancelled || !url) return;
      setUrls((current) => ({ ...current, [selected.id]: url }));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, selectedUrl]);

  const total = assets?.length ?? 0;
  const images = (assets ?? []).filter(
    (asset) => asset.kind === "image",
  ).length;
  const missing = (assets ?? []).filter((asset) => !asset.available).length;

  const runAction = useCallback(
    (
      action: Busy,
      task: Promise<unknown>,
      failure: (reason: string) => string,
    ) => {
      setBusy(action);
      setError("");
      setNotice("");
      void task
        .then(() => refresh())
        .catch((reason: unknown) => {
          setError(failure(reasonOf(reason)));
        })
        .finally(() => setBusy(null));
    },
    [refresh],
  );

  const importAssets = useCallback((): void => {
    setBusy("import");
    setError("");
    setNotice("");
    void importMediaAssets()
      .then(async (result) => {
        if (!result) return;
        const summary = m.media_manager_import_done({
          added: result.added.length,
          skipped: result.skipped,
          failed: result.failed.length,
        });
        const names = result.failed
          .slice(0, MAX_FAILED_NAMES)
          .map((item) => item.name)
          .join("、");
        setNotice(
          result.failed.length > 0
            ? `${summary}${m.media_manager_import_done_names({ names })}`
            : summary,
        );
        await refresh();
      })
      .catch((reason: unknown) => {
        setError(m.media_manager_import_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(null));
  }, [refresh]);

  const commitRename = useCallback(
    (asset: MediaAsset, raw: string): void => {
      setEditing(false);
      if (cancelRenameRef.current) {
        cancelRenameRef.current = false;
        return;
      }
      const name = raw.trim();
      if (!name || name === asset.name) return;
      runAction("rename", renameMediaAsset(asset.id, name), (reason) =>
        m.media_manager_rename_failed({ reason }),
      );
    },
    [runAction],
  );

  const remove = useCallback(
    (asset: MediaAsset): void => {
      runAction("remove", removeMediaAsset(asset.id), (reason) =>
        m.media_remove_failed({ reason }),
      );
    },
    [runAction],
  );

  const activate = useCallback(
    (asset: MediaAsset): void => {
      runAction("activate", activateMediaAsset(asset.id), (reason) =>
        m.media_activate_failed({ reason }),
      );
    },
    [runAction],
  );

  const prune = useCallback((): void => {
    setBusy("prune");
    setError("");
    setNotice("");
    void pruneMediaAssets()
      .then(async (count) => {
        setNotice(m.media_manager_prune_done({ count }));
        await refresh();
      })
      .catch((reason: unknown) => {
        setError(m.media_manager_prune_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(null));
  }, [refresh]);

  const busyAny = busy !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-soft">
            {m.media_manager_title()}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.media_manager_description()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busyAny}
            onClick={importAssets}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {busy === "import"
              ? m.media_manager_import_busy()
              : m.media_manager_import()}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busyAny || missing === 0}
            onClick={prune}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {m.media_manager_prune()}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {m.media_manager_count({
            total,
            images,
            videos: total - images,
          })}
        </p>
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as SortMode)}
        >
          <SelectTrigger
            size="sm"
            className="w-32"
            aria-label={m.media_manager_sort_label()}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">
              {m.media_manager_sort_recent()}
            </SelectItem>
            <SelectItem value="name">{m.media_manager_sort_name()}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {missing > 0 ? (
        <p className="text-xs text-destructive">
          {m.media_manager_missing_hint({ count: missing })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {assets === null ? (
            <p className="text-xs text-muted-foreground">
              {m.media_manager_loading()}
            </p>
          ) : assets.length === 0 ? (
            <div className="rounded-xl border border-paper-deep/60 border-dashed bg-paper-warm/40 px-6 py-10 text-center">
              <p className="text-sm text-ink-soft">{m.media_manager_empty()}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {m.media_manager_empty_hint()}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-3"
                disabled={busyAny}
                onClick={importAssets}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {m.media_manager_import()}
              </Button>
            </div>
          ) : (
            <ul className="space-y-2" data-testid="media-asset-list">
              {sorted.map((asset) => (
                <li
                  key={asset.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                    selectedId === asset.id
                      ? "border-bamboo/50 bg-bamboo-mist/20"
                      : "border-paper-deep/50",
                    asset.available ? undefined : "opacity-70",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(asset.id)}
                    aria-pressed={selectedId === asset.id}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-paper-deep/30">
                      {asset.kind === "image" && urls[asset.id] ? (
                        <img
                          src={urls[asset.id]}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Video
                          className="h-5 w-5 text-ink-faint"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {asset.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {asset.kind === "image"
                          ? m.media_kind_image()
                          : m.media_kind_video()}
                        {" · "}
                        {formatBytes(asset.sizeBytes)}
                      </span>
                    </span>
                  </button>
                  {asset.available ? null : (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-destructive/40 text-destructive"
                    >
                      {m.media_manager_missing()}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    disabled={busyAny}
                    onClick={() => remove(asset)}
                  >
                    {m.media_asset_remove()}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {m.media_manager_preview()}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected === null ? (
              <p className="text-xs text-muted-foreground">
                {m.media_manager_select_hint()}
              </p>
            ) : (
              <>
                <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-paper-deep/30">
                  {selectedUrl === null ? (
                    <span className="px-3 text-center text-xs text-muted-foreground">
                      {selected.available
                        ? m.media_manager_loading()
                        : m.media_asset_missing()}
                    </span>
                  ) : selected.kind === "image" ? (
                    <img
                      src={selectedUrl}
                      alt={m.media_manager_preview_alt({ name: selected.name })}
                      decoding="async"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <video
                      src={selectedUrl}
                      controls
                      muted
                      playsInline
                      className="h-full w-full object-contain"
                    >
                      <track kind="captions" />
                    </video>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {editing ? (
                    <input
                      ref={nameInputRef}
                      defaultValue={selected.name}
                      aria-label={m.media_manager_rename_aria({
                        name: selected.name,
                      })}
                      className="min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1 text-sm"
                      onBlur={(event) =>
                        commitRename(selected, event.currentTarget.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          cancelRenameRef.current = true;
                          setEditing(false);
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <>
                      <p className="min-w-0 flex-1 truncate text-sm text-ink">
                        {selected.name}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busyAny}
                        onClick={() => setEditing(true)}
                      >
                        {m.media_manager_rename()}
                      </Button>
                    </>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  {selected.kind === "image"
                    ? m.media_kind_image()
                    : m.media_kind_video()}
                  {" · "}
                  {formatBytes(selected.sizeBytes)}
                </p>
                {selected.available ? null : (
                  <p className="text-xs text-destructive">
                    {m.media_asset_missing()}
                  </p>
                )}

                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={busyAny || !selected.available}
                  onClick={() => activate(selected)}
                >
                  {m.media_manager_set_wallpaper()}
                </Button>

                {selected.kind === "video" ? (
                  <p className="text-xs text-muted-foreground">
                    {m.media_manager_preview_hint()}
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
