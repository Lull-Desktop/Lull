"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { type LullMediaClient } from "./client.js";
import type {
  NoiseAsset,
  NoiseAssetQuery,
  NoisePresetQuery,
  NoisePresetSummary,
  NoiseSession,
  NoiseTrack,
} from "./types.js";

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
    try {
      const snapshot = await this.client.connect({
        topics: NOISE_TOPICS,
        levels: false,
      });
      this.session = snapshot.noiseSession;
      this.emit();
    } catch {
      // 连接失败时保持 null；调用方可通过 refresh 重新挂载。
    }
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopEvents?.();
    this.stopEvents = null;
    void this.client.disconnect();
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

export function useNoiseLibrary(query: NoiseAssetQuery = {}): NoiseLibraryState {
  const { useMediaClient } = requireReact();
  const client = useMediaClient();
  const store = storeFor(client);
  const [items, setItems] = useState<NoiseAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void client.noise.library
      .listAssets(query)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setTotal(page.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const off = store.onEvent((topic) => {
      if (topic === "noise.library.changed") setTick((value) => value + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, queryKey, tick]);

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
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void client.noise.presets
      .listPresets(query)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setTotal(page.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const off = store.onEvent((topic) => {
      if (topic.startsWith("noise.preset.")) setTick((value) => value + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, queryKey, tick]);

  return { items, total, loading, error, refresh };
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
    throw new Error("Noise hooks 必须从 @lull/media-sdk/react 导入");
  }
  return { useMediaClient: mediaClientHook };
}

let mediaClientHook: (() => LullMediaClient) | null = null;

/** 仅供 `./react` 注册；不对外导出。 */
export function bindMediaClientHook(hook: () => LullMediaClient): void {
  mediaClientHook = hook;
}
