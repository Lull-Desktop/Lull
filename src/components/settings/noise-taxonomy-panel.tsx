// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 白噪音库「分类与标签」标签页。
 *
 * 从 NoiseLibraryPanel 拆出的分类/标签 CRUD 面板：内置分类/标签只读，
 * 用户分类可建层级，删除分类不会删除素材。媒体连接由白噪音库窗口
 * 统一建立，本面板不 connect/disconnect，仅订阅 `noise.library.changed`
 * 以便素材面板的改动同步刷新计数。
 */
"use client";

import type { LullMediaClient, NoiseCategory, NoiseTag } from "@lull/media-sdk";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function NoiseTaxonomyPanel() {
  useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [categories, setCategories] = useState<NoiseCategory[]>([]);
  const [tags, setTags] = useState<NoiseTag[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [newCategory, setNewCategory] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState("");
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [categoryDraftParent, setCategoryDraftParent] = useState("");
  const [newTag, setNewTag] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    setClient(getMediaClient());
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 只是手动刷新信号，不进查询参数
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void Promise.all([
      client.noise.library.getCategories(),
      client.noise.library.getTags(),
    ])
      .then(([nextCategories, nextTags]) => {
        if (!alive) return;
        setCategories(nextCategories);
        setTags(nextTags);
        setError("");
      })
      .catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [client, version]);

  // 素材面板修改素材（增删/改分类）后，刷新本面板的计数。
  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "noise.library.changed") refresh();
    });
    return () => stop();
  }, [client, refresh]);

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

  const createCategory = useCallback((): void => {
    if (!client || !newCategory.trim()) return;
    void run("category-create", async () => {
      await client.noise.library.createCategory({
        name: newCategory.trim(),
        parentId: newCategoryParent || undefined,
      });
      setNewCategory("");
      setNotice("分类已创建");
    });
  }, [client, newCategory, newCategoryParent, run]);

  const saveCategory = useCallback(
    (category: NoiseCategory): void => {
      if (!client || !categoryDraft.trim()) return;
      void run("category-update", async () => {
        await client.noise.library.updateCategory(category.id, {
          name: categoryDraft.trim(),
          parentId: categoryDraftParent || null,
        });
        setEditingCategory(null);
        setNotice("分类已更新");
      });
    },
    [categoryDraft, categoryDraftParent, client, run],
  );

  const deleteCategory = useCallback(
    (category: NoiseCategory): void => {
      if (!client) return;
      void confirm({
        title: "删除分类",
        description: `删除分类「${category.name}」？其中素材会变为未分类。`,
        confirmLabel: "删除",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void run("category-delete", async () => {
          await client.noise.library.deleteCategory(category.id);
          setNotice("分类已删除");
        });
      });
    },
    [client, confirm, run],
  );

  const createTag = useCallback((): void => {
    if (!client || !newTag.trim()) return;
    void run("tag-create", async () => {
      await client.noise.library.createTag(newTag.trim());
      setNewTag("");
      setNotice("标签已创建");
    });
  }, [client, newTag, run]);

  const saveTag = useCallback(
    (tag: NoiseTag): void => {
      if (!client || !tagDraft.trim()) return;
      void run("tag-update", async () => {
        await client.noise.library.updateTag(tag.id, tagDraft.trim());
        setEditingTag(null);
        setNotice("标签已更新");
      });
    },
    [client, run, tagDraft],
  );

  const deleteTag = useCallback(
    (tag: NoiseTag): void => {
      if (!client) return;
      void confirm({
        title: "删除标签",
        description: `删除标签「${tag.name}」？`,
        confirmLabel: "删除",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void run("tag-delete", async () => {
          await client.noise.library.deleteTag(tag.id);
          setNotice("标签已删除");
        });
      });
    },
    [client, confirm, run],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.noise_card_taxonomy()}</CardTitle>
          <CardDescription>
            内置分类/标签只读；用户分类可建层级，删除分类不会删除素材。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <Label>分类</Label>
            <div className="flex flex-wrap gap-2">
              <input
                className="h-9 min-w-32 flex-1 rounded-md border border-line bg-paper px-3 text-sm"
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
                placeholder="新分类名称"
              />
              <select
                aria-label="新分类父级"
                className="h-9 rounded-md border border-line bg-paper px-2 text-sm"
                value={newCategoryParent}
                onChange={(event) => setNewCategoryParent(event.target.value)}
              >
                <option value="">根分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {"　".repeat(categoryDepth(categories, category.id))}
                    {category.name}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                aria-label="创建分类"
                disabled={busy !== "" || !newCategory.trim()}
                onClick={createCategory}
              >
                <Plus className="mr-1 h-4 w-4" />
                创建
              </Button>
            </div>
            <div className="max-h-64 divide-y divide-line overflow-auto rounded-md border border-line">
              {categories.map((category) => (
                <div
                  key={category.id}
                  className="flex items-center gap-2 px-2 py-2 text-sm"
                >
                  {editingCategory === category.id ? (
                    <>
                      <input
                        aria-label="编辑分类名称"
                        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 text-sm"
                        value={categoryDraft}
                        onChange={(event) =>
                          setCategoryDraft(event.target.value)
                        }
                      />
                      <select
                        aria-label="编辑分类父级"
                        className="h-8 rounded-md border border-line bg-paper px-1 text-xs"
                        value={categoryDraftParent}
                        onChange={(event) =>
                          setCategoryDraftParent(event.target.value)
                        }
                      >
                        <option value="">根分类</option>
                        {categories
                          .filter((item) => item.id !== category.id)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {"　".repeat(categoryDepth(categories, item.id))}
                              {item.name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        aria-label="保存分类"
                        disabled={busy !== ""}
                        onClick={() => saveCategory(category)}
                      >
                        <Check className="h-4 w-4 text-emerald-600" />
                      </button>
                      <button
                        type="button"
                        aria-label="取消编辑"
                        onClick={() => setEditingCategory(null)}
                      >
                        <X className="h-4 w-4 text-ink-faint" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">
                        {"　".repeat(categoryDepth(categories, category.id))}
                        {category.name}
                      </span>
                      <span className="text-xs text-ink-faint">
                        {category.assetCount}
                      </span>
                      {category.sourceType === "user" ? (
                        <>
                          <button
                            type="button"
                            aria-label="编辑分类"
                            onClick={() => {
                              setEditingCategory(category.id);
                              setCategoryDraft(category.name);
                              setCategoryDraftParent(category.parentId ?? "");
                            }}
                          >
                            <Pencil className="h-4 w-4 text-ink-soft" />
                          </button>
                          <button
                            type="button"
                            aria-label="删除分类"
                            disabled={busy !== ""}
                            onClick={() => deleteCategory(category)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </button>
                        </>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-ink-faint">
                          内置
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>标签</Label>
            <div className="flex gap-2">
              <input
                className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-sm"
                value={newTag}
                onChange={(event) => setNewTag(event.target.value)}
                placeholder="新标签名称"
              />
              <Button
                type="button"
                size="sm"
                aria-label="创建标签"
                disabled={busy !== "" || !newTag.trim()}
                onClick={createTag}
              >
                <Plus className="mr-1 h-4 w-4" />
                创建
              </Button>
            </div>
            <div className="max-h-64 divide-y divide-line overflow-auto rounded-md border border-line">
              {tags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex items-center gap-2 px-2 py-2 text-sm"
                >
                  {editingTag === tag.id ? (
                    <>
                      <input
                        aria-label="编辑标签名称"
                        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 text-sm"
                        value={tagDraft}
                        onChange={(event) => setTagDraft(event.target.value)}
                      />
                      <button
                        type="button"
                        aria-label="保存标签"
                        disabled={busy !== ""}
                        onClick={() => saveTag(tag)}
                      >
                        <Check className="h-4 w-4 text-emerald-600" />
                      </button>
                      <button
                        type="button"
                        aria-label="取消编辑"
                        onClick={() => setEditingTag(null)}
                      >
                        <X className="h-4 w-4 text-ink-faint" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">
                        {tag.name}
                      </span>
                      <span className="text-xs text-ink-faint">
                        {tag.assetCount ?? 0}
                      </span>
                      {tag.sourceType === "user" ? (
                        <>
                          <button
                            type="button"
                            aria-label="编辑标签"
                            onClick={() => {
                              setEditingTag(tag.id);
                              setTagDraft(tag.name);
                            }}
                          >
                            <Pencil className="h-4 w-4 text-ink-soft" />
                          </button>
                          <button
                            type="button"
                            aria-label="删除标签"
                            disabled={busy !== ""}
                            onClick={() => deleteTag(tag)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </button>
                        </>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-ink-faint">
                          内置
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      {confirmDialog}
    </div>
  );
}
