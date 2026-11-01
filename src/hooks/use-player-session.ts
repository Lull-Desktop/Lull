"use client";

import type {
  MediaEvent,
  PlayerState,
  QueueState,
  TrackSummary,
} from "@lull/media-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMediaClient } from "./use-media-client";

export type PlayerActions = {
  play(trackId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setMode(mode: PlayerState["mode"]): Promise<void>;
  addSource(): Promise<void>;
  refreshLibrary(): Promise<void>;
};

export type PlayerSession = {
  player: PlayerState | null;
  queue: QueueState | null;
  tracks: TrackSummary[];
  levelRef: React.RefObject<number>;
  getCoverUrl(trackId: string): Promise<string | null>;
  actions: PlayerActions;
};

const EMPTY_ACTIONS: PlayerActions = {
  play: async () => {},
  pause: async () => {},
  resume: async () => {},
  seek: async () => {},
  next: async () => {},
  previous: async () => {},
  setVolume: async () => {},
  setMuted: async () => {},
  setMode: async () => {},
  addSource: async () => {},
  refreshLibrary: async () => {},
};

/**
 * 官方播放器窗口的会话：连接 Media Service、订阅播放/队列事件并按需重查曲库。
 * 浏览器预览没有客户端时返回空状态，组件使用内置曲目回退。
 */
export function usePlayerSession(): PlayerSession {
  const clientRef = useRef(getMediaClient());
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const levelRef = useRef(0);

  const refreshLibrary = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const page = await client.library.listTracks({ pageSize: 200 });
      setTracks(page.items);
    } catch {
      // 资料库暂时不可用时保留当前列表。
    }
  }, []);

  const getCoverUrl = useCallback(
    async (trackId: string): Promise<string | null> => {
      const client = clientRef.current;
      if (!client) return null;
      try {
        return await client.library.getCoverUrl(trackId);
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    let alive = true;
    let ready = false;
    let snapshotRevision = 0;
    const pending: MediaEvent[] = [];

    const handle = (event: MediaEvent): void => {
      if (event.topic === "player.state") {
        setPlayer(event.payload as PlayerState);
      } else if (event.topic === "queue.changed") {
        setQueue(event.payload as QueueState);
      } else if (event.topic === "player.progress") {
        const payload = event.payload as {
          positionMs: number;
          durationMs?: number | null;
        };
        setPlayer((previous) =>
          previous
            ? {
                ...previous,
                positionMs: payload.positionMs,
                durationMs: payload.durationMs ?? previous.durationMs,
              }
            : previous,
        );
      } else if (event.topic === "player.level") {
        const payload = event.payload as { player: number };
        levelRef.current = payload.player;
      } else if (event.topic === "library.changed") {
        void refreshLibrary();
      }
    };

    // 先挂监听再 connect：connect 返回快照前到达的事件先缓存，拿到快照后回放，
    // 避免“快照与订阅之间”的状态丢失。
    const stop = client.events.on((event) => {
      if (!alive) return;
      if (!ready) {
        pending.push(event);
        return;
      }
      if (
        (event.topic === "player.state" || event.topic === "queue.changed") &&
        event.revision <= snapshotRevision
      ) {
        return;
      }
      handle(event);
    });

    void client
      .connect({
        topics: [
          "player.state",
          "player.progress",
          "queue.changed",
          "player.level",
        ],
        progressMs: 500,
        levels: true,
      })
      .then((snapshot) => {
        if (!alive) return;
        snapshotRevision = snapshot.player?.revision ?? 0;
        setPlayer(snapshot.player ?? null);
        setQueue(snapshot.queue ?? null);
        ready = true;
        for (const event of pending) {
          if (
            (event.topic === "player.state" ||
              event.topic === "queue.changed") &&
            event.revision <= snapshotRevision
          ) {
            continue;
          }
          handle(event);
        }
        pending.length = 0;
      })
      .catch(() => {});
    void refreshLibrary();
    // 事件偶发丢失/窗口被重新显示时，聚焦再对账一次曲库。
    const onFocus = (): void => {
      void refreshLibrary();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      stop();
      void client.disconnect();
    };
  }, [refreshLibrary]);

  const actions: PlayerActions = clientRef.current
    ? {
        play: async (trackId) => {
          await clientRef.current?.player.play(trackId);
        },
        pause: async () => {
          await clientRef.current?.player.pause();
        },
        resume: async () => {
          await clientRef.current?.player.resume();
        },
        seek: async (positionMs) => {
          await clientRef.current?.player.seek(positionMs);
        },
        next: async () => {
          await clientRef.current?.player.next();
        },
        previous: async () => {
          await clientRef.current?.player.previous();
        },
        setVolume: async (volume) => {
          await clientRef.current?.player.setVolume(volume);
        },
        setMuted: async (muted) => {
          await clientRef.current?.player.setMuted(muted);
        },
        setMode: async (mode) => {
          await clientRef.current?.player.setMode(mode);
        },
        addSource: async () => {
          const client = clientRef.current;
          if (!client) return;
          const added = await client.library.addSource();
          if (!added) return;
          await client.library.startScan(added.id);
          // 扫描在 Rust 后台执行；这里轻量轮询几次，避免用户停留在空列表。
          for (const delay of [1200, 3500, 7000, 12000]) {
            window.setTimeout(() => {
              void refreshLibrary();
            }, delay);
          }
        },
        refreshLibrary,
      }
    : EMPTY_ACTIONS;

  return { player, queue, tracks, levelRef, getCoverUrl, actions };
}
