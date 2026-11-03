/**
 * N3 功能型 Noise Library 面板（开发/验收用）。
 *
 * 导入、搜索、分类/标签、收藏、重命名与删除都走 `@lull/media-sdk` 的
 * `noise.library.*`；正式 Mixer/Library UI 由 N6 打磨。
 */
"use client";

import type {
  LullMediaClient,
  NoiseAsset,
  NoiseCategory,
  NoiseTag,
} from "@lull/media-sdk";
import {
  FolderPlus,
  Heart,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getMediaClient } from "@/hooks/use-media-client";
import { NoiseTrackListCard } from "@/components/settings/noise-track-list-card";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function categoryDepth(
  categories: NoiseCategory[],
  categoryId: string,
): number {
  let depth = 0;
  let current = categories.find((item) => item.id === categoryId);
  while (current?.parentId && depth < 16) {
    depth += 1;
    current = categories.find((item) => item.id === current?.parentId);
  }
  return depth;
}

export function NoiseLibraryPanel() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [assets, setAssets] = useState<NoiseAsset[]>([]);
  const [categories, setCategories] = useState<NoiseCategory[]>([]);
  const [tags, setTags] = useState<NoiseTag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagId, setTagId] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selected, setSelected] = useState<NoiseAsset | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assetCategory, setAssetCategory] = useState("");
  const [assetTags, setAssetTags] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const pageSize = 30;
  const refresh = useCallback(() => {
    setPage(1);
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    setClient(getMediaClient());
  }, []);

  // 筛选条件 / 刷新变化时，重置为第 1 页并整体替换列表。
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const timer = window.setTimeout(
      () => {
        void Promise.all([
          client.noise.library.listAssets({
            keyword: keyword.trim() || undefined,
            categoryId: categoryId || undefined,
            tagId: tagId || undefined,
            favoriteOnly: favoriteOnly || undefined,
            page: 1,
            pageSize,
          }),
          client.noise.library.getCategories(),
          client.noise.library.getTags(),
        ])
          .then(([result, nextCategories, nextTags]) => {
            if (!alive) return;
            setAssets(result.items);
            setTotal(result.total);
            setHasMore(result.hasMore);
            setCategories(nextCategories);
            setTags(nextTags);
            setPage(1);
            setError("");
          })
          .catch((reason: unknown) => {
            if (alive) setError(errorText(reason));
          });
      },
      keyword ? 220 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [categoryId, client, favoriteOnly, keyword, tagId, version]);

  // 滚动到底部时加载下一页，追加到现有列表。
  const loadMore = useCallback(async (): Promise<void> => {
    if (!client || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await client.noise.library.listAssets({
        keyword: keyword.trim() || undefined,
        categoryId: categoryId || undefined,
        tagId: tagId || undefined,
        favoriteOnly: favoriteOnly || undefined,
        page: nextPage,
        pageSize,
      });
      setAssets((previous) => [...previous, ...result.items]);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setLoadingMore(false);
    }
  }, [
    categoryId,
    client,
    favoriteOnly,
    hasMore,
    keyword,
    loadingMore,
    page,
    tagId,
  ]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      const el = event.currentTarget;
      if (loadingMore || !hasMore) return;
      // 距离底部不足 48px 时触发加载。
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceToBottom <= 48) {
        void loadMore();
      }
    },
    [hasMore, loadMore, loadingMore],
  );

  // 若首屏数据未撑满容器（无滚动条），自动续载直到填满或无更多数据。
  useEffect(() => {
    const el = listRef.current;
    if (!el || loadingMore || !hasMore || assets.length === 0) return;
    if (el.scrollHeight <= el.clientHeight + 1) {
      void loadMore();
    }
  }, [assets, hasMore, loadingMore, loadMore]);

  // 分类/标签面板修改后，刷新本面板的筛选下拉与素材编辑卡计数。
  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "noise.library.changed") refresh();
    });
    return () => stop();
  }, [client, refresh]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setDescription(selected.description ?? "");
    setAssetCategory(selected.category?.id ?? "");
    setAssetTags(selected.tags.map((tag) => tag.id));
  }, [selected]);

  const selectedTags = useMemo(() => new Set(assetTags), [assetTags]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        await action();
        refresh();
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const importFiles = useCallback((): void => {
    if (!client) return;
    void run("import", async () => {
      const result = await client.noise.library.importAssets();
      setNotice(
        `导入 ${result.imported.length}，重复 ${result.duplicates.length}，失败 ${result.failed.length}`,
      );
      if (result.failed.length > 0) {
        setError(
          result.failed
            .map((item) => `${item.fileName}: ${item.reason}`)
            .join("；"),
        );
      }
    });
  }, [client, run]);

  const importFolder = useCallback((): void => {
    if (!client) return;
    void run("folder", async () => {
      const result = await client.noise.library.importFolder();
      setNotice(
        `导入 ${result.imported.length}，重复 ${result.duplicates.length}，失败 ${result.failed.length}`,
      );
    });
  }, [client, run]);

  const addToMix = useCallback(
    (asset: NoiseAsset): void => {
      if (!client) return;
      void run(`add:${asset.id}`, async () => {
        await client.noise.tracks.add(asset.id);
        const session = await client.noise.session.getCurrent();
        if (session.state === "idle") {
          await client.noise.session.play();
        }
        setNotice(`已加入混音：${asset.name}`);
      });
    },
    [client, run],
  );

  const toggleFavorite = useCallback(
    (asset: NoiseAsset): void => {
      if (!client) return;
      void run(`favorite:${asset.id}`, async () => {
        await client.noise.library.setAssetFavorite(asset.id, !asset.favorite);
      });
    },
    [client, run],
  );

  const saveSelected = useCallback((): void => {
    if (!client || !selected) return;
    void run("save", async () => {
      const updated = await client.noise.library.updateAsset(selected.id, {
        name: name.trim(),
        description: description.trim() || null,
        categoryId: assetCategory || null,
        tagIds: assetTags,
      });
      setSelected(updated);
      setNotice("素材信息已保存");
    });
  }, [assetCategory, assetTags, client, description, name, run, selected]);

  const removeSelected = useCallback((): void => {
    if (!client || !selected) return;
    void confirm({
      title: "删除素材",
      description: `删除「${selected.name}」？引用它的 Preset 会标记为缺失。`,
      confirmLabel: "删除",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void run("remove", async () => {
        await client.noise.library.removeAsset(selected.id);
        setSelected(null);
        setNotice("素材已删除");
      });
    });
  }, [client, confirm, run, selected]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 overflow-hidden">
        <Card className="flex flex-col overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">Noise 素材库</CardTitle>
            <CardDescription>
              导入本地音频、按分类/标签/收藏筛选；导入只复制到 Lull
              受管目录，不改原文件。
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={importFiles}
                disabled={!client || busy !== ""}
              >
                <Upload className="mr-2 h-4 w-4" />
                音频导入
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={importFolder}
                disabled={!client || busy !== ""}
              >
                <FolderPlus className="mr-2 h-4 w-4" />
                文件夹导入
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!client || busy !== ""}
                onClick={() => {
                  if (!client) return;
                  void run("revalidate", async () => {
                    const result =
                      await client.noise.library.revalidateAssets();
                    setNotice(
                      `检查 ${result.checked}，缺失 ${result.missing}，恢复 ${result.restored}`,
                    );
                  });
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                刷新
              </Button>
              <div className="ml-auto flex flex-col items-center gap-2 text-sm text-ink-soft">
                <Switch
                  id="noise-favorite-only"
                  checked={favoriteOnly}
                  onCheckedChange={(checked) => {
                    setPage(1);
                    setFavoriteOnly(checked);
                  }}
                />
                <Label htmlFor="noise-favorite-only">只看收藏</Label>
              </div>
            </div>

            <div className="space-y-2">
              <input
                className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                value={keyword}
                onChange={(event) => {
                  setPage(1);
                  setKeyword(event.target.value);
                }}
                placeholder="搜索名称、描述、标签"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <select
                  className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                  value={categoryId}
                  onChange={(event) => {
                    setPage(1);
                    setCategoryId(event.target.value);
                  }}
                >
                  <option value="">全部分类</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {"　".repeat(categoryDepth(categories, category.id))}
                      {category.name}（{category.assetCount}）
                    </option>
                  ))}
                </select>
                <select
                  className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                  value={tagId}
                  onChange={(event) => {
                    setPage(1);
                    setTagId(event.target.value);
                  }}
                >
                  <option value="">全部标签</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}（{tag.assetCount ?? 0}）
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            {notice && <p className="text-sm text-emerald-700">{notice}</p>}

            <div
              ref={listRef}
              className="h-[420px] divide-y divide-paper-deep/50 overflow-y-auto overflow-x-hidden rounded-xl border border-paper-deep/60 bg-card"
              onScroll={handleScroll}
            >
              {assets.length === 0 ? (
                <p className="py-16 text-center text-sm text-ink-faint">
                  {busy ? "加载中…" : "还没有素材，先导入音频。"}
                </p>
              ) : (
                <>
                  {assets.map((asset) => (
                    <div
                      key={asset.id}
                      className={`flex cursor-pointer flex-wrap items-center gap-3 px-3 py-1.5 text-sm hover:bg-muted/40 ${
                        selected?.id === asset.id ? "bg-muted/60" : ""
                      }`}
                      onClick={() => setSelected(asset)}
                    >
                      <button
                        type="button"
                        className="shrink-0"
                        aria-label={asset.favorite ? "取消收藏" : "收藏"}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(asset);
                        }}
                      >
                        <Heart
                          className={`h-4 w-4 ${
                            asset.favorite
                              ? "fill-rose-500 text-rose-500"
                              : "text-ink-faint"
                          }`}
                        />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{asset.name}</p>
                        <p className="truncate text-xs text-ink-faint">
                          {asset.format.toUpperCase()} ·{" "}
                          {formatDuration(asset.durationMs)} ·{" "}
                          {formatSize(asset.sizeBytes)}
                          {asset.category ? ` · ${asset.category.name}` : ""}
                          {asset.status !== "available"
                            ? ` · ${asset.status}`
                            : ""}
                        </p>
                      </div>
                      <div className="hidden gap-1 md:flex">
                        {asset.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="rounded-full bg-muted px-2 py-0.5 text-xs"
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy !== ""}
                        onClick={(event) => {
                          event.stopPropagation();
                          addToMix(asset);
                        }}
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        添加到音轨
                      </Button>
                    </div>
                  ))}
                  {loadingMore && (
                    <div className="flex items-center justify-center gap-2 py-2 text-xs text-ink-soft">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      加载更多…
                    </div>
                  )}
                  {!hasMore && assets.length > 0 && (
                    <p className="py-2 text-center text-xs text-ink-faint">
                      没有更多了
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="text-xs text-ink-soft">共 {total} 个素材</div>
          </CardContent>
        </Card>

        <Card className="flex flex-col overflow-hidden">
          {selected ? (
            <>
              <CardHeader>
                <CardTitle className="text-base">
                  编辑「{selected.name}」
                </CardTitle>
                <CardDescription>
                  {selected.mediaKind === "procedural"
                    ? "内置程序化素材"
                    : `${selected.format.toUpperCase()} · ${formatDuration(selected.durationMs)}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="noise-asset-name">名称</Label>
                    <input
                      id="noise-asset-name"
                      className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                      value={name}
                      disabled={selected.mediaKind === "procedural"}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="noise-asset-category">分类</Label>
                    <select
                      id="noise-asset-category"
                      className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                      value={assetCategory}
                      disabled={selected.mediaKind === "procedural"}
                      onChange={(event) => setAssetCategory(event.target.value)}
                    >
                      <option value="">未分类</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="noise-asset-description">描述</Label>
                  <input
                    id="noise-asset-description"
                    className="h-9 w-full rounded-md border border-line bg-paper px-3 text-sm"
                    value={description}
                    disabled={selected.mediaKind === "procedural"}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>标签</Label>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex cursor-pointer items-center gap-1 rounded-full border border-line px-2 py-1 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={selectedTags.has(tag.id)}
                          disabled={selected.mediaKind === "procedural"}
                          onChange={(event) => {
                            setAssetTags((previous) =>
                              event.target.checked
                                ? [...previous, tag.id]
                                : previous.filter((id) => id !== tag.id),
                            );
                          }}
                        />
                        {tag.name}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    disabled={
                      busy !== "" || selected.mediaKind === "procedural"
                    }
                    onClick={saveSelected}
                  >
                    {busy === "save" && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    保存
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() => addToMix(selected)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    添加到音轨
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto text-red-600"
                    disabled={
                      busy !== "" || selected.mediaKind === "procedural"
                    }
                    onClick={removeSelected}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    删除素材
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle className="text-base">编辑素材</CardTitle>
                <CardDescription>
                  从左侧列表选择一个素材来编辑。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-faint">
                未选择素材
              </CardContent>
            </>
          )}
        </Card>
      </div>
      <NoiseTrackListCard client={client} />
      {confirmDialog}
    </div>
  );
}
