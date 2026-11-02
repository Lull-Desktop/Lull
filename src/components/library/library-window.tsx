/**
 * 官方资料库窗口：曲库 / 歌单 / 喜欢 / 历史 / 队列。
 *
 * 只通过 `@lull/media-sdk` 访问 Media Service；不直接 invoke、不读 SQLite、
 * 不解析音频文件。窗口关闭不停止播放，重开时重新取快照。
 */
"use client";

import type {
  AlbumSummary,
  ArtistSummary,
  HistoryEntry,
  LullMediaClient,
  MusicFolderView,
  PlayerState,
  PlaylistDetail,
  PlaylistSummary,
  QueueState,
  SmartPlaylistView,
  TagView,
  TrackQuery,
  TrackSummary,
} from "@lull/media-sdk";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FlaskConical,
  FolderOpen,
  Heart,
  History,
  ListMusic,
  ListOrdered,
  Music,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CoverPreview } from "@/components/library/cover-preview";
import { LibraryWindowFrame } from "@/components/library/library-window-frame";
import { LibraryOrganizerPanel } from "@/components/settings/library-organizer-panel";
import { MediaApiTestPanel } from "@/components/settings/media-api-test-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type LibraryTab =
  | "tracks"
  | "recent"
  | "folders"
  | "playlists"
  | "favorites"
  | "history"
  | "queue"
  | "smart"
  | "organizer"
  | "media-test";

type LibraryWindowProps = {
  /** 测试/嵌入时注入；不传则使用官方 Tauri 单例。 */
  client?: LullMediaClient;
};

const TABS: { id: LibraryTab; label: () => string; icon: typeof Music }[] = [
  { id: "folders", label: m.library_my_folders, icon: FolderOpen },
  { id: "tracks", label: m.library_tracks, icon: Music },
  { id: "favorites", label: m.library_favorites, icon: Heart },
  { id: "queue", label: m.library_queue, icon: ListOrdered },
  { id: "recent", label: m.library_recent_added, icon: Clock },
  { id: "history", label: m.library_history, icon: History },
  { id: "playlists", label: m.library_playlists, icon: ListMusic },
  { id: "smart", label: m.library_smart_playlists, icon: Sparkles },
  { id: "organizer", label: m.library_tab_organizer, icon: Wrench },
  { id: "media-test", label: m.library_tab_media_test, icon: FlaskConical },
];

/** 只在原资料库页签显示的窗口级刷新；两个工具页签各有自己的刷新入口。 */
const LIBRARY_REFRESH_TABS: ReadonlySet<LibraryTab> = new Set([
  "tracks",
  "recent",
  "folders",
  "playlists",
  "favorites",
  "history",
  "queue",
  "smart",
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "--:--";
  }
  const total = Math.round(durationMs / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
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

function folderStatusLabel(status: MusicFolderView["status"]): string {
  switch (status) {
    case "scanning":
      return m.library_folder_scanning();
    case "missing":
      return m.library_folder_status_missing();
    case "error":
      return m.library_folder_status_error();
    default:
      return "";
  }
}

export function LibraryWindow({
  client: providedClient,
}: LibraryWindowProps = {}) {
  // 订阅语言：筛选、备份与列表文案要在设置窗切换语言后同步重渲染。
  useLocale();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [tab, setTab] = useState<LibraryTab>("tracks");
  const [keyword, setKeyword] = useState("");
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [tracksTotal, setTracksTotal] = useState(0);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [filters, setFilters] = useState<TrackFilters>(EMPTY_TRACK_FILTERS);
  const [recursiveImport, setRecursiveImport] = useState(true);
  const [recentTracks, setRecentTracks] = useState<TrackSummary[]>([]);
  const [folders, setFolders] = useState<MusicFolderView[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderTracks, setFolderTracks] = useState<TrackSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlaylistDetail | null>(null);
  const [favorites, setFavorites] = useState<TrackSummary[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [queueTracks, setQueueTracks] = useState<Record<string, TrackSummary>>(
    {},
  );
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [editingTrack, setEditingTrack] = useState<TrackSummary | null>(null);
  const [smartPlaylists, setSmartPlaylists] = useState<SmartPlaylistView[]>([]);
  const [smartTracks, setSmartTracks] = useState<TrackSummary[]>([]);
  const [smartName, setSmartName] = useState("");
  const [smartGenre, setSmartGenre] = useState("");
  const [smartFavorite, setSmartFavorite] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (providedClient) {
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
    // 资料库窗口需要 player/queue 的实时事件；library/favorites/history 事件
    // 走 Media Service 的全局广播，不需要额外 topic。
    void client
      .connect({ topics: ["player.state", "queue.changed"] })
      .then((snapshot) => {
        if (alive && snapshot.player) setPlayer(snapshot.player);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(m.library_error({ reason: errorText(reason) }));
        }
      });
    return () => {
      alive = false;
      void client.disconnect();
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    // version 只是刷新触发器；读取一次避免 lint 把它当成多余依赖。
    void version;
    setError(null);
    const run = async (): Promise<void> => {
      // 两个工具页签使用自己的面板数据，不触发资料库的列表请求。
      if (tab === "organizer" || tab === "media-test") return;
      if (tab !== "playlists") {
        // 曲库/喜欢页也提供“加入歌单”，因此这些页签也要拉一次歌单列表。
        const list = await client.playlists.list();
        if (alive) setPlaylists(list);
      }
      if (tab === "tracks") {
        // 关键字与下拉索引一起进 TrackQuery，两者同时生效。
        const page = await client.library.listTracks({
          ...trackQuery(keyword, filters),
          pageSize: 100,
        });
        if (!alive) return;
        setTracks(page.items);
        setTracksTotal(page.total);
        const [nextArtists, nextAlbums, nextGenres] = await Promise.all([
          client.library.listArtists(),
          client.library.listAlbums(),
          client.library.listGenres(),
        ]);
        if (!alive) return;
        setArtists(nextArtists);
        setAlbums(nextAlbums);
        setGenres(nextGenres);
        return;
      }
      if (tab === "recent") {
        const page = await client.library.listTracks({
          sortBy: "addedAt",
          sortOrder: "desc",
          pageSize: 100,
        });
        if (alive) setRecentTracks(page.items);
        return;
      }
      if (tab === "folders") {
        const list = await client.folders.list();
        if (!alive) return;
        setFolders(list);
        const folderId =
          selectedFolderId && list.some((item) => item.id === selectedFolderId)
            ? selectedFolderId
            : (list[0]?.id ?? null);
        if (folderId !== selectedFolderId) setSelectedFolderId(folderId);
        if (folderId) {
          const page = await client.folders.getTracks(folderId, {
            pageSize: 100,
          });
          if (alive) setFolderTracks(page.items);
        } else if (alive) {
          setFolderTracks([]);
        }
        return;
      }
      if (tab === "playlists") {
        const list = await client.playlists.list();
        if (!alive) return;
        setPlaylists(list);
        if (selectedId) {
          const detail = await client.playlists.get(selectedId);
          if (alive) setSelected(detail);
        } else {
          setSelected(null);
        }
        return;
      }
      if (tab === "smart") {
        const list = await client.library.listSmartPlaylists();
        if (!alive) return;
        setSmartPlaylists(list);
        if (list[0]) {
          const page = await client.library.runSmartPlaylist(list[0].id, {
            pageSize: 100,
          });
          if (alive) setSmartTracks(page.items);
        } else {
          setSmartTracks([]);
        }
        return;
      }
      if (tab === "favorites") {
        const page = await client.favorites.list(1, 100);
        if (alive) setFavorites(page.items);
        return;
      }
      if (tab === "history") {
        const page = await client.history.list(1, 100);
        if (alive) setHistory(page.items);
        return;
      }
      const state = await client.queue.get();
      if (!alive) return;
      setQueue(state);
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
    const timer = window.setTimeout(
      () => {
        void run().catch((reason: unknown) => {
          if (alive) setError(m.library_error({ reason: errorText(reason) }));
        });
      },
      tab === "tracks" ? 220 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    filters,
    keyword,
    queueTracks,
    selectedFolderId,
    selectedId,
    tab,
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
   * 从资料库发起的播放统一先切「单曲循环」，再开始播放。
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

  const addToPlaylist = useCallback(
    (playlistId: string, track: TrackSummary): void => {
      if (!client || !playlistId) return;
      void run("playlist-add", async () => {
        await client.playlists.addTrack(playlistId, track.id);
        setNotice(m.library_playlist_track_added());
      });
    },
    [client, run],
  );

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

  const createSmartPlaylist = useCallback((): void => {
    if (!client) return;
    const name = smartName.trim();
    if (!name) return;
    void run("smart-create", async () => {
      const playlist = await client.library.createSmartPlaylist(name, {
        genre: smartGenre.trim() || undefined,
        favoriteOnly: smartFavorite || undefined,
        pageSize: 100,
      });
      setSmartName("");
      setSmartGenre("");
      setSmartFavorite(false);
      const list = await client.library.listSmartPlaylists();
      setSmartPlaylists(list);
      const page = await client.library.runSmartPlaylist(playlist.id, {
        pageSize: 100,
      });
      setSmartTracks(page.items);
    });
  }, [client, run, smartFavorite, smartGenre, smartName]);

  const runSmartPlaylist = useCallback(
    (playlist: SmartPlaylistView): void => {
      if (!client) return;
      void run(`smart:${playlist.id}`, async () => {
        const page = await client.library.runSmartPlaylist(playlist.id, {
          pageSize: 100,
        });
        setSmartTracks(page.items);
      });
    },
    [client, run],
  );

  const deleteSmartPlaylist = useCallback(
    (playlist: SmartPlaylistView): void => {
      if (!client) return;
      void run(`smart-delete:${playlist.id}`, async () => {
        await client.library.deleteSmartPlaylist(playlist.id);
        const list = await client.library.listSmartPlaylists();
        setSmartPlaylists(list);
        if (list[0]) {
          const page = await client.library.runSmartPlaylist(list[0].id, {
            pageSize: 100,
          });
          setSmartTracks(page.items);
        } else {
          setSmartTracks([]);
        }
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

  const importFolder = useCallback((): void => {
    if (!client) return;
    void run("folder-import", async () => {
      const added = await client.folders.add({ recursive: recursiveImport });
      if (!added) return;
      setSelectedFolderId(added.id);
      await client.folders.scan(added.id);
    });
  }, [client, recursiveImport, run]);

  const exportBackup = useCallback((): void => {
    if (!client) return;
    void run("backup-export", async () => {
      await client.library.exportBackup();
    });
  }, [client, run]);

  const importBackup = useCallback((): void => {
    if (!client) return;
    void run("backup-import", async () => {
      await client.library.importBackup();
    });
  }, [client, run]);

  const scanFolder = useCallback(
    (folder: MusicFolderView): void => {
      if (!client) return;
      void run(`folder-scan:${folder.id}`, async () => {
        await client.folders.scan(folder.id);
      });
    },
    [client, run],
  );

  const cancelFolderScan = useCallback(
    (folder: MusicFolderView): void => {
      if (!client) return;
      void run(`folder-cancel:${folder.id}`, async () => {
        await client.folders.cancelScan(folder.id);
      });
    },
    [client, run],
  );

  const renameFolder = useCallback(
    (folder: MusicFolderView): void => {
      if (!client) return;
      const next = window.prompt(m.library_folder_rename(), folder.name);
      if (!next || next.trim() === folder.name) return;
      void run(`folder-rename:${folder.id}`, async () => {
        await client.folders.rename(folder.id, next.trim());
      });
    },
    [client, run],
  );

  const removeFolder = useCallback(
    (folder: MusicFolderView): void => {
      if (!client) return;
      if (
        !window.confirm(m.library_folder_remove_confirm({ name: folder.name }))
      ) {
        return;
      }
      void run(`folder-remove:${folder.id}`, async () => {
        await client.folders.remove(folder.id);
        setSelectedFolderId(null);
      });
    },
    [client, run],
  );

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  );

  const playlistOptions = useMemo(
    () =>
      playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
      })),
    [playlists],
  );

  const hasActiveFilters = Object.values(filters).some((value) => value !== "");
  const hasQuery = keyword.trim().length > 0 || hasActiveFilters;

  const selectTab = useCallback((next: LibraryTab): void => {
    setTab(next);
    if (next !== "playlists") {
      setSelectedId(null);
      setSelected(null);
    }
    setError(null);
    setNotice(null);
  }, []);

  return (
    <LibraryWindowFrame
      title={m.library_title()}
      description={m.widget_library_description()}
      tabs={TABS}
      activeTab={tab}
      onSelectTab={(id) => selectTab(id as LibraryTab)}
      actions={
        LIBRARY_REFRESH_TABS.has(tab) ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={busy !== null}
            >
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {m.library_refresh()}
            </Button>
          </div>
        ) : null
      }
    >
      {/* 错误 / 成功提示紧跟页签，先于筛选与列表，避免被筛选面板挤到视线外。 */}
      {(error || notice) && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
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
            aria-label="关闭"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 全部歌曲的索引筛选：关键字与下拉索引放在同一块，一起进入 TrackQuery。 */}
      {tab === "tracks" && (
        <section
          className="space-y-3 rounded-xl border border-paper-deep/60 bg-paper-warm/40 p-3"
          data-testid="library-track-filters"
          aria-label={m.library_filter_title()}
        >
          <div className="flex h-9 items-center gap-2 rounded-lg border border-paper-deep/70 bg-paper px-3 focus-within:ring-2 focus-within:ring-bamboo/50">
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <select
              aria-label={m.library_filter_artist()}
              value={filters.artistId}
              onChange={(event) => updateFilter("artistId", event.target.value)}
              className="h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
            >
              <option value="">{m.library_filter_artist()}</option>
              {artists.map((artist) => (
                <option key={artist.id} value={artist.id}>
                  {artist.name}
                </option>
              ))}
            </select>
            <select
              aria-label={m.library_filter_album()}
              value={filters.albumId}
              onChange={(event) => updateFilter("albumId", event.target.value)}
              className="h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
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
              onChange={(event) => updateFilter("genre", event.target.value)}
              className="h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
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
              onChange={(event) => updateFilter("format", event.target.value)}
              className="h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
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
              onChange={(event) => updateFilter("year", event.target.value)}
              className="h-9 min-w-0 rounded-lg border border-paper-deep/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
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
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
            <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-paper/70 px-2.5 py-1">
              <strong className="text-sm font-semibold tabular-nums text-ink">
                {tracksTotal}
              </strong>
              {m.library_stat_tracks()}
            </span>
            <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-paper/70 px-2.5 py-1">
              <strong className="text-sm font-semibold tabular-nums text-ink">
                {artists.length}
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
      )}

      <section className="min-h-0 flex-1">
        {tab === "organizer" && (
          <LibraryOrganizerPanel client={client ?? undefined} />
        )}

        {tab === "media-test" && <MediaApiTestPanel client={client} />}

        {tab === "tracks" && (
          <TrackTable
            tracks={tracks}
            playlists={playlistOptions}
            busy={busy}
            playingTrackId={playingTrackId}
            onPlay={play}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            onAddToPlaylist={addToPlaylist}
            onEdit={setEditingTrack}
            empty={hasQuery ? m.library_filter_empty() : m.library_empty()}
          />
        )}

        {tab === "recent" && (
          <TrackTable
            tracks={recentTracks}
            playlists={playlistOptions}
            busy={busy}
            playingTrackId={playingTrackId}
            onPlay={play}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            onAddToPlaylist={addToPlaylist}
            onEdit={setEditingTrack}
            empty={m.library_empty()}
          />
        )}

        {tab === "folders" && (
          <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
            <Card className="h-fit">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {m.library_my_folders()}
                  </CardTitle>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!client || busy !== null}
                    onClick={importFolder}
                  >
                    <FolderOpen className="mr-1 h-4 w-4" aria-hidden="true" />
                    {m.library_folder_import()}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                <label className="flex items-center gap-1.5 px-1 pb-2 text-xs text-ink-faint">
                  <input
                    type="checkbox"
                    checked={recursiveImport}
                    onChange={(event) =>
                      setRecursiveImport(event.target.checked)
                    }
                  />
                  {m.library_folder_recursive()}
                </label>
                {folders.length === 0 ? (
                  <p className="px-1 py-3 text-sm text-ink-faint">
                    {m.library_folder_empty()}
                  </p>
                ) : (
                  folders.map((folder) => {
                    const status = folderStatusLabel(folder.status);
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => setSelectedFolderId(folder.id)}
                        className={cn(
                          "w-full rounded-lg px-2 py-2 text-left transition-colors",
                          selectedFolderId === folder.id
                            ? "bg-bamboo-mist/60 text-ink"
                            : "text-ink-soft hover:bg-paper-warm",
                        )}
                      >
                        <span className="block truncate text-sm">
                          {folder.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-faint">
                          {m.library_folder_tracks({
                            count: folder.trackCount,
                          })}
                          {folder.recursive
                            ? ` · ${m.library_folder_recursive()}`
                            : ""}
                        </span>
                        {status ? (
                          <span className="mt-0.5 block text-xs text-destructive">
                            {status}
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                )}
                <div className="space-y-2 border-t border-paper-deep/60 pt-3">
                  <div>
                    <p className="text-sm font-medium text-ink-soft">
                      {m.library_backup_title()}
                    </p>
                    <p className="text-[11px] leading-snug text-ink-faint">
                      {m.library_backup_hint()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={!client || busy !== null}
                      onClick={exportBackup}
                    >
                      <Download className="mr-1 h-4 w-4" aria-hidden="true" />
                      {m.library_backup_export()}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={!client || busy !== null}
                      onClick={importBackup}
                    >
                      <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
                      {m.library_backup_import()}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="min-w-0 space-y-3">
              {selectedFolder ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-paper-deep/60 bg-paper-warm/40 p-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-medium">
                        {selectedFolder.name}
                      </h2>
                      <p className="truncate text-xs text-ink-faint">
                        {selectedFolder.rootPath ?? ""}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {m.library_folder_tracks({
                          count: selectedFolder.trackCount,
                        })}
                        {selectedFolder.lastScannedAt
                          ? ` · ${formatTime(selectedFolder.lastScannedAt)}`
                          : ""}
                        {folderStatusLabel(selectedFolder.status)
                          ? ` · ${folderStatusLabel(selectedFolder.status)}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {selectedFolder.status === "scanning" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => cancelFolderScan(selectedFolder)}
                        >
                          {m.library_folder_cancel_scan()}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!client || busy !== null}
                          onClick={() => scanFolder(selectedFolder)}
                        >
                          <RefreshCw
                            className="mr-1 h-4 w-4"
                            aria-hidden="true"
                          />
                          {m.library_folder_scan()}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          busy !== null || selectedFolder.status === "scanning"
                        }
                        onClick={() => renameFolder(selectedFolder)}
                        title={m.library_folder_rename()}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          busy !== null || selectedFolder.status === "scanning"
                        }
                        onClick={() => removeFolder(selectedFolder)}
                        title={m.library_folder_remove()}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <TrackTable
                    tracks={folderTracks}
                    playlists={playlistOptions}
                    busy={busy}
                    playingTrackId={playingTrackId}
                    onPlay={play}
                    onQueue={addToQueue}
                    onFavorite={toggleFavorite}
                    onAddToPlaylist={addToPlaylist}
                    onEdit={setEditingTrack}
                    showFileName
                    empty={m.library_empty()}
                  />
                </>
              ) : (
                <p className="py-16 text-center text-sm text-ink-faint">
                  {m.library_folder_select()}
                </p>
              )}
            </div>
          </div>
        )}

        {tab === "favorites" && (
          <TrackTable
            tracks={favorites}
            playlists={playlistOptions}
            busy={busy}
            playingTrackId={playingTrackId}
            onPlay={play}
            onQueue={addToQueue}
            onFavorite={toggleFavorite}
            onAddToPlaylist={addToPlaylist}
            onEdit={setEditingTrack}
            empty={m.library_empty()}
          />
        )}

        {tab === "playlists" && (
          <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
            <Card className="h-fit">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {m.library_playlists()}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
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
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={importM3u}
                  disabled={busy !== null}
                >
                  <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {m.library_m3u_import()}
                </Button>
                <div className="space-y-1">
                  {playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper-warm",
                        selectedId === playlist.id &&
                          "bg-paper-warm font-medium",
                      )}
                      onClick={() => {
                        setSelectedId(playlist.id);
                        setSelected(null);
                      }}
                    >
                      <span className="truncate">{playlist.name}</span>
                      <span className="ml-2 text-xs text-ink-faint">
                        {playlist.trackCount}
                      </span>
                    </button>
                  ))}
                  {playlists.length === 0 && (
                    <p className="px-2 py-3 text-xs text-ink-faint">
                      {m.library_playlist_empty()}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
                {selected ? (
                  <CardTitle className="min-w-0 flex-1">
                    <input
                      key={selected.id}
                      defaultValue={selected.name}
                      aria-label={m.library_playlist_rename()}
                      className="w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold outline-none hover:border-paper-deep/70 focus:border-paper-deep"
                      onBlur={(event) => renamePlaylist(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </CardTitle>
                ) : (
                  <CardTitle className="truncate text-base">
                    {m.library_playlists()}
                  </CardTitle>
                )}
                {selected && (
                  <div className="flex gap-2">
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
              </CardHeader>
              <CardContent>
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
                  <p className="py-10 text-center text-sm text-ink-faint">
                    {m.library_playlist_empty()}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "smart" && (
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">智能歌单</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <input
                    className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                    placeholder="名称"
                    value={smartName}
                    onChange={(event) => setSmartName(event.target.value)}
                  />
                  <input
                    className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                    placeholder="流派（可选）"
                    value={smartGenre}
                    onChange={(event) => setSmartGenre(event.target.value)}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                    <input
                      type="checkbox"
                      checked={smartFavorite}
                      onChange={(event) =>
                        setSmartFavorite(event.target.checked)
                      }
                    />
                    仅喜欢
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null || !smartName.trim()}
                    onClick={createSmartPlaylist}
                  >
                    创建
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {smartPlaylists.map((playlist) => (
                    <div
                      key={playlist.id}
                      className="flex items-center gap-1 rounded-lg border border-paper-deep/60 bg-paper-warm/50 px-2 py-1"
                    >
                      <button
                        type="button"
                        className="text-xs text-ink hover:underline"
                        onClick={() => runSmartPlaylist(playlist)}
                      >
                        {playlist.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${playlist.name}`}
                        className="rounded p-0.5 text-ink-faint hover:text-destructive"
                        onClick={() => deleteSmartPlaylist(playlist)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  {smartPlaylists.length === 0 ? (
                    <span className="text-xs text-ink-faint">
                      还没有智能歌单；按流派或喜欢创建，结果会实时查询。
                    </span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <TrackTable
              tracks={smartTracks}
              playlists={playlistOptions}
              busy={busy}
              playingTrackId={playingTrackId}
              onPlay={play}
              onQueue={addToQueue}
              onFavorite={toggleFavorite}
              onAddToPlaylist={addToPlaylist}
              onEdit={setEditingTrack}
              empty="当前规则没有匹配曲目"
            />
          </div>
        )}

        {tab === "history" && (
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">{m.library_history()}</CardTitle>
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
            </CardHeader>
            <CardContent className="space-y-1">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-paper-warm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {entry.track?.title ?? entry.trackId}
                    </p>
                    <p className="truncate text-xs text-ink-faint">
                      {entry.track?.artists.join(", ")} {" · "}
                      {formatTime(entry.playedAt)}
                    </p>
                  </div>
                  {entry.track && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => play(entry.track as TrackSummary)}
                    >
                      {playingTrackId === entry.track.id ? (
                        <Square
                          className="mr-1 h-4 w-4 fill-current"
                          aria-hidden="true"
                        />
                      ) : (
                        <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                      )}
                      {playingTrackId === entry.track.id
                        ? m.library_stop()
                        : m.library_play()}
                    </Button>
                  )}
                </div>
              ))}
              {history.length === 0 && (
                <p className="py-10 text-center text-sm text-ink-faint">
                  {m.library_history_empty()}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "queue" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{m.library_queue()}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {queue?.trackIds.map((trackId, index) => {
                const track = queueTracks[trackId];
                const isPlaying =
                  queue.currentIndex === index &&
                  playingTrackId !== null &&
                  track?.id === playingTrackId;
                return (
                  <div
                    key={trackId}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-2 py-2 hover:bg-paper-warm",
                      queue.currentIndex === index && "bg-bamboo-mist/40",
                    )}
                  >
                    <span className="w-6 text-right text-xs text-ink-faint">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {track?.title ?? trackId}
                      </p>
                      <p className="truncate text-xs text-ink-faint">
                        {track?.artists.join(", ")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleQueuePlay(index, isPlaying)}
                    >
                      {isPlaying ? (
                        <Square
                          className="mr-1 h-4 w-4 fill-current"
                          aria-hidden="true"
                        />
                      ) : (
                        <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                      )}
                      {isPlaying ? m.library_stop() : m.library_queue_play()}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void client?.queue
                          .remove(trackId)
                          .catch((reason: unknown) =>
                            setError(
                              m.library_error({ reason: errorText(reason) }),
                            ),
                          )
                      }
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      {m.library_queue_remove()}
                    </Button>
                  </div>
                );
              })}
              {(!queue || queue.trackIds.length === 0) && (
                <p className="py-10 text-center text-sm text-ink-faint">
                  {m.library_queue_empty()}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {editingTrack && client ? (
        <MetadataEditor
          key={editingTrack.id}
          client={client}
          track={editingTrack}
          onClose={() => setEditingTrack(null)}
          onSaved={(updated) => {
            setEditingTrack(null);
            setNotice(`已更新「${updated.title}」`);
            refresh();
          }}
        />
      ) : null}
    </LibraryWindowFrame>
  );
}

type TrackTableProps = {
  tracks: TrackSummary[];
  playlists: { id: string; name: string }[];
  busy: string | null;
  empty: string;
  showFileName?: boolean;
  /** 正在播放的曲目；与当前行一致时按钮显示「停止」。 */
  playingTrackId: string | null;
  onPlay: (track: TrackSummary) => void;
  onQueue: (track: TrackSummary) => void;
  onFavorite: (track: TrackSummary) => void;
  onAddToPlaylist: (playlistId: string, track: TrackSummary) => void;
  onEdit?: (track: TrackSummary) => void;
};

function TrackTable(props: TrackTableProps) {
  if (props.tracks.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-ink-faint">{props.empty}</p>
    );
  }
  return (
    <div className="divide-y divide-paper-deep/50 rounded-xl border border-paper-deep/60 bg-paper-warm/40">
      {props.tracks.map((track) => (
        <div
          key={track.id}
          className="flex flex-wrap items-center gap-3 px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{track.title}</p>
            <p className="truncate text-xs text-ink-faint">
              {track.artists.join(", ") || "—"}
              {track.album ? ` · ${track.album}` : ""}
              {track.year ? ` · ${track.year}` : ""}
              {props.showFileName && track.fileName
                ? ` · ${track.fileName}`
                : ""}
            </p>
          </div>
          <span className="w-14 text-right text-xs text-ink-faint">
            {formatDuration(track.durationMs)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onFavorite(track)}
            disabled={props.busy !== null}
            title={
              track.favorite
                ? m.library_favorite_remove()
                : m.library_favorite_add()
            }
          >
            <Heart
              className={cn(
                "h-4 w-4",
                track.favorite && "fill-current text-destructive",
              )}
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onPlay(track)}
            disabled={!track.available}
          >
            {props.playingTrackId === track.id ? (
              <Square
                className="mr-1 h-4 w-4 fill-current"
                aria-hidden="true"
              />
            ) : (
              <Play className="mr-1 h-4 w-4" aria-hidden="true" />
            )}
            {props.playingTrackId === track.id
              ? m.library_stop()
              : m.library_play()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onQueue(track)}
            disabled={props.busy !== null}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {m.library_queue_add()}
          </Button>
          {props.onEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onEdit?.(track)}
              disabled={props.busy !== null}
              title="编辑元数据与标签"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          {props.playlists.length > 0 && (
            <select
              className="max-w-[10rem] rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1 text-xs"
              defaultValue=""
              onChange={(event) => {
                const playlistId = event.target.value;
                if (playlistId) props.onAddToPlaylist(playlistId, track);
                event.target.value = "";
              }}
              aria-label={m.library_playlist_add_to()}
            >
              <option value="">{m.library_playlist_add_to()}</option>
              {props.playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}

type MetadataEditorProps = {
  client: LullMediaClient;
  track: TrackSummary;
  onClose: () => void;
  onSaved: (track: TrackSummary) => void;
};

function MetadataEditor({
  client,
  track,
  onClose,
  onSaved,
}: MetadataEditorProps) {
  const [title, setTitle] = useState(track.title);
  const [artists, setArtists] = useState(track.artists.join(", "));
  const [album, setAlbum] = useState(track.album ?? "");
  const [genre, setGenre] = useState(track.genre ?? "");
  const [year, setYear] = useState(track.year ? String(track.year) : "");
  const [tags, setTags] = useState<TagView[]>([]);
  const [tagIds, setTagIds] = useState<string[]>(
    (track.tags ?? []).map((tag) => tag.id),
  );
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void client.library
      .listTags()
      .then((items) => {
        if (alive) setTags(items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  const toggleTag = (tagId: string): void => {
    setTagIds((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    );
  };

  const createTag = async (): Promise<void> => {
    const name = newTag.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tag = await client.library.createTag(name);
      setTags((current) => [...current, tag]);
      setTagIds((current) => [...current, tag.id]);
      setNewTag("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsedYear = Number.parseInt(year, 10);
      const nextArtists = artists
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const nextAlbum = album.trim();
      const nextGenre = genre.trim();
      const currentArtistKey = [...track.artists].sort().join("\u001f");
      const nextArtistKey = [...nextArtists].sort().join("\u001f");
      const currentTagKey = [...(track.tags ?? []).map((tag) => tag.id)]
        .sort()
        .join("\u001f");
      const nextTagKey = [...tagIds].sort().join("\u001f");
      const patch: {
        trackId: string;
        title?: string;
        artists?: string[];
        album?: string | null;
        genre?: string | null;
        year?: number | null;
      } = { trackId: track.id };
      if (title.trim() !== track.title) patch.title = title.trim();
      if (nextArtistKey !== currentArtistKey) patch.artists = nextArtists;
      if (nextAlbum !== (track.album ?? "")) {
        patch.album = nextAlbum || null;
      }
      if (nextGenre !== (track.genre ?? "")) {
        patch.genre = nextGenre || null;
      }
      const currentYear = track.year ?? null;
      const nextYear = Number.isFinite(parsedYear) ? parsedYear : null;
      if (nextYear !== currentYear) patch.year = nextYear;

      const metadataChanged =
        patch.title !== undefined ||
        patch.artists !== undefined ||
        patch.album !== undefined ||
        patch.genre !== undefined ||
        patch.year !== undefined;
      const updated = metadataChanged
        ? await client.library.updateTrackMetadata(patch)
        : track;
      if (nextTagKey !== currentTagKey) {
        await client.library.setTrackTags(track.id, tagIds);
      }
      onSaved(updated);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="编辑曲目元数据"
    >
      <Card className="max-h-[90vh] w-full max-w-xl overflow-auto shadow-xl">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">编辑元数据</CardTitle>
          <button
            type="button"
            className="rounded-md p-1 text-ink-faint hover:bg-paper-deep/40"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-paper-deep/50 bg-paper-warm/40 p-3">
            <CoverPreview client={client} track={track} className="w-28" />
            <div className="min-w-0 space-y-1 text-xs text-ink-soft">
              <p className="font-medium text-ink">封面</p>
              <p>
                {track.hasCover
                  ? "来自音频内嵌或文件夹封面，经 Rust 资产协议授权后预览。"
                  : "当前曲目没有封面资产。"}
              </p>
              <p className="text-ink-faint">
                封面读取走 library.getCoverUrl；当前 API
                没有用户上传/替换封面的保存入口。
              </p>
            </div>
          </div>
          <label className="grid gap-1 text-xs text-ink-soft">
            标题
            <input
              className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-soft">
            艺术家（逗号分隔）
            <input
              className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
              value={artists}
              onChange={(event) => setArtists(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-ink-soft">
              专辑
              <input
                className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                value={album}
                onChange={(event) => setAlbum(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-ink-soft">
              流派
              <input
                className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                value={genre}
                onChange={(event) => setGenre(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-ink-soft">
              年份
              <input
                className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                value={year}
                inputMode="numeric"
                onChange={(event) => setYear(event.target.value)}
              />
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-ink-soft">标签</p>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={tagIds.includes(tag.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    tagIds.includes(tag.id)
                      ? "border-accent bg-accent/15 text-ink"
                      : "border-paper-deep/70 text-ink-faint",
                  )}
                  onClick={() => toggleTag(tag.id)}
                >
                  {tag.name}
                  {tag.trackCount > 0 ? ` · ${tag.trackCount}` : ""}
                </button>
              ))}
              {tags.length === 0 ? (
                <span className="text-xs text-ink-faint">还没有标签</span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm"
                placeholder="新标签"
                value={newTag}
                onChange={(event) => setNewTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createTag();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || !newTag.trim()}
                onClick={() => void createTag()}
              >
                添加
              </Button>
            </div>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || !title.trim()}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type PlaylistTracksProps = {
  detail: PlaylistDetail;
  busy: string | null;
  playingTrackId: string | null;
  onPlay: (track: TrackSummary) => void;
  onQueue: (track: TrackSummary) => void;
  onFavorite: (track: TrackSummary) => void;
  onRemove: (trackId: string) => void;
  onMove: (trackId: string, current: number, direction: -1 | 1) => void;
};

function PlaylistTracks(props: PlaylistTracksProps) {
  const entries = props.detail.entries;
  if (entries.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-faint">
        {m.library_playlist_empty()}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {entries.map((entry, index) => {
        const track = entry.track;
        return (
          <div
            key={entry.trackId}
            className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-paper-warm"
          >
            <span className="w-6 text-right text-xs text-ink-faint">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {track?.title ?? entry.trackId}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {track?.artists.join(", ")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onMove(entry.trackId, index, -1)}
              disabled={index === 0 || props.busy !== null}
              aria-label={m.library_playlist_move_up()}
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onMove(entry.trackId, index, 1)}
              disabled={index === entries.length - 1 || props.busy !== null}
              aria-label={m.library_playlist_move_down()}
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            {track && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onFavorite(track)}
                  disabled={props.busy !== null}
                >
                  <Heart
                    className={cn(
                      "h-4 w-4",
                      track.favorite && "fill-current text-destructive",
                    )}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onPlay(track)}
                >
                  {props.playingTrackId === track.id ? (
                    <Square
                      className="mr-1 h-4 w-4 fill-current"
                      aria-hidden="true"
                    />
                  ) : (
                    <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                  )}
                  {props.playingTrackId === track.id
                    ? m.library_stop()
                    : m.library_play()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onQueue(track)}
                  disabled={props.busy !== null}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  {m.library_queue_add()}
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onRemove(entry.trackId)}
              disabled={props.busy !== null}
            >
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
              {m.library_playlist_remove_track()}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
