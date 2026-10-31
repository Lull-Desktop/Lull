/**
 * Lull Media SDK 核心客户端：框架无关，不依赖 React/Vue。
 *
 * P1 只包含资料库读取/扫描与来源管理；播放、队列、白噪音、歌单会在后续阶段
 * 以同样的 namespace/method 形状加入。
 */

import { LullMediaError } from "./errors";
import {
  MEDIA_PROTOCOL,
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
  Page,
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
    listTracks(query?: TrackQuery): Promise<Page<TrackSummary>>;
    getTrack(trackId: string): Promise<TrackDetail>;
    listArtists(): Promise<ArtistSummary[]>;
    listAlbums(): Promise<AlbumSummary[]>;
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

/** 创建客户端；官方窗口会自动使用 Tauri 传输。 */
export function createMediaClient(
  options: CreateMediaClientOptions = {},
): LullMediaClient {
  const transport = transportFor(options);
  let revision = 0;
  let unlisten: (() => void) | null = null;

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
    let response: MediaResponse;
    try {
      response = await transport.call(request);
    } catch (error) {
      throw new LullMediaError({
        code: "transport.failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (response.protocol !== MEDIA_PROTOCOL) {
      throw new LullMediaError({
        code: "protocol.unsupported",
        message: `不支持的媒体协议版本：${response.protocol}`,
      });
    }
    revision = Math.max(revision, response.revision);
    if (!response.ok) {
      throw new LullMediaError(
        response.error ?? {
          code: "internal",
          message: "媒体请求失败",
        },
      );
    }
    return response.result as T;
  };

  const library = {
    listSources: () => call<SourceView[]>("library", "listSources"),
    addSource: () => call<SourceView | null>("library", "addSource"),
    removeSource: async (sourceId: string) => {
      const result = await call<{ removed: boolean }>(
        "library",
        "removeSource",
        {
          sourceId,
        },
      );
      return result.removed;
    },
    startScan: (sourceId: string) =>
      call<ScanJobView>("library", "startScan", { sourceId }),
    listTracks: (query: TrackQuery = {}) =>
      call<Page<TrackSummary>>("library", "listTracks", query),
    getTrack: (trackId: string) =>
      call<TrackDetail>("library", "getTrack", { trackId }),
    listArtists: () => call<ArtistSummary[]>("library", "listArtists"),
    listAlbums: () => call<AlbumSummary[]>("library", "listAlbums"),
  };

  const client: LullMediaClient = {
    protocol: MEDIA_PROTOCOL,
    get revision() {
      return revision;
    },
    call: call as LullMediaClient["call"],
    library,
    events: {
      on<T = unknown>(listener: (event: MediaEvent<T>) => void): () => void {
        if (!transport.subscribe) return () => {};
        return transport.subscribe((event) => listener(event as MediaEvent<T>));
      },
    },
    dispose() {
      unlisten?.();
      unlisten = null;
    },
  };

  return client;
}
