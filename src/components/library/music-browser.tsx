/**
 * 设置窗「音乐」页签里的曲库浏览：一组带标签的二级分类 + 单个内容区。
 *
 * 分类来自原音乐库窗口的六个页签（全部歌曲 / 我的收藏 / 队列 / 歌单 / 最近添加 /
 * 最近播放），音乐库窗口现在只保留目录、智能歌单与两个工具页签。
 *
 * 高度契约：根是 `flex min-h-0 flex-1 flex-col`，分类行 `shrink-0` 自身限高可滚，
 * 内容区 `min-h-0 flex-1 overflow-y-auto` 是**唯一**滚动条——所以列表再长也不会
 * 把设置窗撑高或顶出卡片。
 */
"use client";

import type {
  AlbumSummary,
  ArtistSummary,
  HistoryEntry,
  LullMediaClient,
  PlayerState,
  PlaylistDetail,
  PlaylistSummary,
  QueueState,
  TrackQuery,
  TrackSummary,
} from "@lull/media-sdk";
import {
  Clock,
  Download,
  Heart,
  History,
  Import,
  ListMusic,
  ListOrdered,
  type LucideIcon,
  Music,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlaylistTracks } from "@/components/library/playlist-tracks";
import { TrackList } from "@/components/library/track-list";
import { Button } from "@/components/ui/button";
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export type MusicCategory =
  | "tracks"
  | "favorites"
  | "queue"
  | "playlists"
  | "recent"
  | "history";

/** 分类顺序与设置页要求一致；文案沿用音乐库窗口的既有键。 */
const CATEGORIES: {
  id: MusicCategory;
  label: () => string;
  icon: LucideIcon;
}[] = [
  { id: "tracks", label: m.library_tracks, icon: Music },
  { id: "favorites", label: m.library_favorites, icon: Heart },
  { id: "queue", label: m.library_queue, icon: ListOrdered },
  { id: "playlists", label: m.library_playlists, icon: ListMusic },
  { id: "recent", label: m.library_recent_added, icon: Clock },
  { id: "history", label: m.library_history, icon: History },
];

/** 外部定位（播放器齿轮等）只认这些分类 id。 */
export function isMusicCategory(value: string): value is MusicCategory {
  return CATEGORIES.some((item) => item.id === value);
}

/** 「全部歌曲」的索引筛选；字段与 Media SDK 的 TrackQuery 对齐。 */
type TrackFilters = {
  artistId: string;
  albumId: string;
  genre: string;
  format: string;
  year: string;
};

const EMPTY_TRACK_FILTERS: TrackFilters = {
  artistId: "",
  albumId: "",
  genre: "",
  format: "",
  year: "",
};

const TRACK_FORMATS = [
  "mp3",
  "flac",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "opus",
  "aiff",
] as const;

const EMPTY_COUNTS: Record<MusicCategory, number | null> = {
  tracks: null,
  favorites: null,
  queue: null,
  playlists: null,
  recent: null,
  history: null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function trackQuery(keyword: string, filters: TrackFilters): TrackQuery {
  const year = Number.parseInt(filters.year, 10);
  return {
    keyword: keyword.trim() || undefined,
    artistId: filters.artistId || undefined,
    albumId: filters.albumId || undefined,
    genre: filters.genre.trim() || undefined,
    format: filters.format || undefined,
    year: Number.isFinite(year) ? year : undefined,
  };
}

const fieldClass =
  "h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50";

type MusicBrowserProps = {
  /** 测试/嵌入时注入；不传则使用官方 Tauri 单例。 */
  client?: LullMediaClient | null;
  /** 受控分类：设置页持有，便于外部唤起时定位。 */
  category: MusicCategory;
  onCategoryChange: (next: MusicCategory) => void;
};

export function MusicBrowser({
  client: providedClient,
  category,
  onCategoryChange,
}: MusicBrowserProps) {
  // 订阅语言：分类、筛选与列表文案要在设置窗切换语言后同步重渲染。
  useLocale();
  const [client, setClient] = useState<LullMediaClient | null>(
    providedClient ?? null,
  );
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [counts, setCounts] = useState(EMPTY_COUNTS);

  // 全部歌曲
  const [keyword, setKeyword] = useState("");
  const [filters, setFilters] = useState<TrackFilters>(EMPTY_TRACK_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [tracksTotal, setTracksTotal] = useState(0);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [genres, setGenres] = useState<string[]>([]);

  // 其余分类
  const [recentTracks, setRecentTracks] = useState<TrackSummary[]>([]);
  const [favorites, setFavorites] = useState<TrackSummary[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [queueTracks, setQueueTracks] = useState<Record<string, TrackSummary>>(
    {},
  );
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlaylistDetail | null>(null);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (providedClient !== undefined) {
      setClient(providedClient);
      return;
    }
    setClient(getMediaClient());
  }, [providedClient]);

  const refresh = useCallback((): void => {
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "player.state") {
        // 播放状态只驱动每行的播放/停止按钮，不需要重拉列表。
        const next = event.payload as PlayerState | undefined;
        if (next) setPlayer(next);
        return;
      }
      if (
        event.topic === "library.changed" ||
        event.topic === "playlists.changed" ||
        event.topic === "favorites.changed" ||
        event.topic === "history.changed" ||
        event.topic === "queue.changed"
      ) {
        refresh();
      }
    });
    return stop;
  }, [client, refresh]);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client
      .connect({ topics: ["player.state", "queue.changed"] })
      .then((snapshot) => {
        if (alive && snapshot.player) setPlayer(snapshot.player);
      })
      .catch((reason: unknown) => {
        if (alive) setError(m.library_error({ reason: errorText(reason) }));
      });
    return () => {
      alive = false;
      void client.disconnect();
    };
  }, [client]);

  // 按需加载：只拉当前分类（切走再切回会重拉），避免六份数据常驻。
  useEffect(() => {
    if (!client) return;
    let alive = true;
    // version 只是刷新触发器；读取一次避免 lint 把它当成多余依赖。
    void version;
    setError(null);
    const run = async (): Promise<void> => {
      if (category === "tracks") {
        const page = await client.library.listTracks({
          ...trackQuery(keyword, filters),
          pageSize: 100,
        });
        if (!alive) return;
        setTracks(page.items);
        setTracksTotal(page.total);
        if (advancedOpen) {
          const [nextArtists, nextAlbums, nextGenres] = await Promise.all([
            client.library.listArtists(),
            client.library.listAlbums(),
            client.library.listGenres(),
          ]);
          if (!alive) return;
          setArtists(nextArtists);
          setAlbums(nextAlbums);
          setGenres(nextGenres);
        }
        setCounts((current) => ({ ...current, tracks: page.total }));
        return;
      }
      if (category === "favorites") {
        const page = await client.favorites.list(1, 100);
        if (!alive) return;
        setFavorites(page.items);
        setCounts((current) => ({ ...current, favorites: page.total }));
        return;
      }
      if (category === "recent") {
        const page = await client.library.listTracks({
          sortBy: "addedAt",
          sortOrder: "desc",
          pageSize: 100,
        });
        if (!alive) return;
        setRecentTracks(page.items);
        setCounts((current) => ({ ...current, recent: page.total }));
        return;
      }
      if (category === "history") {
        const page = await client.history.list(1, 100);
        if (!alive) return;
        setHistory(page.items);
        setCounts((current) => ({ ...current, history: page.total }));
        return;
      }
      if (category === "playlists") {
        const list = await client.playlists.list();
        if (!alive) return;
        setPlaylists(list);
        setCounts((current) => ({ ...current, playlists: list.length }));
        if (selectedId) {
          const detail = await client.playlists.get(selectedId);
          if (alive) setSelected(detail);
        } else {
          setSelected(null);
        }
        return;
      }
      const state = await client.queue.get();
      if (!alive) return;
      setQueue(state);
      setCounts((current) => ({
        ...current,
        queue: state.trackIds.length,
      }));
      const missing = state.trackIds.filter((id) => !queueTracks[id]);
      if (missing.length === 0) return;
      const loaded = await Promise.all(
        missing.map(async (id) => {
          try {
            return [id, await client.library.getTrack(id)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (!alive) return;
      setQueueTracks((previous) => {
        const next = { ...previous };
        for (const item of loaded) {
          if (item) next[item[0]] = item[1];
        }
        return next;
      });
    };
    // 搜索框防抖：只对「全部歌曲」的关键字/筛选生效，其余分类立即加载。
    const timer = window.setTimeout(
      () => {
        void run().catch((reason: unknown) => {
          if (alive) setError(m.library_error({ reason: errorText(reason) }));
        });
      },
      category === "tracks" ? 220 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [
    advancedOpen,
    category,
    client,
    filters,
    keyword,
    queueTracks,
    selectedId,
    version,
  ]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>): Promise<void> => {
      setBusy(label);
      setError(null);
      try {
        await action();
        refresh();
      } catch (reason) {
        setError(m.library_error({ reason: errorText(reason) }));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const updateFilter = useCallback(
    (key: keyof TrackFilters, value: string): void => {
      setFilters((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const resetFilters = useCallback((): void => {
    setFilters(EMPTY_TRACK_FILTERS);
  }, []);

  /** 「全部歌曲」的艺术家筛选只列出真正有曲目的实体。 */
  const filterableArtists = useMemo(
    () => artists.filter((artist) => artist.trackCount > 0),
    [artists],
  );

  const hasActiveFilters = Object.values(filters).some((value) => value !== "");
  const hasQuery = keyword.trim().length > 0 || hasActiveFilters;

  // 播放 / 停止共用同一个按钮：当前曲目正在播（或加载）时点它就是停止。
  const playingTrackId =
    player && (player.status === "playing" || player.status === "loading")
      ? (player.track?.id ?? null)
      : null;

  const runPlayerAction = useCallback((action: Promise<PlayerState>): void => {
    void action
      .then((state) => setPlayer(state))
      .catch((reason: unknown) =>
        setError(m.library_error({ reason: errorText(reason) })),
      );
  }, []);

  /**
   * 从曲库发起的播放统一先切「单曲循环」，再开始播放。
   * 停止不经过这里，避免停止动作意外改动全局播放模式。
   */
  const playWithRepeatOne = useCallback(
    (start: () => Promise<PlayerState>): void => {
      if (!client) return;
      void client.player
        .setMode("repeat-one")
        .catch(() => null)
        .then(() => start())
        .then((state) => setPlayer(state))
        .catch((reason: unknown) =>
          setError(m.library_error({ reason: errorText(reason) })),
        );
    },
    [client],
  );

  const play = useCallback(
    (track: TrackSummary): void => {
      if (!client) return;
      const isCurrent = player?.track?.id === track.id;
      if (
        isCurrent &&
        (player.status === "playing" || player.status === "loading")
      ) {
        runPlayerAction(client.player.stop());
        return;
      }
      const start =
        isCurrent && player.status === "paused"
          ? () => client.player.resume()
          : () => client.player.play(track.id);
      playWithRepeatOne(start);
    },
    [client, player, playWithRepeatOne, runPlayerAction],
  );

  const toggleQueuePlay = useCallback(
    (index: number, isPlaying: boolean): void => {
      if (!client) return;
      if (isPlaying) {
        runPlayerAction(client.player.stop());
        return;
      }
      playWithRepeatOne(() => client.queue.playAt(index));
    },
    [client, playWithRepeatOne, runPlayerAction],
  );

  const addToQueue = useCallback(
    (track: TrackSummary): void => {
      if (!client) return;
      void run("queue", async () => {
        await client.queue.add(track.id);
        setNotice(m.library_track_added());
      });
    },
    [client, run],
  );

  const queueTracksInOrder = useMemo((): TrackSummary[] => {
    if (!queue) return [];
    const rows: TrackSummary[] = [];
    for (const trackId of queue.trackIds) {
      const track = queueTracks[trackId];
      if (track) rows.push(track);
    }
    return rows;
  }, [queue, queueTracks]);

  const queueCurrentTrackId =
    queue && typeof queue.currentIndex === "number"
      ? (queue.trackIds[queue.currentIndex] ?? null)
      : null;

  const playFromQueue = useCallback(
    (track: TrackSummary): void => {
      if (!queue) return;
      const index = queue.trackIds.indexOf(track.id);
      if (index < 0) return;
      const isPlaying =
        queue.currentIndex === index && playingTrackId === track.id;
      toggleQueuePlay(index, isPlaying);
    },
    [queue, playingTrackId, toggleQueuePlay],
  );

  const removeFromQueue = useCallback(
    (track: TrackSummary): void => {
      if (!client) return;
      void run("queue", async () => {
        await client.queue.remove(track.id);
      });
    },
    [client, run],
  );

  /** 最近播放：同一条曲目只保留最新一次，避免重复行复用同一个 key。 */
  const historyTracks = useMemo((): TrackSummary[] => {
    const seen = new Set<string>();
    const rows: TrackSummary[] = [];
    for (const entry of history) {
      const track = entry.track;
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      rows.push(track);
    }
    return rows;
  }, [history]);

  const playedAtOf = useMemo(() => {
    const times = new Map<string, number>();
    for (const entry of history) {
      const trackId = entry.track?.id;
      if (!trackId) continue;
      const current = times.get(trackId);
      if (current === undefined || entry.playedAt > current) {
        times.set(trackId, entry.playedAt);
      }
    }
    return (track: TrackSummary): string | null => {
      const playedAt = times.get(track.id);
      return playedAt === undefined ? null : formatTime(playedAt);
    };
  }, [history]);

  const toggleFavorite = useCallback(
    (track: TrackSummary): void => {
      if (!client) return;
      void run(`favorite:${track.id}`, async () => {
        const result = await client.favorites.set(track.id, !track.favorite);
        const update = (items: TrackSummary[]): TrackSummary[] =>
          items.map((item) =>
            item.id === track.id
              ? { ...item, favorite: result.favorite }
              : item,
          );
        setTracks(update);
        setRecentTracks(update);
        setFavorites((items) =>
          result.favorite
            ? update(items)
            : items.filter((item) => item.id !== track.id),
        );
        setSelected((current) =>
          current
            ? {
                ...current,
                entries: current.entries.map((entry) =>
                  entry.track?.id === track.id
                    ? {
                        ...entry,
                        track: { ...entry.track, favorite: result.favorite },
                      }
                    : entry,
                ),
              }
            : current,
        );
      });
    },
    [client, run],
  );

  const clearHistory = useCallback((): void => {
    if (!client) return;
    void run("history-clear", async () => {
      await client.history.clear();
      setNotice(m.library_history_cleared());
    });
  }, [client, run]);

  const createPlaylist = useCallback((): void => {
    if (!client || !newName.trim()) return;
    void run("playlist-create", async () => {
      const detail = await client.playlists.create(newName.trim());
      setNewName("");
      setSelectedId(detail.id);
      setSelected(detail);
    });
  }, [client, newName, run]);

  const renamePlaylist = useCallback(
    (name: string): void => {
      if (!client || !selected) return;
      const next = name.trim();
      if (!next || next === selected.name) return;
      void run("playlist-rename", async () => {
        await client.playlists.update(selected.id, { name: next });
      });
    },
    [client, run, selected],
  );

  const deletePlaylist = useCallback((): void => {
    if (!client || !selected) return;
    void run("playlist-delete", async () => {
      await client.playlists.delete(selected.id);
      setSelectedId(null);
      setSelected(null);
    });
  }, [client, run, selected]);

  const removeFromPlaylist = useCallback(
    (trackId: string): void => {
      if (!client || !selected) return;
      void run("playlist-remove", async () => {
        await client.playlists.removeTrack(selected.id, trackId);
        setNotice(m.library_playlist_track_removed());
      });
    },
    [client, run, selected],
  );

  const moveTrack = useCallback(
    (trackId: string, current: number, direction: -1 | 1): void => {
      if (!client || !selected) return;
      const target = current + direction;
      if (target < 0 || target >= selected.entries.length) return;
      void run("playlist-move", async () => {
        await client.playlists.reorder(selected.id, trackId, target);
      });
    },
    [client, run, selected],
  );

  const importM3u = useCallback((): void => {
    if (!client) return;
    void run("m3u-import", async () => {
      const result = await client.playlists.importM3u();
      setSelectedId(result.playlist.id);
      setSelected(result.playlist);
      setNotice(
        m.library_m3u_imported({
          imported: result.imported,
          missing: result.missing.length,
        }),
      );
    });
  }, [client, run]);

  const exportM3u = useCallback((): void => {
    if (!client || !selected) return;
    void run("m3u-export", async () => {
      const result = await client.playlists.exportM3u(selected.id);
      setNotice(
        m.library_m3u_exported({
          exported: result.exported,
          skipped: result.skipped,
        }),
      );
    });
  }, [client, run, selected]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 二级分类：横排标签，限高两行，再多自身滚动。 */}
      {/* biome-ignore lint/a11y/useSemanticElements: these are toggle buttons grouped by aria-pressed, not a fieldset */}
      <div
        role="group"
        aria-label={m.settings_music_categories_label()}
        data-testid="music-browser-categories"
        className="flex max-h-[5.75rem] shrink-0 flex-wrap content-start gap-1 overflow-y-auto"
      >
        {CATEGORIES.map((item) => {
          const Icon = item.icon;
          const active = category === item.id;
          const count = counts[item.id];
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => onCategoryChange(item.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-bamboo/60 bg-bamboo-mist font-medium text-bamboo"
                  : "border-border/60 text-ink-soft hover:border-bamboo/40 hover:text-ink",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {item.label()}
              {count !== null && count > 0 ? (
                <span className="tabular-nums text-[10px] text-ink-faint">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {(error || notice) && (
        <div
          className={cn(
            "shrink-0 rounded-lg border px-3 py-1.5 text-xs",
            error
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-bamboo/30 bg-bamboo-mist/40 text-bamboo",
          )}
          role={error ? "alert" : "status"}
        >
          {error ?? notice}
          <button
            type="button"
            className="float-right ml-3 text-current/70"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            aria-label={m.library_notice_dismiss()}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 唯一滚动条：内容多长都在这里滚，卡片高度不变。
          极矮窗口下留一个下限，避免被上面的分类行挤成 0 高。 */}
      <section
        className="min-h-[140px] flex-1 overflow-y-auto"
        data-testid="music-browser-content"
      >
        {!client ? (
          <p className="py-10 text-center text-sm text-ink-faint">
            {m.library_service_unavailable()}
          </p>
        ) : category === "tracks" ? (
          <div className="space-y-2">
            <section
              className="space-y-2 rounded-xl border border-paper-deep/60 bg-card p-2.5"
              aria-label={m.library_filter_title()}
              data-testid="music-browser-filters"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-paper-deep/70 bg-paper px-3 focus-within:ring-2 focus-within:ring-bamboo/50">
                  <Search
                    className="h-4 w-4 shrink-0 text-ink-faint"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={m.library_search_placeholder()}
                    aria-label={m.library_search_placeholder()}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {advancedOpen
                    ? m.library_filter_less()
                    : m.library_filter_more()}
                </Button>
              </div>
              {advancedOpen && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <select
                    aria-label={m.library_filter_artist()}
                    value={filters.artistId}
                    onChange={(event) =>
                      updateFilter("artistId", event.target.value)
                    }
                    className={fieldClass}
                  >
                    <option value="">{m.library_filter_artist()}</option>
                    {filterableArtists.map((artist) => (
                      <option key={artist.id} value={artist.id}>
                        {artist.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={m.library_filter_album()}
                    value={filters.albumId}
                    onChange={(event) =>
                      updateFilter("albumId", event.target.value)
                    }
                    className={fieldClass}
                  >
                    <option value="">{m.library_filter_album()}</option>
                    {albums.map((album) => (
                      <option key={album.id} value={album.id}>
                        {album.title}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={m.library_filter_genre()}
                    value={filters.genre}
                    onChange={(event) =>
                      updateFilter("genre", event.target.value)
                    }
                    className={fieldClass}
                  >
                    <option value="">{m.library_filter_genre()}</option>
                    {genres.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={m.library_filter_format()}
                    value={filters.format}
                    onChange={(event) =>
                      updateFilter("format", event.target.value)
                    }
                    className={fieldClass}
                  >
                    <option value="">{m.library_filter_format()}</option>
                    {TRACK_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label={m.library_filter_year()}
                    placeholder={m.library_filter_year()}
                    value={filters.year}
                    onChange={(event) =>
                      updateFilter("year", event.target.value)
                    }
                    className={fieldClass}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 justify-center"
                    disabled={!hasActiveFilters}
                    onClick={resetFilters}
                  >
                    {m.library_filter_reset()}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-paper/70 px-2.5 py-1">
                  <strong className="text-sm font-semibold tabular-nums text-ink">
                    {tracksTotal}
                  </strong>
                  {m.library_stat_tracks()}
                </span>
                <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-paper/70 px-2.5 py-1">
                  <strong className="text-sm font-semibold tabular-nums text-ink">
                    {filterableArtists.length}
                  </strong>
                  {m.library_stat_artists()}
                </span>
                <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-paper/70 px-2.5 py-1">
                  <strong className="text-sm font-semibold tabular-nums text-ink">
                    {albums.length}
                  </strong>
                  {m.library_stat_albums()}
                </span>
              </div>
            </section>
            <TrackList
              variant="compact"
              tracks={tracks}
              busy={busy}
              playingTrackId={playingTrackId}
              onPlay={play}
              onQueue={addToQueue}
              onFavorite={toggleFavorite}
              empty={hasQuery ? m.library_filter_empty() : m.library_empty()}
            />
          </div>
        ) : category === "favorites" ? (
          <TrackList
            variant="compact"
            tracks={favorites}
            busy={busy}
            playingTrackId={playingTrackId}
            onPlay={play}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            empty={m.library_empty()}
          />
        ) : category === "recent" ? (
          <TrackList
            variant="compact"
            tracks={recentTracks}
            busy={busy}
            playingTrackId={playingTrackId}
            onPlay={play}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            empty={m.library_empty()}
          />
        ) : category === "queue" ? (
          <TrackList
            variant="compact"
            tracks={queueTracksInOrder}
            busy={busy}
            playingTrackId={playingTrackId}
            highlightedTrackId={queueCurrentTrackId}
            onPlay={playFromQueue}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            onRemove={removeFromQueue}
            removeLabel={m.library_queue_remove()}
            empty={m.library_queue_empty()}
          />
        ) : category === "history" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="text-xs text-ink-faint">{m.library_history()}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearHistory}
                disabled={busy !== null || history.length === 0}
              >
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {m.library_history_clear()}
              </Button>
            </div>
            <TrackList
              variant="compact"
              tracks={historyTracks}
              busy={busy}
              playingTrackId={playingTrackId}
              subtitleSuffix={playedAtOf}
              onPlay={play}
              onQueue={addToQueue}
              onFavorite={toggleFavorite}
              empty={m.library_history_empty()}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <section className="space-y-2 rounded-xl border border-paper-deep/60 bg-card p-2.5">
              <div className="flex items-center gap-2">
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={m.library_playlist_new_placeholder()}
                  className="min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm outline-none"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createPlaylist();
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={createPlaylist}
                  disabled={busy !== null || !newName.trim()}
                  aria-label={m.library_playlist_create()}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={importM3u}
                  disabled={busy !== null}
                >
                  <Import className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {m.library_m3u_import()}
                </Button>
              </div>
              {playlists.length === 0 ? (
                <p className="px-1 text-xs text-ink-faint">
                  {m.library_playlist_empty()}
                </p>
              ) : (
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      type="button"
                      aria-pressed={selectedId === playlist.id}
                      onClick={() => {
                        setSelectedId(playlist.id);
                        setSelected(null);
                      }}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
                        selectedId === playlist.id
                          ? "border-bamboo/60 bg-bamboo-mist font-medium text-bamboo"
                          : "border-border/60 text-ink-soft hover:border-bamboo/40 hover:text-ink",
                      )}
                    >
                      <span className="max-w-[9rem] truncate">
                        {playlist.name}
                      </span>
                      <span className="tabular-nums text-[10px] text-ink-faint">
                        {playlist.trackCount}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {selected && (
                <div className="flex items-center gap-2">
                  <input
                    key={selected.id}
                    defaultValue={selected.name}
                    aria-label={m.library_playlist_rename()}
                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none hover:border-paper-deep/70 focus:border-paper-deep"
                    onBlur={(event) => renamePlaylist(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={exportM3u}
                    disabled={busy !== null}
                  >
                    <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {m.library_m3u_export()}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={deletePlaylist}
                    disabled={busy !== null}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {m.library_playlist_delete()}
                  </Button>
                </div>
              )}
            </section>
            {selected ? (
              <PlaylistTracks
                detail={selected}
                busy={busy}
                playingTrackId={playingTrackId}
                onPlay={play}
                onQueue={addToQueue}
                onFavorite={toggleFavorite}
                onRemove={removeFromPlaylist}
                onMove={moveTrack}
              />
            ) : (
              <p className="py-8 text-center text-sm text-ink-faint">
                {m.library_playlist_empty()}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
