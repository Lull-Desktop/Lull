/**
 * 官方资料库窗口：目录、智能歌单、曲库整理与接口调试。
 *
 * 全部歌曲 / 我的收藏 / 队列 / 歌单 / 最近添加 / 最近播放已经迁到设置窗的
 * 「音乐」页签（见 `components/library/music-browser.tsx`），这个窗口只留
 * 目录与工具类页签，宽度仍是 1080px。
 *
 * 只通过 `@lull/media-sdk` 访问 Media Service；不直接 invoke、不读 SQLite、
 * 不解析音频文件。窗口关闭不停止播放，重开时重新取快照。
 */
"use client";

import type {
  LullMediaClient,
  MusicFolderView,
  PlayerState,
  PlaylistSummary,
  SmartPlaylistView,
  TagView,
  TrackSummary,
} from "@lull/media-sdk";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  FlaskConical,
  FolderOpen,
  Music,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CoverPreview } from "@/components/library/cover-preview";
import { folderRows } from "@/components/library/folder-tree";
import { LibraryWindowFrame } from "@/components/library/library-window-frame";
import { TrackList } from "@/components/library/track-list";
import { LibraryOrganizerPanel } from "@/components/settings/library-organizer-panel";
import { MediaApiTestPanel } from "@/components/settings/media-api-test-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type LibraryTab = "folders" | "smart" | "organizer" | "media-test";

type LibraryWindowProps = {
  /** 测试/嵌入时注入；不传则使用官方 Tauri 单例。 */
  client?: LullMediaClient;
};

const TABS: { id: LibraryTab; label: () => string; icon: typeof Music }[] = [
  { id: "folders", label: m.library_my_folders, icon: FolderOpen },
  { id: "smart", label: m.library_smart_playlists, icon: Sparkles },
  { id: "organizer", label: m.library_tab_organizer, icon: Wrench },
  { id: "media-test", label: m.library_tab_media_test, icon: FlaskConical },
];

/** 只在原资料库页签显示的窗口级刷新；两个工具页签各有自己的刷新入口。 */
const LIBRARY_REFRESH_TABS: ReadonlySet<LibraryTab> = new Set([
  "folders",
  "smart",
]);

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

/** 校验外部传入的页签 id（widget_open 的 tab 参数）是否合法。 */
function isLibraryTab(value: string): value is LibraryTab {
  return TABS.some((tab) => tab.id === value);
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
  // 订阅语言：目录、备份与列表文案要在设置窗切换语言后同步重渲染。
  useLocale();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [tab, setTab] = useState<LibraryTab>("folders");
  const [recursiveImport, setRecursiveImport] = useState(true);
  const { confirm, ask, dialog: confirmDialog } = useConfirmDialog();
  const [folders, setFolders] = useState<MusicFolderView[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  /** 目录列表按路径展开成树：父目录在前，子目录按层级缩进。 */
  const folderTree = useMemo(() => folderRows(folders), [folders]);
  const [folderTracks, setFolderTracks] = useState<TrackSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [editingTrack, setEditingTrack] = useState<TrackSummary | null>(null);
  const [smartPlaylists, setSmartPlaylists] = useState<SmartPlaylistView[]>([]);
  const [smartTracks, setSmartTracks] = useState<TrackSummary[]>([]);
  const [smartName, setSmartName] = useState("");
  const [smartGenre, setSmartGenre] = useState("");
  const [smartFavorite, setSmartFavorite] = useState(false);
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
      // 两个列表页都提供「加入歌单」，因此都要拉一次歌单列表。
      const list = await client.playlists.list();
      if (alive) setPlaylists(list);
      if (tab === "folders") {
        const nextFolders = await client.folders.list();
        if (!alive) return;
        setFolders(nextFolders);
        const folderId =
          selectedFolderId &&
          nextFolders.some((item) => item.id === selectedFolderId)
            ? selectedFolderId
            : (nextFolders[0]?.id ?? null);
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
      if (tab === "smart") {
        const smartList = await client.library.listSmartPlaylists();
        if (!alive) return;
        setSmartPlaylists(smartList);
        if (smartList[0]) {
          const page = await client.library.runSmartPlaylist(smartList[0].id, {
            pageSize: 100,
          });
          if (alive) setSmartTracks(page.items);
        } else {
          setSmartTracks([]);
        }
        return;
      }
    };
    const timer = window.setTimeout(() => {
      void run().catch((reason: unknown) => {
        if (alive) setError(m.library_error({ reason: errorText(reason) }));
      });
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [client, selectedFolderId, tab, version]);

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
      // 行的星标由 `favorites.changed` 广播触发的重拉校准，这里不维护本地副本。
      void run(`favorite:${track.id}`, async () => {
        await client.favorites.set(track.id, !track.favorite);
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

  const importFolder = useCallback((): void => {
    if (!client) return;
    void run("folder-import", async () => {
      const added = await client.folders.add({ recursive: recursiveImport });
      if (!added) return;
      setSelectedFolderId(added.id);
      await client.folders.scan(added.id);
    });
  }, [client, recursiveImport, run]);

  const importSingles = useCallback((): void => {
    if (!client) return;
    void run("singles-import", async () => {
      const result = await client.folders.addSingles({
        name: m.library_folder_singles_name(),
      });
      if (!result) return;
      setSelectedFolderId(result.folder.id);
      const imported = result.added + result.updated;
      if (imported > 0) {
        setNotice(m.library_singles_imported({ count: imported }));
      } else if (result.failed > 0) {
        setNotice(
          m.library_singles_import_failed({
            reason: result.errors[0] ?? result.failed,
          }),
        );
      } else if (result.skipped > 0) {
        setNotice(m.library_singles_import_skipped({ count: result.skipped }));
      } else {
        setNotice(m.library_singles_import_none());
      }
    });
  }, [client, run]);

  // const exportBackup = useCallback((): void => {
  //   if (!client) return;
  //   void run("backup-export", async () => {
  //     await client.library.exportBackup();
  //   });
  // }, [client, run]);

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
      void ask({
        title: m.library_folder_rename(),
        confirmLabel: m.library_folder_rename(),
        input: {
          label: m.library_folder_rename(),
          defaultValue: folder.name,
          ariaLabel: m.library_folder_rename(),
        },
      }).then((next) => {
        const name = next?.trim();
        if (!name || name === folder.name) return;
        void run(`folder-rename:${folder.id}`, async () => {
          await client.folders.rename(folder.id, name);
        });
      });
    },
    [ask, client, run],
  );

  const removeFolder = useCallback(
    (folder: MusicFolderView): void => {
      if (!client) return;
      void confirm({
        title: m.library_folder_remove(),
        description: m.library_folder_remove_confirm({ name: folder.name }),
        confirmLabel: m.library_folder_remove(),
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void run(`folder-remove:${folder.id}`, async () => {
          await client.folders.remove(folder.id);
          setSelectedFolderId(null);
        });
      });
    },
    [client, confirm, run],
  );

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  );

  /** 单曲导入目录的逐条删除；普通目录不提供此入口。 */
  const removeSingleTrack = useCallback(
    (track: TrackSummary): void => {
      if (!client || !selectedFolder || selectedFolder.rootPath) return;
      const folderId = selectedFolder.id;
      void confirm({
        title: m.library_singles_remove(),
        description: m.library_singles_remove_confirm({ title: track.title }),
        confirmLabel: m.library_singles_remove(),
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void run(`singles-remove:${track.id}`, async () => {
          await client.folders.removeTrack(folderId, track.id);
          setNotice(m.library_singles_removed());
        });
      });
    },
    [client, confirm, run, selectedFolder],
  );

  const playlistOptions = useMemo(
    () =>
      playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
      })),
    [playlists],
  );

  const selectTab = useCallback((next: LibraryTab): void => {
    setTab(next);
    setError(null);
    setNotice(null);
  }, []);

  // 外部（播放器扩展等）经 widget_open 指定打开页签：挂载时取走 Rust 侧
  // 暂存值（覆盖新建窗口时事件早于监听注册的情况），运行中收
  // widget-open-tab 事件（窗口关闭即隐藏、复用唤醒不会重建 WebView）。
  useEffect(() => {
    let disposed = false;
    void invoke<string | null>("widget_take_open_tab", { kind: "library" })
      .then((tab) => {
        if (!disposed && tab && isLibraryTab(tab)) selectTab(tab);
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri IPC；页签保持默认。
      });
    let stop: (() => void) | null = null;
    void listen<{ tab?: string }>("widget-open-tab", (event) => {
      const tab = event.payload?.tab;
      if (tab && isLibraryTab(tab)) selectTab(tab);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 同上；事件不可用时只影响外部指定页签。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [selectTab]);

  // 页签变化广播给宿主壳：播放器等扩展据此判断「再点一次」是关闭窗口
  // 还是切到另一个页签，开关按钮的高亮也能跟住真实页签。
  useEffect(() => {
    void emit("library-tab-changed", { tab }).catch(() => {
      // 浏览器预览 / 单测没有 Tauri 事件系统。
    });
  }, [tab]);

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

      {/* 列表在页签内滚动：内容再长也不会把窗口撑高，标题与页签的位置保持不变。 */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        {tab === "organizer" && (
          <LibraryOrganizerPanel client={client ?? undefined} />
        )}

        {tab === "media-test" && <MediaApiTestPanel client={client} />}

        {tab === "folders" && (
          <div className="grid gap-4 md:h-full md:grid-cols-[260px_minmax(0,1fr)]">
            {/* 左侧目录卡撑满页签高度：导入入口固定在卡片头部，
                目录列表在中间自己滚。 */}
            <Card className="flex h-full min-h-0 flex-col">
              <CardHeader className="shrink-0 pb-3">
                <div className="space-y-2">
                  <CardTitle className="text-base">
                    {m.library_my_folders()}
                  </CardTitle>
                  <div className="grid gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!client || busy !== null}
                      onClick={importFolder}
                    >
                      <FolderOpen className="mr-1 h-4 w-4" aria-hidden="true" />
                      {m.library_folder_import()}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!client || busy !== null}
                      onClick={importSingles}
                    >
                      <Music className="mr-1 h-4 w-4" aria-hidden="true" />
                      {m.library_folder_import_singles()}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col space-y-1">
                <label className="flex shrink-0 items-center gap-1.5 px-1 pb-2 text-xs text-ink-faint">
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
                  <div className="min-h-0 flex-1 divide-y divide-paper-deep/50 overflow-y-auto rounded-md border border-paper-deep/60">
                    {folderTree.map(({ folder, depth }) => {
                      const status = folderStatusLabel(folder.status);
                      return (
                        <button
                          key={folder.id}
                          type="button"
                          onClick={() => setSelectedFolderId(folder.id)}
                          className={cn(
                            "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors",
                            selectedFolderId === folder.id
                              ? "bg-bamboo-mist/60 text-ink"
                              : "text-ink-soft hover:bg-paper-warm",
                          )}
                        >
                          <span
                            className="min-w-0 flex-1 truncate"
                            style={{ paddingLeft: depth * 12 }}
                          >
                            {folder.name}
                          </span>
                          <span className="shrink-0 text-xs text-ink-faint tabular-nums">
                            {folder.trackCount}
                          </span>
                          {folder.recursive ? (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-ink-faint">
                              {m.library_folder_recursive()}
                            </span>
                          ) : null}
                          {!folder.rootPath ? (
                            <span className="shrink-0 rounded-full bg-bamboo-mist/70 px-1.5 py-0.5 text-[10px] text-bamboo">
                              {m.library_folder_singles_badge()}
                            </span>
                          ) : null}
                          {status ? (
                            <span className="shrink-0 text-xs text-destructive">
                              {status}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* <div className="shrink-0 space-y-2 border-t border-paper-deep/60 pt-3">
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
                </div> */}
              </CardContent>
            </Card>

            <div className="flex min-h-0 min-w-0 flex-col gap-3">
              {selectedFolder ? (
                <>
                  <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 rounded-xl border border-paper-deep/60 bg-card p-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-medium">
                        {selectedFolder.name}
                      </h2>
                      <p className="truncate text-xs text-ink-faint">
                        {selectedFolder.rootPath ??
                          m.library_folder_singles_hint()}
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
                      {selectedFolder.rootPath ? (
                        selectedFolder.status === "scanning" ? (
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
                        )
                      ) : null}
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
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <TrackList
                      tracks={folderTracks}
                      playlists={playlistOptions}
                      busy={busy}
                      playingTrackId={playingTrackId}
                      onPlay={play}
                      onQueue={addToQueue}
                      onFavorite={toggleFavorite}
                      onAddToPlaylist={addToPlaylist}
                      onEdit={setEditingTrack}
                      onRemove={
                        selectedFolder.rootPath ? undefined : removeSingleTrack
                      }
                      removeLabel={
                        selectedFolder.rootPath
                          ? undefined
                          : m.library_singles_remove()
                      }
                      removeIcon={selectedFolder.rootPath ? undefined : "trash"}
                      showFileName
                      empty={m.library_empty()}
                    />
                  </div>
                </>
              ) : (
                <p className="py-16 text-center text-sm text-ink-faint">
                  {m.library_folder_select()}
                </p>
              )}
            </div>
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
                      className="flex items-center gap-1 rounded-lg border border-paper-deep/60 bg-card px-2 py-1"
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
            <TrackList
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
      </section>

      {confirmDialog}

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
          <div className="flex items-start gap-3 rounded-lg border border-paper-deep/50 bg-card p-3">
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
