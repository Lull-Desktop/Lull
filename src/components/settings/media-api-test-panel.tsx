/**
 * 开发调试面板：直接驱动 @lull/media-sdk 的 P3 API，并把结果与 media:event
 * 原样展示出来，方便在音乐库窗口内手工验收歌单/收藏/历史/队列/M3U。
 *
 * 这不是面向用户的正式 UI；媒体连接由外层资料库窗口统一建立，这里只订阅事件。
 */
"use client";

import type {
  HistoryEntry,
  LullMediaClient,
  PlaylistDetail,
  PlaylistSummary,
  QueueState,
  TrackSummary,
} from "@lull/media-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SmartShuffleApiPanel } from "@/components/settings/smart-shuffle-api-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

export function MediaApiTestPanel({
  client,
}: {
  /** 由资料库窗口传入；连接所有权在窗口，面板不 connect/disconnect。 */
  client: LullMediaClient | null;
}) {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [playlistId, setPlaylistId] = useState("");
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [favorites, setFavorites] = useState<TrackSummary[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [queueTracks, setQueueTracks] = useState<Record<string, TrackSummary>>(
    {},
  );
  const [newName, setNewName] = useState("测试歌单");
  const [rename, setRename] = useState("");
  const [busy, setBusy] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const logSeq = useRef(0);

  const push = useCallback((label: string, data: unknown): void => {
    const id = logSeq.current + 1;
    logSeq.current = id;
    setLog((previous) =>
      [{ id, at: Date.now(), label, data }, ...previous].slice(0, 40),
    );
  }, []);

  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event:any) => {
      push(`event ${event.topic}`, {
        revision: event.revision,
        eventId: event.eventId,
        payload: event.payload,
      });
    });
    return stop;
  }, [client, push]);

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? null,
    [selectedTrackId, tracks],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return;
    const [trackPage, playlistList, favoritePage, historyPage, queueState] =
      await Promise.all([
        client.library.listTracks({ pageSize: 100 }),
        client.playlists.list(),
        client.favorites.list(1, 100),
        client.history.list(1, 100),
        client.queue.get(),
      ]);
    setTracks(trackPage.items);
    setPlaylists(playlistList);
    setFavorites(favoritePage.items);
    setHistory(historyPage.items);
    setQueue(queueState);
    if (!selectedTrackId && trackPage.items[0]) {
      setSelectedTrackId(trackPage.items[0].id);
    }
    if (!playlistId && playlistList[0]) {
      setPlaylistId(playlistList[0].id);
    }
    if (playlistId) {
      setPlaylist(await client.playlists.get(playlistId));
    }
    const missing = queueState.trackIds.filter((id: string | number) => !queueTracks[id]);
    if (missing.length > 0) {
      const loaded = await Promise.all(
        missing.map(async (id: string) => {
          try {
            return [id, await client.library.getTrack(id)] as const;
          } catch {
            return null;
          }
        }),
      );
      setQueueTracks((previous) => {
        const next = { ...previous };
        for (const item of loaded) {
          if (item) next[item[0]] = item[1];
        }
        return next;
      });
    }
    setError("");
  }, [client, playlistId, queueTracks, selectedTrackId]);

  useEffect(() => {
    if (!client) return;
    void refresh().catch((reason: unknown) => {
      setError(errorText(reason));
    });
  }, [client, refresh]);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      refreshAfter = true,
    ): Promise<void> => {
      if (!client) return;
      setBusy(label);
      setError("");
      try {
        const result = await action();
        push(label, result ?? { ok: true });
        if (refreshAfter) await refresh();
      } catch (reason) {
        const message = errorText(reason);
        setError(message);
        push(`${label} ❌`, { error: message });
      } finally {
        setBusy("");
      }
    },
    [client, push, refresh],
  );

  const playSelected = useCallback((): void => {
    if (!client || !selectedTrack) return;
    void run(`player.play ${selectedTrack.title}`, () =>
      client.player.play(selectedTrack.id),
    );
  }, [client, run, selectedTrack]);

  const toggleFavorite = useCallback((): void => {
    if (!client || !selectedTrack) return;
    void run(`favorites.set ${!selectedTrack.favorite}`, () =>
      client.favorites.set(selectedTrack.id, !selectedTrack.favorite),
    );
  }, [client, run, selectedTrack]);

  const addQueue = useCallback((): void => {
    if (!client || !selectedTrack) return;
    void run("queue.add", () => client.queue.add(selectedTrack.id));
  }, [client, run, selectedTrack]);

  const addToPlaylist = useCallback((): void => {
    if (!client || !selectedTrack || !playlistId) return;
    void run("playlists.addTrack", () =>
      client.playlists.addTrack(playlistId, selectedTrack.id),
    );
  }, [client, playlistId, run, selectedTrack]);

  const createPlaylist = useCallback((): void => {
    if (!client) return;
    void run("playlists.create", async () => {
      const detail = await client.playlists.create(newName);
      setPlaylistId(detail.id);
      setPlaylist(detail);
      return detail;
    });
  }, [client, newName, run]);

  const renamePlaylist = useCallback((): void => {
    if (!client || !playlistId) return;
    void run("playlists.update", () =>
      client.playlists.update(playlistId, { name: rename }),
    );
  }, [client, playlistId, rename, run]);

  const deletePlaylist = useCallback((): void => {
    if (!client || !playlistId) return;
    void run(
      "playlists.delete",
      async () => {
        const removed = await client.playlists.delete(playlistId);
        setPlaylistId("");
        setPlaylist(null);
        return { removed };
      },
      false,
    );
  }, [client, playlistId, run]);

  const importM3u = useCallback((): void => {
    if (!client) return;
    void run("playlists.importM3u", async () => {
      const result = await client.playlists.importM3u();
      setPlaylistId(result.playlist.id);
      setPlaylist(result.playlist);
      return result;
    });
  }, [client, run]);

  const exportM3u = useCallback((): void => {
    if (!client || !playlistId) return;
    void run("playlists.exportM3u", () =>
      client.playlists.exportM3u(playlistId),
    );
  }, [client, playlistId, run]);

  const addFolder = useCallback((): void => {
    if (!client) return;
    void run("folders.add + scan", async () => {
      const folder = await client.folders.add();
      if (!folder) return { cancelled: true };
      const job = await client.folders.scan(folder.id);
      return { folder, job };
    });
  }, [client, run]);

  const reloadPlaylist = useCallback(
    (id: string): void => {
      setPlaylistId(id);
      if (!client) return;
      void run(`playlists.get ${id}`, () => client.playlists.get(id)).then(
        () => undefined,
      );
    },
    [client, run],
  );

  if (!client) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>媒体 API 测试</CardTitle>
          <CardDescription>
            当前不是 Tauri 环境，无法创建 Media SDK 客户端。
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>媒体 API 测试面板</CardTitle>
          <CardDescription>
            开发调试用：直接调用 @lull/media-sdk，下方日志显示 API 结果与
            media:event。媒体连接由音乐库窗口统一维护，这里不会重复连接。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void refresh()}>
            刷新全部
          </Button>
          {/* <Button type="button" size="sm" variant="outline" disabled={true} onClick={addFolder}>
            导入音乐目录并扫描
          </Button> */}
          <span className="text-xs text-muted-foreground">
            {busy
              ? `执行中：${busy}`
              : `曲目 ${tracks.length} · 歌单 ${playlists.length} · 喜欢 ${favorites.length} · 历史 ${history.length}`}
          </span>
        </CardContent>
      </Card>

      <SmartShuffleApiPanel client={client} />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          错误：{error}
        </div>
      )}



      <div className="grid gap-4 lg:grid-cols-2">
        {/* <Card className="lg:col-span-1">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">API / 事件日志</CardTitle>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setLog([])}
            >
              清空日志
            </Button>
          </CardHeader>
          <CardContent className="max-h-80 space-y-2 overflow-y-auto">
            {log.length === 0 && (
              <p className="text-xs text-muted-foreground">暂无日志</p>
            )}
            {log.map((entry) => (
              <details
                key={entry.id}
                className="rounded border border-border/60 px-2 py-1 text-xs"
              >
                <summary className="cursor-pointer">
                  {new Date(entry.at).toLocaleTimeString()} · {entry.label}
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-muted/40 p-2">
                  {json(entry.data)}
                </pre>
              </details>
            ))}
          </CardContent>
        </Card> */}
      </div>
    </div>
  );
}
