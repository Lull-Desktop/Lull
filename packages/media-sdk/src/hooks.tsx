"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { LullMediaClient } from "./client.js";
import { type MediaHubStatus, mediaHubFor } from "./hub.js";
import { queueTracksFor } from "./queue.js";
import type {
  DirectoryCrumb,
  DirectoryEntry,
  DirectoryListing,
  NoiseAsset,
  NoiseAssetQuery,
  NoisePresetQuery,
  NoisePresetSummary,
  NoiseSession,
  NoiseTrack,
  PlayerState,
  QueueState,
  TrackSummary,
} from "./types.js";

const LIBRARY_PAGE_SIZE = 200;
const NOISE_TOPICS = [
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.volume.changed",
  "noise.library.changed",
  "noise.preset.created",
  "noise.preset.updated",
  "noise.preset.deleted",
];

type Listener = () => void;

class NoiseStore {
  private readonly client: LullMediaClient;
  private session: NoiseSession | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<(topic: string) => void>();
  private refs = 0;
  private started = false;
  private stopEvents: (() => void) | null = null;
  private stopHub: (() => void) | null = null;
  private release: (() => void) | null = null;

  constructor(client: LullMediaClient) {
    this.client = client;
  }

  get = (): NoiseSession | null => this.session;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.refs += 1;
    if (!this.started) void this.start();
    return () => {
      this.listeners.delete(listener);
      this.refs -= 1;
      if (this.refs === 0) this.stop();
    };
  };

  onEvent = (listener: (topic: string) => void): (() => void) => {
    this.eventListeners.add(listener);
    this.refs += 1;
    if (!this.started) void this.start();
    return () => {
      this.eventListeners.delete(listener);
      this.refs -= 1;
      if (this.refs === 0) this.stop();
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const hub = mediaHubFor(this.client);
    this.stopHub = hub.subscribe(() => {
      const snapshot = hub.snapshot;
      if (!snapshot) return;
      this.session = snapshot.noiseSession;
      this.emit();
    });
    this.stopEvents = this.client.events.on((event) => {
      if (event.topic === "noise.session.changed") {
        this.session = event.payload as NoiseSession;
        this.emit();
      } else if (
        event.topic.startsWith("noise.track.") ||
        event.topic === "noise.volume.changed"
      ) {
        void this.client.noise.session
          .getCurrent()
          .then((session) => {
            this.session = session;
            this.emit();
          })
          .catch(() => {});
      }
      for (const listener of this.eventListeners) listener(event.topic);
    });
    this.release = hub.ensure({ topics: NOISE_TOPICS, levels: false });
    const snapshot = hub.snapshot;
    if (snapshot) {
      this.session = snapshot.noiseSession;
      this.emit();
    }
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    this.release?.();
    this.release = null;
    this.stopHub?.();
    this.stopHub = null;
    this.stopEvents?.();
    this.stopEvents = null;
  }
}

const stores = new WeakMap<LullMediaClient, NoiseStore>();

function storeFor(client: LullMediaClient): NoiseStore {
  let store = stores.get(client);
  if (!store) {
    store = new NoiseStore(client);
    stores.set(client, store);
  }
  return store;
}

export function useNoiseSession(): NoiseSession | null {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const store = storeFor(client);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useNoiseTracks(): NoiseTrack[] {
  const session = useNoiseSession();
  return useMemo(() => session?.tracks ?? [], [session]);
}

export type NoiseLibraryState = {
  items: NoiseAsset[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useNoiseLibrary(
  query: NoiseAssetQuery = {},
): NoiseLibraryState {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const store = storeFor(client);
  const [items, setItems] = useState<NoiseAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onEvent = store.onEvent;
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey intentionally triggers refetch; onEvent is stable.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void client.noise.library
      .listAssets(queryRef.current)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setTotal(page.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (alive)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const off = onEvent((topic) => {
      if (topic === "noise.library.changed") setTick((value) => value + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, queryKey, tick, onEvent]);

  return { items, total, loading, error, refresh };
}

export type NoisePresetsState = {
  items: NoisePresetSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useNoisePresets(
  query: NoisePresetQuery = {},
): NoisePresetsState {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const store = storeFor(client);
  const [items, setItems] = useState<NoisePresetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onEvent = store.onEvent;
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey intentionally triggers refetch; onEvent is stable.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void client.noise.presets
      .listPresets(queryRef.current)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setTotal(page.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (alive)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const off = onEvent((topic) => {
      if (topic.startsWith("noise.preset.")) setTick((value) => value + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, queryKey, tick, onEvent]);

  return { items, total, loading, error, refresh };
}

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
  addToQueue(trackId: string): Promise<void>;
  setFavorite(trackId: string, favorite: boolean): Promise<void>;
  setAdvanceList(trackIds: string[]): Promise<void>;
  addSource(): Promise<void>;
  refreshLibrary(): Promise<void>;
};

export type PlayerSession = {
  player: PlayerState | null;
  queue: QueueState | null;
  /** 按宿主队列顺序解析出的完整曲目；不受曲库分页限制。 */
  queueTracks: TrackSummary[];
  tracks: TrackSummary[];
  /** 曲库总条数（服务端分页 total）。 */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  levelRef: RefObject<number>;
  getCoverUrl(trackId: string): Promise<string | null>;
  actions: PlayerActions;
};

/** 当前 window 的媒体连接状态；所有 hook 共享同一个 Hub。 */
export function useMediaHubStatus(): MediaHubStatus {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const hub = mediaHubFor(client);
  const getSnapshot = useCallback(() => hub.status, [hub]);
  return useSyncExternalStore(hub.subscribe, getSnapshot, getSnapshot);
}

/**
 * 官方播放器会话：player/queue 快照 + 曲库列表 + 控制动作。
 * 与 Noise hooks 共用 `MediaSessionHub`，不会互相覆盖订阅。
 */
export function usePlayerSession(
  options: { includeLibrary?: boolean } = {},
): PlayerSession {
  const includeLibrary = options.includeLibrary !== false;
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const hub = mediaHubFor(client);
  useEffect(
    () =>
      hub.ensure({
        topics: [
          "player.state",
          "player.progress",
          "player.level",
          "queue.changed",
          "library.changed",
        ],
        progressMs: 500,
        levels: true,
      }),
    [hub],
  );
  const getSnapshot = useCallback(() => hub.snapshot, [hub]);
  const snapshot = useSyncExternalStore(
    hub.subscribe,
    getSnapshot,
    getSnapshot,
  );
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [queueTracks, setQueueTracks] = useState<TrackSummary[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const totalRef = useRef(0);
  const loadedRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const generationRef = useRef(0);
  const levelRef = useRef(0);

  const loadLibrary = useCallback(async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    try {
      const first = await client.library.listTracks({
        page: 1,
        pageSize: LIBRARY_PAGE_SIZE,
      });
      if (generation !== generationRef.current) return;
      pageRef.current = 1;
      totalRef.current = first.total;
      loadedRef.current = first.items.length;
      setTracks(first.items);
      setLibraryTotal(first.total);
    } catch {
      // 资料库暂不可用时保留当前列表。
    }
  }, [client]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMoreRef.current || loadedRef.current >= totalRef.current) {
      return;
    }
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    try {
      const next = await client.library.listTracks({
        page: nextPage,
        pageSize: LIBRARY_PAGE_SIZE,
      });
      if (generation !== generationRef.current) return;
      pageRef.current = nextPage;
      totalRef.current = next.total;
      setTracks((previous) => {
        const seen = new Set(previous.map((track) => track.id));
        const appended = next.items.filter((track) => !seen.has(track.id));
        const merged = [...previous, ...appended];
        loadedRef.current = merged.length;
        return merged;
      });
      setLibraryTotal(next.total);
    } catch {
      // 滚动加载失败时保留已加载页，下次滚动重试。
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [client]);

  useEffect(() => {
    if (!includeLibrary) return;
    void loadLibrary();
    return hub.onEvent((event) => {
      if (event.topic === "library.changed") void loadLibrary();
    });
  }, [hub, includeLibrary, loadLibrary]);

  // 队列必须按 ID 解析：曲库列表只取第一页，队列里的老曲目可能不在其中。
  const queueKey = (snapshot?.queue?.trackIds ?? []).join("\u0000");
  useEffect(() => {
    const ids = queueKey ? queueKey.split("\u0000") : [];
    if (ids.length === 0) {
      setQueueTracks([]);
      return;
    }
    let alive = true;
    const byId = new Map(tracks.map((track) => [track.id, track]));
    const missing = ids.filter((id) => !byId.has(id));
    const publish = (): void => {
      setQueueTracks(queueTracksFor(ids, byId));
    };
    publish();
    if (missing.length === 0) return;
    void Promise.all(
      missing.map((id) => client.library.getTrack(id).catch(() => null)),
    ).then((resolved) => {
      if (!alive) return;
      for (const track of resolved) {
        if (track) byId.set(track.id, track);
      }
      setQueueTracks(queueTracksFor(ids, byId));
    });
    return () => {
      alive = false;
    };
  }, [client, queueKey, tracks]);

  useEffect(
    () =>
      hub.onEvent((event) => {
        if (event.topic !== "player.level") return;
        const payload = event.payload as { player?: number };
        levelRef.current = payload.player ?? 0;
      }),
    [hub],
  );

  const getCoverUrl = useCallback(
    (trackId: string): Promise<string | null> =>
      client.library.getCoverUrl(trackId).catch(() => null),
    [client],
  );

  const actions = useMemo<PlayerActions>(
    () => ({
      play: async (trackId) => {
        await client.player.play(trackId);
      },
      pause: async () => {
        await client.player.pause();
      },
      resume: async () => {
        await client.player.resume();
      },
      seek: async (positionMs) => {
        await client.player.seek(positionMs);
      },
      next: async () => {
        await client.player.next();
      },
      previous: async () => {
        await client.player.previous();
      },
      setVolume: async (volume) => {
        await client.player.setVolume(volume);
      },
      setMuted: async (muted) => {
        await client.player.setMuted(muted);
      },
      setMode: async (mode) => {
        await client.player.setMode(mode);
      },
      addToQueue: async (trackId) => {
        await client.queue.add(trackId);
      },
      setFavorite: async (trackId, favorite) => {
        await client.favorites.set(trackId, favorite);
        setTracks((previous) =>
          previous.map((track) =>
            track.id === trackId ? { ...track, favorite } : track,
          ),
        );
      },
      setAdvanceList: async (trackIds) => {
        await client.player.setAdvanceList(trackIds);
      },
      addSource: async () => {
        const added = await client.library.addSource();
        if (!added) return;
        await client.library.startScan(added.id);
        // 扫描在 Rust 后台执行；轻量轮询几次，避免用户停留在空列表。
        for (const delay of [1200, 3500, 7000, 12000]) {
          window.setTimeout(() => {
            void loadLibrary();
          }, delay);
        }
      },
      refreshLibrary: loadLibrary,
    }),
    [client, loadLibrary],
  );

  const hasMore = tracks.length < libraryTotal;
  return {
    player: snapshot?.player ?? null,
    queue: snapshot?.queue ?? null,
    queueTracks,
    tracks,
    total: libraryTotal,
    hasMore,
    loadingMore,
    loadMore,
    levelRef,
    getCoverUrl,
    actions,
  };
}

export type DirectoryBrowserLocation = {
  folderId: string | null;
  path: string;
};

export type DirectoryBrowser = {
  location: DirectoryBrowserLocation;
  listing: DirectoryListing | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  openRoot(): void;
  enterDirectory(entry: DirectoryEntry): void;
  goBack(): void;
  goCrumb(crumb: DirectoryCrumb): void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
};

/**
 * 单层目录浏览：一次只保留当前目录的子目录和直接音频文件。
 * 分页只作用于当前目录的 tracks，directories 一次返回。
 */
export function useDirectoryBrowser(): DirectoryBrowser {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const [location, setLocation] = useState<DirectoryBrowserLocation>({
    folderId: null,
    path: "",
  });
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const load = useCallback(
    async (
      target: DirectoryBrowserLocation,
      page = 1,
      append = false,
    ): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
        setListing(null);
      }
      try {
        const result = await client.library.listDirectory({
          ...(target.folderId ? { folderId: target.folderId } : {}),
          path: target.path,
          page,
          pageSize: LIBRARY_PAGE_SIZE,
        });
        if (generation !== generationRef.current) return;
        setListing((previous) => {
          if (!append || !previous) return result;
          return {
            ...result,
            tracks: {
              ...result.tracks,
              items: [...previous.tracks.items, ...result.tracks.items],
            },
          };
        });
      } catch (reason) {
        if (generation !== generationRef.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load(location, 1, false);
  }, [load, location]);

  // 扫描/收藏/队列外的资料库变化时刷新当前目录，保持当前位置不跳级。
  useEffect(
    () =>
      client.events.on((event) => {
        if (event.topic === "library.changed") {
          void load(location, 1, false);
        }
      }),
    [client, load, location],
  );

  const go = useCallback((next: DirectoryBrowserLocation): void => {
    setLocation((previous) =>
      previous.folderId === next.folderId && previous.path === next.path
        ? previous
        : next,
    );
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMoreRef.current || !listing?.tracks.hasMore) return;
    loadingMoreRef.current = true;
    try {
      await load(location, listing.tracks.page + 1, true);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [listing, load, location]);

  return {
    location,
    listing,
    loading,
    loadingMore,
    error,
    openRoot: () => go({ folderId: null, path: "" }),
    enterDirectory: (entry) =>
      go({ folderId: entry.folderId, path: entry.path }),
    goBack: () => {
      const parent = listing?.parent;
      if (parent) {
        go({ folderId: parent.folderId ?? null, path: parent.path });
      }
    },
    goCrumb: (crumb) =>
      go({ folderId: crumb.folderId ?? null, path: crumb.path }),
    reload: () => load(location, 1, false),
    loadMore,
  };
}

/**
 * 延迟读取 React 上下文钩子，避免把 hooks 包进额外的 React 依赖边界。
 * `requireReact` 只存在于本模块，实际构建时由 `./react` 重新导出。
 */
function requireReact(): {
  useMediaClient: () => LullMediaClient;
} {
  // 由 ./react 在导入时注入，避免循环依赖。
  if (!mediaClientHook) {
    throw new Error("媒体 hooks 必须从 @lull/media-sdk/react 导入");
  }
  return { useMediaClient: mediaClientHook };
}

let mediaClientHook: (() => LullMediaClient) | null = null;

/** 仅供 `./react` 注册；不对外导出。 */
export function bindMediaClientHook(hook: () => LullMediaClient): void {
  mediaClientHook = hook;
}
