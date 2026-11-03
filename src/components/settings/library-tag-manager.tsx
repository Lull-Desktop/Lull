// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 「曲库整理」标签管理卡片：标签 CRUD 与标签↔曲目关联编辑。
 *
 * 只通过 `@lull/media-sdk` 的 `library.*` 访问 Media Service；标签列表与计数
 * 由父面板统一加载，本卡片负责选中标签、成员列表与候选曲目搜索。
 */
"use client";

import type { LullMediaClient, TagView, TrackSummary } from "@lull/media-sdk";
import { Check, Pencil, Plus, Tags, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

/** 成员列表单页大小；SDK/后端把 pageSize 夹在 1–200。 */
const MEMBER_PAGE_SIZE = 100;
/** 候选曲目单页大小。 */
const PICKER_PAGE_SIZE = 50;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackTagIds(track: TrackSummary): string[] {
  return (track.tags ?? []).map((tag) => tag.id);
}

type LibraryTagManagerProps = {
  client: LullMediaClient;
  /** 父面板加载的标签与计数；本卡片不重复拉取标签列表。 */
  tags: TagView[];
  /** 父面板数据版本；变化时重新拉取成员与候选曲目。 */
  revision: number;
  /** 操作成功后让父面板刷新标签计数与曲目标签。 */
  onChanged: () => void;
};

export function LibraryTagManager({
  client,
  tags,
  revision,
  onChanged,
}: LibraryTagManagerProps) {
  const { confirm, dialog } = useConfirmDialog();
  const [activeTagId, setActiveTagId] = useState("");
  const [newName, setNewName] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [renamingTagId, setRenamingTagId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [memberKeyword, setMemberKeyword] = useState("");
  const [members, setMembers] = useState<TrackSummary[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberPage, setMemberPage] = useState(1);
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberLoadingMore, setMemberLoadingMore] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [pickerKeyword, setPickerKeyword] = useState("");
  const [pickerItems, setPickerItems] = useState<TrackSummary[]>([]);
  const [pickerTotal, setPickerTotal] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const memberGenerationRef = useRef(0);

  const activeTag = useMemo(
    () => tags.find((tag) => tag.id === activeTagId) ?? null,
    [activeTagId, tags],
  );

  const visibleTags = useMemo(() => {
    const needle = tagFilter.trim().toLowerCase();
    if (!needle) return tags;
    return tags.filter((tag) => tag.name.toLowerCase().includes(needle));
  }, [tagFilter, tags]);

  // 标签被删除或外部刷新后，保证选中项仍然有效；首次加载自动选第一个。
  useEffect(() => {
    setActiveTagId((current) =>
      tags.some((tag) => tag.id === current) ? current : (tags[0]?.id ?? ""),
    );
  }, [tags]);

  // 正在内联重命名的标签被外部删除时退出编辑态。
  useEffect(() => {
    if (renamingTagId && !tags.some((tag) => tag.id === renamingTagId)) {
      setRenamingTagId("");
    }
  }, [renamingTagId, tags]);

  // 成员筛选与候选搜索都做防抖，避免每个按键都打一次 Media Service。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMemberKeyword(memberFilter.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [memberFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPickerKeyword(pickerFilter.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pickerFilter]);

  // 切换标签时立即清空上一标签的成员，避免短暂显示错标签的数据。
  useEffect(() => {
    // activeTagId 只是切换触发器；读取一次避免 lint 把它当成多余依赖。
    void activeTagId;
    memberGenerationRef.current += 1;
    setMembers([]);
    setMemberTotal(0);
    setMemberPage(1);
    setMemberLoadingMore(false);
  }, [activeTagId]);

  useEffect(() => {
    if (!activeTagId) {
      setMembers([]);
      setMemberTotal(0);
      setMemberPage(1);
      setMemberLoading(false);
      return;
    }
    // revision 只是刷新触发器；读取一次避免 lint 把它当成多余依赖。
    void revision;
    const generation = memberGenerationRef.current + 1;
    memberGenerationRef.current = generation;
    let alive = true;
    setMemberLoading(true);
    void client.library
      .listTracks({
        tagId: activeTagId,
        keyword: memberKeyword || undefined,
        includeUnavailable: true,
        page: 1,
        pageSize: MEMBER_PAGE_SIZE,
      })
      .then((page) => {
        if (!alive || generation !== memberGenerationRef.current) return;
        setMembers(page.items);
        setMemberTotal(page.total);
        setMemberPage(1);
      })
      .catch((reason: unknown) => {
        if (alive && generation === memberGenerationRef.current) {
          setError(`读取标签曲目失败：${errorText(reason)}`);
        }
      })
      .finally(() => {
        if (alive && generation === memberGenerationRef.current) {
          setMemberLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [activeTagId, client, memberKeyword, revision]);

  useEffect(() => {
    if (!activeTagId || !pickerKeyword) {
      setPickerItems([]);
      setPickerTotal(0);
      setPickerLoading(false);
      return;
    }
    // 同上：父面板刷新后候选曲目的“已加入”状态需要跟着更新。
    void revision;
    let alive = true;
    setPickerLoading(true);
    void client.library
      .listTracks({
        keyword: pickerKeyword,
        page: 1,
        pageSize: PICKER_PAGE_SIZE,
      })
      .then((page) => {
        if (!alive) return;
        setPickerItems(page.items);
        setPickerTotal(page.total);
      })
      .catch((reason: unknown) => {
        if (alive) setError(`搜索曲目失败：${errorText(reason)}`);
      })
      .finally(() => {
        if (alive) setPickerLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeTagId, client, pickerKeyword, revision]);

  const run = async (
    label: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(`${label}成功`);
      onChanged();
      return true;
    } catch (reason) {
      setError(`${label}失败：${errorText(reason)}`);
      return false;
    } finally {
      setBusy("");
    }
  };

  const selectTag = (tagId: string): void => {
    setActiveTagId(tagId);
    setMemberFilter("");
    setMemberKeyword("");
    setPickerFilter("");
    setPickerKeyword("");
  };

  const createTag = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || busy) return;
    await run("创建标签", async () => {
      const tag = await client.library.createTag(name);
      setNewName("");
      setTagFilter("");
      setActiveTagId(tag.id);
    });
  };

  const startRename = (tag: TagView): void => {
    setRenamingTagId(tag.id);
    setRenameDraft(tag.name);
  };

  const saveRename = async (tag: TagView): Promise<void> => {
    const name = renameDraft.trim();
    if (!name || busy) return;
    if (name === tag.name) {
      setRenamingTagId("");
      return;
    }
    const saved = await run("重命名标签", () =>
      client.library.renameTag(tag.id, name),
    );
    if (saved) setRenamingTagId("");
  };

  const deleteTag = (tag: TagView): void => {
    if (busy) return;
    void confirm({
      title: "删除标签",
      description: `删除标签「${tag.name}」？将移除 ${tag.trackCount} 首曲目的标签关联，曲目本身不会删除。`,
      confirmLabel: "删除",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void run("删除标签", async () => {
        await client.library.deleteTag(tag.id);
        setRenamingTagId((current) => (current === tag.id ? "" : current));
        setActiveTagId((current) => (current === tag.id ? "" : current));
      });
    });
  };

  const addTrack = async (track: TrackSummary): Promise<void> => {
    if (!activeTagId || busy) return;
    const next = Array.from(new Set([...trackTagIds(track), activeTagId]));
    await run("加入标签", () => client.library.setTrackTags(track.id, next));
  };

  const removeTrack = async (track: TrackSummary): Promise<void> => {
    if (!activeTagId || busy) return;
    const next = trackTagIds(track).filter((id) => id !== activeTagId);
    await run("移出标签", () => client.library.setTrackTags(track.id, next));
  };

  const loadMoreMembers = async (): Promise<void> => {
    if (!activeTagId || busy || memberLoadingMore) return;
    if (members.length >= memberTotal) return;
    const generation = memberGenerationRef.current;
    const nextPage = memberPage + 1;
    setMemberLoadingMore(true);
    try {
      const page = await client.library.listTracks({
        tagId: activeTagId,
        keyword: memberKeyword || undefined,
        includeUnavailable: true,
        page: nextPage,
        pageSize: MEMBER_PAGE_SIZE,
      });
      if (generation !== memberGenerationRef.current) return;
      setMembers((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [
          ...previous,
          ...page.items.filter((item) => !seen.has(item.id)),
        ];
      });
      setMemberTotal(page.total);
      setMemberPage(nextPage);
    } catch (reason) {
      setError(`加载更多标签曲目失败：${errorText(reason)}`);
    } finally {
      setMemberLoadingMore(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tags className="h-4 w-4" aria-hidden="true" />
            标签管理
          </CardTitle>
          <CardDescription>
            创建、重命名、删除标签，并编辑标签下的曲目；删除只移除关联。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="min-w-0 space-y-2">
              <div className="flex gap-2">
                <input
                  aria-label="新标签名称"
                  className="min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                  placeholder="新标签名称（1–40 字）"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createTag();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy !== "" || !newName.trim()}
                  onClick={() => void createTag()}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  创建标签
                </Button>
              </div>
              <input
                type="search"
                aria-label="筛选标签"
                className="w-full rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                placeholder="筛选标签"
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
              />
              <div className="max-h-72 divide-y divide-paper-deep/50 overflow-auto rounded-md border border-paper-deep/60">
                {visibleTags.map((tag) => (
                  <div
                    key={tag.id}
                    className={cn(
                      "flex items-center gap-1 px-2 py-1.5 text-xs",
                      tag.id === activeTagId && "bg-accent/10",
                    )}
                  >
                    {renamingTagId === tag.id ? (
                      <>
                        <input
                          aria-label="编辑标签名称"
                          className="h-7 min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 text-sm text-ink outline-none focus:border-accent"
                          value={renameDraft}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveRename(tag);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setRenamingTagId("");
                            }
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          aria-label="保存标签名称"
                          disabled={busy !== "" || !renameDraft.trim()}
                          onClick={() => void saveRename(tag)}
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          aria-label="取消编辑标签"
                          onClick={() => setRenamingTagId("")}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-pressed={tag.id === activeTagId}
                          aria-label={`选择标签 ${tag.name}`}
                          className="min-w-0 flex-1 truncate text-left text-ink-soft hover:text-ink"
                          onClick={() => selectTag(tag.id)}
                        >
                          {tag.name}
                          <span className="ml-2 text-ink-faint">
                            {tag.trackCount} 首
                          </span>
                        </button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          aria-label={`重命名标签 ${tag.name}`}
                          disabled={busy !== ""}
                          onClick={() => startRename(tag)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px] text-destructive"
                          aria-label={`删除标签 ${tag.name}`}
                          disabled={busy !== ""}
                          onClick={() => deleteTag(tag)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
                {visibleTags.length === 0 ? (
                  <p className="py-6 text-center text-xs text-ink-faint">
                    {tags.length === 0 ? "还没有标签" : "没有匹配的标签"}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="min-w-0 space-y-2 rounded-lg border border-paper-deep/60 p-3">
              {activeTag ? (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-medium text-ink">
                      「{activeTag.name}」的曲目
                    </p>
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {activeTag.trackCount} 首
                    </span>
                  </div>
                  <input
                    type="search"
                    aria-label="筛选标签曲目"
                    className="w-full rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                    placeholder={`筛选「${activeTag.name}」下的曲目`}
                    value={memberFilter}
                    onChange={(event) => setMemberFilter(event.target.value)}
                  />
                  <div className="max-h-56 divide-y divide-paper-deep/40 overflow-auto rounded-md border border-paper-deep/50">
                    {memberLoading && members.length === 0 ? (
                      <p className="py-6 text-center text-xs text-ink-faint">
                        加载中…
                      </p>
                    ) : members.length === 0 ? (
                      <p className="py-6 text-center text-xs text-ink-faint">
                        该标签下还没有曲目
                      </p>
                    ) : (
                      members.map((track) => (
                        <div
                          key={track.id}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {track.title}
                            <span className="ml-2 text-ink-faint">
                              {track.artists.join(", ") || "—"}
                            </span>
                            {track.available ? null : (
                              <span className="ml-2 text-destructive">
                                不可用
                              </span>
                            )}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                            aria-label={`从标签移除 ${track.title}`}
                            disabled={busy !== ""}
                            onClick={() => void removeTrack(track)}
                          >
                            移除
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                  {members.length < memberTotal ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={busy !== "" || memberLoadingMore}
                      onClick={() => void loadMoreMembers()}
                    >
                      {memberLoadingMore
                        ? "加载中…"
                        : `加载更多（${members.length}/${memberTotal}）`}
                    </Button>
                  ) : null}
                  <div className="space-y-1 border-t border-paper-deep/50 pt-2">
                    <p className="text-[11px] text-ink-soft">添加曲目</p>
                    <input
                      type="search"
                      aria-label="搜索要加入标签的曲目"
                      className="w-full rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      placeholder="输入关键词搜索曲目"
                      value={pickerFilter}
                      onChange={(event) => setPickerFilter(event.target.value)}
                    />
                    {pickerKeyword ? (
                      <div className="max-h-40 divide-y divide-paper-deep/40 overflow-auto rounded-md border border-paper-deep/50">
                        {pickerLoading ? (
                          <p className="py-4 text-center text-xs text-ink-faint">
                            搜索中…
                          </p>
                        ) : pickerItems.length === 0 ? (
                          <p className="py-4 text-center text-xs text-ink-faint">
                            没有匹配的曲目
                          </p>
                        ) : (
                          pickerItems.map((track) => {
                            const tagged =
                              trackTagIds(track).includes(activeTagId);
                            return (
                              <div
                                key={track.id}
                                className="flex items-center gap-2 px-2 py-1.5 text-xs"
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {track.title}
                                  <span className="ml-2 text-ink-faint">
                                    {track.artists.join(", ") || "—"}
                                  </span>
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={tagged ? "ghost" : "secondary"}
                                  className="h-7 px-2 text-[11px]"
                                  aria-label={
                                    tagged
                                      ? `${track.title} 已在标签中`
                                      : `将 ${track.title} 加入标签`
                                  }
                                  disabled={busy !== "" || tagged}
                                  onClick={() => void addTrack(track)}
                                >
                                  {tagged ? "已添加" : "添加"}
                                </Button>
                              </div>
                            );
                          })
                        )}
                        {pickerTotal > pickerItems.length ? (
                          <p className="px-2 py-1 text-[10px] text-ink-faint">
                            仅显示前 {pickerItems.length} 个结果，请细化关键词。
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-[11px] text-ink-faint">
                        输入关键词后显示候选曲目。
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="py-10 text-center text-xs text-ink-faint">
                  选择一个标签，查看并编辑它下面的曲目。
                </p>
              )}
            </div>
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          {notice ? (
            <p
              aria-live="polite"
              className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-soft"
            >
              {notice}
            </p>
          ) : null}
          {busy ? (
            <p className="text-xs text-ink-faint">执行中：{busy}</p>
          ) : null}
        </CardContent>
      </Card>
      {dialog}
    </>
  );
}
