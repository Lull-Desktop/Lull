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
    const stop = client.events.on((event) => {
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
    const missing = queueState.trackIds.filter((id) => !queueTracks[id]);
    if (missing.length > 0) {
      const loaded = await Promise.all(
        missing.map(async (id) => {
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
          <Button type="button" size="sm" variant="outline" onClick={addFolder}>
            导入音乐目录并扫描
          </Button>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前曲目</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <select
            value={selectedTrackId}
            onChange={(event) => setSelectedTrackId(event.target.value)}
            className="max-w-[22rem] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.title} · {track.artists.join(", ")}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" onClick={playSelected}>
            播放
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={toggleFavorite}
          >
            {selectedTrack?.favorite ? "取消喜欢" : "喜欢"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={addQueue}>
            加入队列
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addToPlaylist}
            disabled={!playlistId}
          >
            加入当前歌单
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">歌单</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <select
              value={playlistId}
              onChange={(event) => reloadPlaylist(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">选择歌单</option>
              {playlists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.trackCount}）
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="新歌单名称"
              />
              <Button type="button" size="sm" onClick={createPlaylist}>
                新建
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={rename}
                onChange={(event) => setRename(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="新名称"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={renamePlaylist}
                disabled={!playlistId}
              >
                重命名
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={deletePlaylist}
                disabled={!playlistId}
              >
                删除
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={importM3u}
              >
                导入 M3U
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={exportM3u}
                disabled={!playlistId}
              >
                导出 M3U
              </Button>
            </div>
            <div className="space-y-1">
              {playlist?.entries.map((entry, index) => (
                <div
                  key={entry.trackId}
                  className="flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {index + 1}. {entry.track?.title ?? entry.trackId}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run("playlists.reorder up", () =>
                        client.playlists.reorder(
                          playlistId,
                          entry.trackId,
                          Math.max(0, index - 1),
                        ),
                      );
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run("playlists.reorder down", () =>
                        client.playlists.reorder(
                          playlistId,
                          entry.trackId,
                          index + 1,
                        ),
                      );
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run("playlists.removeTrack", () =>
                        client.playlists.removeTrack(playlistId, entry.trackId),
                      );
                    }}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">喜欢 / 历史</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              播放曲目后应收到 history.changed，并出现在历史列表。
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {history.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {entry.track?.title ?? entry.trackId} ·{" "}
                    {new Date(entry.playedAt).toLocaleTimeString()}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (entry.track) {
                        void run("player.play from history", () =>
                          client.player.play(entry.track?.id ?? ""),
                        );
                      }
                    }}
                  >
                    播放
                  </Button>
                </div>
              ))}
              {history.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无历史</p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void run("history.clear", () => client.history.clear());
              }}
            >
              清空历史
            </Button>
            <div className="max-h-36 space-y-1 overflow-y-auto border-t border-border/50 pt-2">
              {favorites.map((track) => (
                <div key={track.id} className="truncate">
                  ♥ {track.title}
                </div>
              ))}
              {favorites.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无收藏</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">队列与事件</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              队列播放/移出后应收到 queue.changed；播放状态变化应收到
              player.state。
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {queue?.trackIds.map((trackId, index) => (
                <div key={trackId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {index + 1}. {queueTracks[trackId]?.title ?? trackId}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run("queue.playAt", () =>
                        client.queue.playAt(index),
                      );
                    }}
                  >
                    播放
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run("queue.remove", () =>
                        client.queue.remove(trackId),
                      );
                    }}
                  >
                    移出
                  </Button>
                </div>
              ))}
              {(!queue || queue.trackIds.length === 0) && (
                <p className="text-xs text-muted-foreground">队列为空</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
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
        </Card>
      </div>
    </div>
  );
}
