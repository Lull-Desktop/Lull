/**
 * Media API v1 线上协议。与 Rust `media/api/protocol.rs` 对齐。
 */

import type { MediaErrorBody } from "./types";

export const MEDIA_PROTOCOL = 1 as const;

export type MediaNamespace =
  | "library"
  | "playlists"
  | "favorites"
  | "tags"
  | "history"
  | "player"
  | "queue"
  | "noise"
  | "system";

export interface MediaRequest {
  protocol: typeof MEDIA_PROTOCOL;
  requestId: string;
  namespace: MediaNamespace;
  method: string;
  args?: unknown;
  expectedRevision?: number;
  expectedVersion?: number;
}

export interface MediaResponse {
  protocol: typeof MEDIA_PROTOCOL;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: MediaErrorBody;
  revision: number;
}

export interface MediaConnectRequest {
  topics?: string[];
  progressMs?: number;
  levels?: boolean;
}

export type MediaEventTopic =
  | "player.state"
  | "player.progress"
  | "player.level"
  | "queue.changed"
  | "noise.state"
  | "noise.level"
  | "output.changed"
  | "library.changed"
  | "library.scan.started"
  | "library.scan.progress"
  | "library.scan.finished"
  | "playlists.changed"
  | "favorites.changed"
  | "tags.changed"
  | "history.changed";

export interface MediaEvent<T = unknown> {
  protocol: typeof MEDIA_PROTOCOL;
  topic: MediaEventTopic;
  revision: number;
  at: number;
  eventId?: string;
  payload: T;
}
