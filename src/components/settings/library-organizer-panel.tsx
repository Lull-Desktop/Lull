/**
 * 设置页「曲库整理」调试面板：直接驱动 @lull/media-sdk 的 P4 编辑能力。
 *
 * 这是开发验收面板，不是资料库正式 UI；覆盖元数据覆盖、标签、实体合并/拆分、
 * 智能歌单，以及每一步的原始返回，方便手工核对 Rust 行为。
 */
"use client";

import type {
  AlbumSummary,
  ArtistSummary,
  LullMediaClient,
  SmartPlaylistView,
  TagView,
  TrackSummary,
} from "@lull/media-sdk";
import {
  ListMusic,
  Merge,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Tags,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CoverPreview } from "@/components/library/cover-preview";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getMediaClient } from "@/hooks/use-media-client";
import { cn } from "@/lib/utils";

type Draft = {
  title: string;
  artists: string;
  album: string;
  genre: string;
  year: string;
};

type LogEntry = {
  id: number;
  at: number;
  label: string;
  data: unknown;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function draftOf(track: TrackSummary): Draft {
  return {
    title: track.title,
    artists: track.artists.join(", "),
    album: track.album ?? "",
    genre: track.genre ?? "",
    year: track.year ? String(track.year) : "",
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="grid gap-1 text-[11px] text-ink-soft">
      {label}
      <input
        className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-[11px] text-ink-soft">
      {label}
      <select
        className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

export function LibraryOrganizerPanel({
  client: providedClient,
}: {
  /** 测试/嵌入时注入；不传则使用官方 Tauri 单例。 */
  client?: LullMediaClient;
} = {}) {
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [version, setVersion] = useState(0);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [trackTotal, setTrackTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tags, setTags] = useState<TagView[]>([]);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [smartPlaylists, setSmartPlaylists] = useState<SmartPlaylistView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [artistSource, setArtistSource] = useState("");
  const [artistTarget, setArtistTarget] = useState("");
  const [albumSource, setAlbumSource] = useState("");
  const [albumTarget, setAlbumTarget] = useState("");
  const [splitArtistId, setSplitArtistId] = useState("");
  const [splitArtistName, setSplitArtistName] = useState("");
  const [splitAlbumId, setSplitAlbumId] = useState("");
  const [splitAlbumTitle, setSplitAlbumTitle] = useState("");
  const [splitTrackIds, setSplitTrackIds] = useState<string[]>([]);
  const trackListRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const queryGenerationRef = useRef(0);
  const [smartName, setSmartName] = useState("测试智能歌单");
  const [smartGenre, setSmartGenre] = useState("");
  const [smartFavorite, setSmartFavorite] = useState(false);
  const [smartSelected, setSmartSelected] = useState("");
  const [smartTracks, setSmartTracks] = useState<TrackSummary[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);

  const push = useCallback((label: string, data: unknown): void => {
    const id = logSeq.current + 1;
    logSeq.current = id;
    setLog((previous) =>
      [{ id, at: Date.now(), label, data }, ...previous].slice(0, 30),
    );
  }, []);

  const bump = useCallback((): void => {
    setVersion((value) => value + 1);
  }, []);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      options: { refresh?: boolean } = {},
    ): Promise<void> => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        const result = await action();
        push(label, result);
        setNotice(`${label} 成功`);
        if (options.refresh !== false) bump();
      } catch (reason) {
        setError(`${label} 失败：${errorText(reason)}`);
        push(`${label} error`, { message: errorText(reason) });
      } finally {
        setBusy("");
      }
    },
    [bump, push],
  );

  useEffect(() => {
    if (providedClient) {
      setClient(providedClient);
      return;
    }
    setClient(getMediaClient());
  }, [providedClient]);

  useEffect(() => {
    if (!client) return;
    void version;
    let alive = true;
    const generation = queryGenerationRef.current + 1;
    queryGenerationRef.current = generation;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    void Promise.all([
      client.library.listTags(),
      client.library.listArtists(),
      client.library.listAlbums(),
      client.library.listSmartPlaylists(),
      client.library.listTracks({
        keyword: searchKeyword.trim() || undefined,
        page: 1,
        pageSize: 200,
      }),
    ])
      .then(([nextTags, nextArtists, nextAlbums, nextSmart, page]) => {
        if (!alive || generation !== queryGenerationRef.current) return;
        pageRef.current = 1;
        setTrackTotal(page.total);
        setTags(nextTags);
        setArtists(nextArtists);
        setAlbums(nextAlbums);
        setSmartPlaylists(nextSmart);
        setTracks(page.items);
        setArtistSource((value) => value || nextArtists[0]?.id || "");
        setArtistTarget((value) => value || nextArtists[1]?.id || "");
        setAlbumSource((value) => value || nextAlbums[0]?.id || "");
        setAlbumTarget((value) => value || nextAlbums[1]?.id || "");
        setSplitArtistId((value) => value || nextArtists[0]?.id || "");
        setSplitAlbumId((value) => value || nextAlbums[0]?.id || "");
        setSmartSelected((value) =>
          nextSmart.some((playlist) => playlist.id === value)
            ? value
            : (nextSmart[0]?.id ?? ""),
        );
        setSelectedId((value) => value || page.items[0]?.id || "");
      })
      .catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [client, searchKeyword, version]);

  const loadMoreTracks = useCallback(async (): Promise<void> => {
    if (
      !client ||
      loadingMoreRef.current ||
      tracks.length >= trackTotal
    ) {
      return;
    }
    const generation = queryGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    try {
      const next = await client.library.listTracks({
        keyword: searchKeyword.trim() || undefined,
        page: nextPage,
        pageSize: 200,
      });
      if (generation !== queryGenerationRef.current) return;
      pageRef.current = nextPage;
      setTrackTotal(next.total);
      setTracks((previous) => {
        const seen = new Set(previous.map((track) => track.id));
        return [
          ...previous,
          ...next.items.filter((track) => !seen.has(track.id)),
        ];
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      if (generation === queryGenerationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [client, searchKeyword, trackTotal, tracks.length]);

  const onTrackListScroll = useCallback((): void => {
    const list = trackListRef.current;
    if (!list || tracks.length >= trackTotal) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) {
      void loadMoreTracks();
    }
  }, [loadMoreTracks, trackTotal, tracks.length]);

  const selected = useMemo(
    () => tracks.find((track) => track.id === selectedId) ?? null,
    [selectedId, tracks],
  );

  useEffect(() => {
    if (!selected) {
      setDraft(null);
      setSelectedTagIds([]);
      return;
    }
    setDraft(draftOf(selected));
    setSelectedTagIds((selected.tags ?? []).map((tag) => tag.id));
  }, [selected]);

  const saveMetadata = (): void => {
    if (!client || !selected || !draft) return;
    const parsedYear = Number.parseInt(draft.year, 10);
    const nextArtists = draft.artists
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const nextAlbum = draft.album.trim();
    const nextGenre = draft.genre.trim();
    const patch: {
      trackId: string;
      title?: string;
      artists?: string[];
      album?: string | null;
      genre?: string | null;
      year?: number | null;
    } = { trackId: selected.id };
    if (draft.title.trim() !== selected.title) patch.title = draft.title.trim();
    if (
      [...nextArtists].sort().join("\u001f") !==
      [...selected.artists].sort().join("\u001f")
    ) {
      patch.artists = nextArtists;
    }
    if (nextAlbum !== (selected.album ?? "")) patch.album = nextAlbum || null;
    if (nextGenre !== (selected.genre ?? "")) patch.genre = nextGenre || null;
    const nextYear = Number.isFinite(parsedYear) ? parsedYear : null;
    if (nextYear !== (selected.year ?? null)) patch.year = nextYear;

    void run("updateTrackMetadata", async () => {
      const metadataChanged =
        patch.title !== undefined ||
        patch.artists !== undefined ||
        patch.album !== undefined ||
        patch.genre !== undefined ||
        patch.year !== undefined;
      const updated = metadataChanged
        ? await client.library.updateTrackMetadata(patch)
        : selected;
      await client.library.setTrackTags(selected.id, selectedTagIds);
      return updated;
    });
  };

  const createTag = (): void => {
    if (!client || !newTag.trim()) return;
    void run(
      "createTag",
      async () => {
        const tag = await client.library.createTag(newTag.trim());
        setNewTag("");
        setTags((current) => [...current, tag]);
        setSelectedTagIds((current) => [...current, tag.id]);
        return tag;
      },
      { refresh: false },
    );
  };

  const renameTag = (tag: TagView): void => {
    if (!client) return;
    const name = window.prompt("新标签名", tag.name);
    if (!name || name.trim() === tag.name) return;
    void run("renameTag", () => client.library.renameTag(tag.id, name.trim()));
  };

  const deleteTag = (tag: TagView): void => {
    if (!client) return;
    if (!window.confirm(`删除标签「${tag.name}」？只会移除关联。`)) return;
    void run("deleteTag", () => client.library.deleteTag(tag.id));
  };

  const mergeArtist = (): void => {
    if (!client || !artistSource || !artistTarget) return;
    if (!window.confirm("合并艺术家会迁移其全部曲目关系，确认继续？")) return;
    void run("mergeArtists", () =>
      client.library.mergeArtists(artistSource, artistTarget),
    );
  };

  const splitArtist = (): void => {
    if (!client || !splitArtistId || !splitArtistName.trim()) return;
    if (!window.confirm(`把选中的 ${splitTrackIds.length} 首拆到新艺术家？`)) {
      return;
    }
    void run("splitArtist", () =>
      client.library.splitArtist(
        splitArtistId,
        splitTrackIds,
        splitArtistName.trim(),
      ),
    );
  };

  const mergeAlbum = (): void => {
    if (!client || !albumSource || !albumTarget) return;
    if (!window.confirm("合并专辑会迁移其全部曲目关系，确认继续？")) return;
    void run("mergeAlbums", () =>
      client.library.mergeAlbums(albumSource, albumTarget),
    );
  };

  const splitAlbum = (): void => {
    if (!client || !splitAlbumId || !splitAlbumTitle.trim()) return;
    if (!window.confirm(`把选中的 ${splitTrackIds.length} 首拆到新专辑？`)) {
      return;
    }
    void run("splitAlbum", () =>
      client.library.splitAlbum(
        splitAlbumId,
        splitTrackIds,
        splitAlbumTitle.trim(),
      ),
    );
  };

  const createSmart = (): void => {
    if (!client || !smartName.trim()) return;
    void run("createSmartPlaylist", () =>
      client.library.createSmartPlaylist(
        smartName.trim(),
        {
          genre: smartGenre.trim() || undefined,
          favoriteOnly: smartFavorite || undefined,
          pageSize: 100,
        },
        "设置页曲库整理测试",
      ),
    );
  };

  const runSmart = (): void => {
    if (!client || !smartSelected) return;
    void run("runSmartPlaylist", async () => {
      const page = await client.library.runSmartPlaylist(smartSelected, {
        pageSize: 100,
      });
      setSmartTracks(page.items);
      return page;
    });
  };

  const deleteSmart = (): void => {
    if (!client || !smartSelected) return;
    void run("deleteSmartPlaylist", async () => {
      await client.library.deleteSmartPlaylist(smartSelected);
      setSmartTracks([]);
      return { deleted: true };
    });
  };

  const toggleSplitTrack = (trackId: string): void => {
    setSplitTrackIds((current) =>
      current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current, trackId],
    );
  };

  if (!client) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-ink-faint">
          正在连接 Media Service…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>曲库整理测试</CardTitle>
            <CardDescription>
              通过 @lull/media-sdk 驱动 P4：元数据覆盖、标签、实体合并/拆分、智能歌单。
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== ""}
            onClick={bump}
          >
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
            刷新
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <Field
                label="搜索曲目"
                value={keyword}
                placeholder="标题 / 艺术家 / 专辑 / 文件名"
                onChange={setKeyword}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setSearchKeyword(keyword)}
            >
              <Search className="mr-1 h-4 w-4" aria-hidden="true" />
              搜索
            </Button>
          </div>
          <div
            ref={trackListRef}
            onScroll={onTrackListScroll}
            className="grid max-h-64 gap-1 overflow-auto rounded-lg border border-paper-deep/60 bg-paper-warm/40 p-2"
          >
            {tracks.map((track) => (
              <button
                key={track.id}
                type="button"
                aria-label={`选择曲目 ${track.title}`}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm",
                  track.id === selectedId
                    ? "bg-accent/15 text-ink"
                    : "text-ink-soft hover:bg-paper-deep/30",
                )}
                onClick={() => {
                  setSelectedId(track.id);
                  setSplitTrackIds((current) =>
                    current.includes(track.id) ? current : [...current, track.id],
                  );
                }}
              >
                <span className="min-w-0 truncate">
                  {track.title}
                  <span className="ml-2 text-xs text-ink-faint">
                    {track.artists.join(", ") || "—"}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-ink-faint">
                  {track.tags?.length ? `#${track.tags.map((tag) => tag.name).join(" #")}` : ""}
                </span>
              </button>
            ))}
            {tracks.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-faint">没有曲目</p>
            ) : null}
            {tracks.length > 0 && tracks.length < trackTotal ? (
              <p
                className="py-2 text-center text-[11px] text-ink-faint"
                aria-live="polite"
              >
                {loadingMore
                  ? "加载中…"
                  : `继续下滑加载更多（${tracks.length}/${trackTotal}）`}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Save className="h-4 w-4" aria-hidden="true" />
              元数据覆盖
            </CardTitle>
            <CardDescription>
              {selected ? selected.title : "先选择一条曲目"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {draft && selected ? (
              <>
                <div className="flex items-start gap-3">
                  <CoverPreview client={client} track={selected} className="w-20" />
                  <p className="flex-1 text-[11px] leading-relaxed text-ink-faint">
                    封面来自内嵌标签或文件夹，读取通过 `library.getCoverUrl`；
                    当前 SDK 没有用户上传/替换封面的保存方法。
                  </p>
                </div>
                <Field
                  label="标题"
                  value={draft.title}
                  onChange={(title) => setDraft({ ...draft, title })}
                />
                <Field
                  label="艺术家（逗号分隔）"
                  value={draft.artists}
                  onChange={(artists) => setDraft({ ...draft, artists })}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label="专辑"
                    value={draft.album}
                    onChange={(album) => setDraft({ ...draft, album })}
                  />
                  <Field
                    label="流派"
                    value={draft.genre}
                    onChange={(genre) => setDraft({ ...draft, genre })}
                  />
                  <Field
                    label="年份"
                    value={draft.year}
                    onChange={(year) => setDraft({ ...draft, year })}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] text-ink-soft">标签</p>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        aria-pressed={selectedTagIds.includes(tag.id)}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[11px]",
                          selectedTagIds.includes(tag.id)
                            ? "border-accent bg-accent/15 text-ink"
                            : "border-paper-deep/70 text-ink-faint",
                        )}
                        onClick={() =>
                          setSelectedTagIds((current) =>
                            current.includes(tag.id)
                              ? current.filter((id) => id !== tag.id)
                              : [...current, tag.id],
                          )
                        }
                      >
                        {tag.name} · {tag.trackCount}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                      placeholder="新标签"
                      value={newTag}
                      onChange={(event) => setNewTag(event.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!newTag.trim()}
                      onClick={createTag}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      新建
                    </Button>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== ""}
                  onClick={saveMetadata}
                >
                  <Save className="mr-1 h-4 w-4" aria-hidden="true" />
                  保存元数据与标签
                </Button>
              </>
            ) : (
              <p className="py-8 text-center text-xs text-ink-faint">
                选择曲目后编辑标题、艺术家、专辑、流派、年份与标签。
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tags className="h-4 w-4" aria-hidden="true" />
              标签管理
            </CardTitle>
            <CardDescription>创建、重命名、删除；删除只移除关联。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {tags.map((tag) => (
              <div
                key={tag.id}
                className="flex items-center justify-between gap-2 rounded-md border border-paper-deep/50 px-2 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate">
                  {tag.name}
                  <span className="ml-2 text-ink-faint">{tag.trackCount} 首</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => renameTag(tag)}
                  >
                    重命名
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-destructive"
                    onClick={() => deleteTag(tag)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </span>
              </div>
            ))}
            {tags.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-faint">还没有标签</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Merge className="h-4 w-4" aria-hidden="true" />
            实体合并 / 拆分
          </CardTitle>
          <CardDescription>
            先勾选曲目，再选择源实体执行拆分；合并会保留 merged_into_id 与别名。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-paper-deep/60 p-3">
            <p className="text-xs font-medium text-ink">艺术家</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                label="合并源"
                value={artistSource}
                onChange={setArtistSource}
              >
                {artists.map((artist) => (
                  <option key={artist.id} value={artist.id}>
                    {artist.name}
                  </option>
                ))}
              </Select>
              <Select
                label="合并到"
                value={artistTarget}
                onChange={setArtistTarget}
              >
                {artists.map((artist) => (
                  <option key={artist.id} value={artist.id}>
                    {artist.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== "" || !artistSource || !artistTarget}
              onClick={mergeArtist}
            >
              合并艺术家
            </Button>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                label="拆分源艺术家"
                value={splitArtistId}
                onChange={setSplitArtistId}
              >
                {artists.map((artist) => (
                  <option key={artist.id} value={artist.id}>
                    {artist.name}
                  </option>
                ))}
              </Select>
              <Field
                label="新艺术家名"
                value={splitArtistName}
                onChange={setSplitArtistName}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                busy !== "" ||
                !splitArtistId ||
                !splitArtistName.trim() ||
                splitTrackIds.length === 0
              }
              onClick={splitArtist}
            >
              <Scissors className="mr-1 h-4 w-4" aria-hidden="true" />
              拆分选中曲目（{splitTrackIds.length}）
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-paper-deep/60 p-3">
            <p className="text-xs font-medium text-ink">专辑</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select label="合并源" value={albumSource} onChange={setAlbumSource}>
                {albums.map((album) => (
                  <option key={album.id} value={album.id}>
                    {album.title}
                  </option>
                ))}
              </Select>
              <Select label="合并到" value={albumTarget} onChange={setAlbumTarget}>
                {albums.map((album) => (
                  <option key={album.id} value={album.id}>
                    {album.title}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== "" || !albumSource || !albumTarget}
              onClick={mergeAlbum}
            >
              合并专辑
            </Button>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                label="拆分源专辑"
                value={splitAlbumId}
                onChange={setSplitAlbumId}
              >
                {albums.map((album) => (
                  <option key={album.id} value={album.id}>
                    {album.title}
                  </option>
                ))}
              </Select>
              <Field
                label="新专辑名"
                value={splitAlbumTitle}
                onChange={setSplitAlbumTitle}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                busy !== "" ||
                !splitAlbumId ||
                !splitAlbumTitle.trim() ||
                splitTrackIds.length === 0
              }
              onClick={splitAlbum}
            >
              <Scissors className="mr-1 h-4 w-4" aria-hidden="true" />
              拆分选中曲目（{splitTrackIds.length}）
            </Button>
          </div>

          <div className="xl:col-span-2">
            <p className="mb-1 text-[11px] text-ink-soft">
              拆分目标曲目（从上方列表勾选）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {tracks.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  aria-label={`拆分目标 ${track.title}`}
                  aria-pressed={splitTrackIds.includes(track.id)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px]",
                    splitTrackIds.includes(track.id)
                      ? "border-accent bg-accent/15 text-ink"
                      : "border-paper-deep/60 text-ink-faint",
                  )}
                  onClick={() => toggleSplitTrack(track.id)}
                >
                  {track.title}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              智能歌单
            </CardTitle>
            <CardDescription>
              规则保存为 TrackQuery，运行时实时查询。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
              <Field label="名称" value={smartName} onChange={setSmartName} />
              <Field label="流派（可选）" value={smartGenre} onChange={setSmartGenre} />
              <label className="flex items-center gap-1.5 pt-5 text-[11px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={smartFavorite}
                  onChange={(event) => setSmartFavorite(event.target.checked)}
                />
                仅喜欢
              </label>
              <Button
                type="button"
                size="sm"
                className="mt-5"
                disabled={busy !== "" || !smartName.trim()}
                onClick={createSmart}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                创建
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] flex-1">
                <Select
                  label="智能歌单"
                  value={smartSelected}
                  onChange={setSmartSelected}
                >
                  {smartPlaylists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy !== "" || !smartSelected}
                onClick={runSmart}
              >
                运行
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={busy !== "" || !smartSelected}
                onClick={deleteSmart}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                删除
              </Button>
            </div>
            <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-paper-deep/50 p-2">
              {smartTracks.map((track) => (
                <div key={track.id} className="truncate text-xs text-ink-soft">
                  {track.title}
                  <span className="ml-2 text-ink-faint">
                    {track.artists.join(", ")}
                  </span>
                </div>
              ))}
              {smartTracks.length === 0 ? (
                <p className="py-4 text-center text-xs text-ink-faint">
                  运行后显示匹配曲目
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">调用结果</CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLog([])}
            >
              清空
            </Button>
          </CardHeader>
          <CardContent className="max-h-96 space-y-2 overflow-auto">
            {log.map((entry) => (
              <div
                key={entry.id}
                className="rounded-md border border-paper-deep/50 bg-paper-warm/40 p-2"
              >
                <p className="text-[11px] text-ink-soft">
                  {new Date(entry.at).toLocaleTimeString()} · {entry.label}
                </p>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] text-ink-faint">
                  {json(entry.data)}
                </pre>
              </div>
            ))}
            {log.length === 0 ? (
              <p className="py-8 text-center text-xs text-ink-faint">
                操作后显示 SDK 原始返回
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-soft">
          {notice}
        </p>
      ) : null}
      {busy ? <p className="text-xs text-ink-faint">执行中：{busy}</p> : null}
      <div className="flex items-center gap-2 text-xs text-ink-faint">
        <ListMusic className="h-3.5 w-3.5" aria-hidden="true" />
        调试面板，不替代资料库正式界面。
      </div>
    </div>
  );
}
