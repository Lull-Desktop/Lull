/**
 * Lull Media SDK 核心客户端：框架无关，不依赖 React/Vue。
 *
 * 官方窗口通过 Tauri transport 使用；第三方 Widget 后续通过宿主壳 transport，
 * 单测用 memory transport。业务状态以 Rust 为准，本客户端只做传输与缓存。
 */

import { LullMediaError } from "./errors";
import {
  MEDIA_PROTOCOL,
  type MediaConnectRequest,
  type MediaEvent,
  type MediaNamespace,
  type MediaRequest,
  type MediaResponse,
} from "./protocol";
import { createTauriTransport, isTauriRuntime } from "./tauri";
import type { MediaTransport } from "./transport";
import type {
  AlbumSummary,
  ArtistSummary,
  ConnectOptions,
  NoiseSound,
  NoiseState,
  Page,
  PlaybackSnapshot,
  PlayerState,
  QueueState,
  ScanJobView,
  SourceView,
  TrackDetail,
  TrackQuery,
  TrackSummary,
} from "./types";

export interface CreateMediaClientOptions {
  transport?: MediaTransport;
}

export interface LullMediaClient {
  readonly protocol: typeof MEDIA_PROTOCOL;
  readonly revision: number;
  readonly snapshot: PlaybackSnapshot | null;
  connect(options?: ConnectOptions): Promise<PlaybackSnapshot>;
  disconnect(): Promise<void>;
  call<T>(
    namespace: MediaNamespace,
    method: string,
    args?: unknown,
  ): Promise<T>;
  library: {
    listSources(): Promise<SourceView[]>;
    addSource(): Promise<SourceView | null>;
    removeSource(sourceId: string): Promise<boolean>;
    startScan(sourceId: string): Promise<ScanJobView>;
    cancelScan(sourceId: string): Promise<boolean>;
    listTracks(query?: TrackQuery): Promise<Page<TrackSummary>>;
    getTrack(trackId: string): Promise<TrackDetail>;
    getCoverUrl(trackId: string): Promise<string | null>;
    listArtists(): Promise<ArtistSummary[]>;
    listAlbums(): Promise<AlbumSummary[]>;
    listGenres(): Promise<string[]>;
  };
  player: {
    getState(): Promise<PlayerState>;
    play(trackId?: string): Promise<PlayerState>;
    pause(): Promise<PlayerState>;
    resume(): Promise<PlayerState>;
    stop(): Promise<PlayerState>;
    seek(positionMs: number): Promise<PlayerState>;
    next(): Promise<PlayerState>;
    previous(): Promise<PlayerState>;
    setVolume(volume: number): Promise<PlayerState>;
    setMuted(muted: boolean): Promise<PlayerState>;
    setMode(mode: PlayerState["mode"]): Promise<PlayerState>;
  };
  queue: {
    get(): Promise<QueueState>;
    add(trackId: string, index?: number): Promise<QueueState>;
    remove(trackId: string): Promise<QueueState>;
    clear(): Promise<QueueState>;
    move(fromIndex: number, toIndex: number): Promise<QueueState>;
    playAt(index: number): Promise<PlayerState>;
  };
  noise: {
    getState(): Promise<NoiseState>;
    getSounds(): Promise<NoiseSound[]>;
    activate(): Promise<NoiseState>;
    setLayer(
      soundId: string,
      patch: { enabled?: boolean; volume?: number },
    ): Promise<NoiseState>;
    setMaster(volume: number): Promise<NoiseState>;
    setMuted(muted: boolean): Promise<NoiseState>;
    setSleepTimer(minutes: number): Promise<NoiseState>;
    reset(): Promise<NoiseState>;
  };
  events: {
    on<T = unknown>(listener: (event: MediaEvent<T>) => void): () => void;
  };
  dispose(): void;
}

function requestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function transportFor(options: CreateMediaClientOptions): MediaTransport {
  if (options.transport) return options.transport;
  if (isTauriRuntime()) return createTauriTransport();
  throw new LullMediaError({
    code: "transport.unavailable",
    message: "当前环境没有 Media Transport；请传入 transport",
  });
}

function unwrap<T>(response: MediaResponse): T {
  if (response.protocol !== MEDIA_PROTOCOL) {
    throw new LullMediaError({
      code: "protocol.unsupported",
      message: `不支持的媒体协议版本：${response.protocol}`,
    });
  }
  if (!response.ok) {
    throw new LullMediaError(
      response.error ?? {
        code: "internal",
        message: "媒体请求失败",
      },
    );
  }
  return response.result as T;
}

function wrapTransportError(error: unknown): LullMediaError {
  return new LullMediaError({
    code: "transport.failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** 创建客户端；官方窗口会自动使用 Tauri 传输。 */
export function createMediaClient(
  options: CreateMediaClientOptions = {},
): LullMediaClient {
  const transport = transportFor(options);
  let revision = 0;
  let snapshot: PlaybackSnapshot | null = null;

  const call = async <T>(
    namespace: MediaNamespace,
    method: string,
    args?: unknown,
  ): Promise<T> => {
    const request: MediaRequest = {
      protocol: MEDIA_PROTOCOL,
      requestId: requestId(),
      namespace,
      method,
      args,
    };
    try {
      const response = await transport.call(request);
      revision = Math.max(revision, response.revision);
      return unwrap<T>(response);
    } catch (error) {
      if (error instanceof LullMediaError) throw error;
      throw wrapTransportError(error);
    }
  };

  const connect = async (
    options: ConnectOptions = {},
  ): Promise<PlaybackSnapshot> => {
    if (!transport.connect) {
      throw new LullMediaError({
        code: "transport.unavailable",
        message: "当前 transport 不支持 connect",
      });
    }
    const request: MediaConnectRequest = {
      topics: options.topics,
      progressMs: options.progressMs,
      levels: options.levels,
    };
    try {
      const response = await transport.connect(request);
      revision = Math.max(revision, response.revision);
      snapshot = unwrap<PlaybackSnapshot>(response);
      return snapshot;
    } catch (error) {
      if (error instanceof LullMediaError) throw error;
      throw wrapTransportError(error);
    }
  };

  const library = {
    listSources: () => call<SourceView[]>("library", "listSources"),
    addSource: () => call<SourceView | null>("library", "addSource"),
    removeSource: async (sourceId: string) => {
      const result = await call<{ removed: boolean }>(
        "library",
        "removeSource",
        { sourceId },
      );
      return result.removed;
    },
    startScan: (sourceId: string) =>
      call<ScanJobView>("library", "startScan", { sourceId }),
    cancelScan: async (sourceId: string) => {
      const result = await call<{ cancelled: boolean }>(
        "library",
        "cancelScan",
        { sourceId },
      );
      return result.cancelled;
    },
    listTracks: (query: TrackQuery = {}) =>
      call<Page<TrackSummary>>("library", "listTracks", query),
    getTrack: (trackId: string) =>
      call<TrackDetail>("library", "getTrack", { trackId }),
    getCoverUrl: async (trackId: string) => {
      const result = await call<{ url: string | null }>(
        "library",
        "getCoverUrl",
        { trackId },
      );
      return result.url;
    },
    listArtists: () => call<ArtistSummary[]>("library", "listArtists"),
    listAlbums: () => call<AlbumSummary[]>("library", "listAlbums"),
    listGenres: () => call<string[]>("library", "listGenres"),
  };

  const player = {
    getState: () => call<PlayerState>("player", "getState"),
    play: (trackId?: string) =>
      call<PlayerState>("player", "play", trackId ? { trackId } : {}),
    pause: () => call<PlayerState>("player", "pause"),
    resume: () => call<PlayerState>("player", "resume"),
    stop: () => call<PlayerState>("player", "stop"),
    seek: (positionMs: number) =>
      call<PlayerState>("player", "seek", { positionMs }),
    next: () => call<PlayerState>("player", "next"),
    previous: () => call<PlayerState>("player", "previous"),
    setVolume: (volume: number) =>
      call<PlayerState>("player", "setVolume", { volume }),
    setMuted: (muted: boolean) =>
      call<PlayerState>("player", "setMuted", { muted }),
    setMode: (mode: PlayerState["mode"]) =>
      call<PlayerState>("player", "setMode", { mode }),
  };

  const queue = {
    get: () => call<QueueState>("queue", "get"),
    add: (trackId: string, index?: number) =>
      call<QueueState>("queue", "add", { trackId, index }),
    remove: (trackId: string) =>
      call<QueueState>("queue", "remove", { trackId }),
    clear: () => call<QueueState>("queue", "clear"),
    move: (fromIndex: number, toIndex: number) =>
      call<QueueState>("queue", "move", { fromIndex, toIndex }),
    playAt: (index: number) => call<PlayerState>("queue", "playAt", { index }),
  };

  const noise = {
    getState: () => call<NoiseState>("noise", "getState"),
    getSounds: () => call<NoiseSound[]>("noise", "getSounds"),
    activate: () => call<NoiseState>("noise", "activate"),
    setLayer: (
      soundId: string,
      patch: { enabled?: boolean; volume?: number },
    ) => call<NoiseState>("noise", "setLayer", { soundId, ...patch }),
    setMaster: (volume: number) =>
      call<NoiseState>("noise", "setMaster", { volume }),
    setMuted: (muted: boolean) =>
      call<NoiseState>("noise", "setMuted", { muted }),
    setSleepTimer: (minutes: number) =>
      call<NoiseState>("noise", "setSleepTimer", { minutes }),
    reset: () => call<NoiseState>("noise", "reset"),
  };

  return {
    protocol: MEDIA_PROTOCOL,
    get revision() {
      return revision;
    },
    get snapshot() {
      return snapshot;
    },
    connect,
    async disconnect() {
      if (!transport.disconnect) return;
      try {
        await transport.disconnect();
      } catch {
        // 断开失败不阻塞卸载。
      }
    },
    call: call as LullMediaClient["call"],
    library,
    player,
    queue,
    noise,
    events: {
      on<T = unknown>(listener: (event: MediaEvent<T>) => void): () => void {
        if (!transport.subscribe) return () => {};
        return transport.subscribe((event) => listener(event as MediaEvent<T>));
      },
    },
    dispose() {
      void transport.disconnect?.();
    },
  };
}
