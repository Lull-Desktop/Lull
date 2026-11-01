/**
 * 媒体连接 Hub：一个窗口只维持一份 `media.connect` 订阅。
 *
 * 背景：Rust 侧 `media_connect` 按窗口 label 保存一份订阅，后一次覆盖前一次，
 * `media_disconnect` 清空整份。多个 React hook 各自 connect/disconnect 会互相
 * 踢掉订阅。Hub 把各 hook 需要的 topic/进度/level 需求取并集，只连接一次；
 * 订阅归零时不主动断开，避免 StrictMode 与 HMR 刷新造成抖动。
 */
import type { MediaEvent } from "./protocol.js";
import type {
  MediaOutput,
  NoiseSession,
  NoiseState,
  PlaybackSnapshot,
  PlayerState,
  QueueState,
} from "./types.js";

export interface MediaHubClient {
  connect(options: {
    topics?: string[];
    progressMs?: number;
    levels?: boolean;
  }): Promise<PlaybackSnapshot>;
  disconnect(): Promise<void>;
  events: {
    on(listener: (event: MediaEvent) => void): () => void;
  };
}

export interface MediaHubRequirements {
  topics: readonly string[];
  progressMs?: number;
  levels?: boolean;
}

export interface MediaHubStatus {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  revision: number;
}

interface Requirement {
  topics: Set<string>;
  progressMs: number;
  levels: boolean;
}

interface Desired {
  topics: string[];
  progressMs: number;
  levels: boolean;
}

const DEFAULT_PROGRESS_MS = 1000;

function snapshotOf(
  current: PlaybackSnapshot | null,
  event: MediaEvent,
): PlaybackSnapshot | null {
  if (!current) return current;
  switch (event.topic) {
    case "player.state":
      return { ...current, player: event.payload as PlayerState };
    case "queue.changed":
      return { ...current, queue: event.payload as QueueState };
    case "player.progress": {
      if (!current.player) return current;
      const payload = event.payload as {
        positionMs?: number;
        durationMs?: number | null;
      };
      return {
        ...current,
        player: {
          ...current.player,
          positionMs: payload.positionMs ?? current.player.positionMs,
          durationMs: payload.durationMs ?? current.player.durationMs,
        },
      };
    }
    case "noise.session.changed":
      return { ...current, noiseSession: event.payload as NoiseSession };
    case "noise.state":
      return { ...current, noise: event.payload as NoiseState };
    case "output.changed":
      return { ...current, output: event.payload as MediaOutput };
    default:
      return current;
  }
}

export class MediaSessionHub {
  private readonly client: MediaHubClient;
  private readonly requirements = new Map<number, Requirement>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: MediaEvent) => void>();
  private readonly stopEvents: () => void;
  private sequence = 0;
  private connected: Desired | null = null;
  private snapshotValue: PlaybackSnapshot | null = null;
  private statusValue: MediaHubStatus = {
    connected: false,
    connecting: false,
    error: null,
    revision: 0,
  };
  private connecting = false;
  private pending = false;

  constructor(client: MediaHubClient) {
    this.client = client;
    this.stopEvents = client.events.on((event) => this.handleEvent(event));
  }

  get snapshot(): PlaybackSnapshot | null {
    return this.snapshotValue;
  }

  get status(): MediaHubStatus {
    return this.statusValue;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent = (listener: (event: MediaEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  /** 登记一组需求；返回释放函数。释放不会断开连接。 */
  ensure(requirements: MediaHubRequirements): () => void {
    const id = ++this.sequence;
    this.requirements.set(id, {
      topics: new Set(requirements.topics),
      progressMs: requirements.progressMs ?? DEFAULT_PROGRESS_MS,
      levels: requirements.levels ?? false,
    });
    this.sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.requirements.delete(id);
      this.sync();
    };
  }

  destroy(): void {
    this.stopEvents();
    this.requirements.clear();
    this.eventListeners.clear();
    this.listeners.clear();
    this.statusValue = {
      connected: false,
      connecting: false,
      error: null,
      revision: 0,
    };
    void this.client.disconnect().catch(() => {
      // 销毁阶段不阻塞。
    });
  }

  private computed(): Desired | null {
    const topics = new Set<string>();
    let progressMs = Number.POSITIVE_INFINITY;
    let levels = false;
    for (const requirement of this.requirements.values()) {
      for (const topic of requirement.topics) topics.add(topic);
      progressMs = Math.min(progressMs, requirement.progressMs);
      levels = levels || requirement.levels;
    }
    if (topics.size === 0) return null;
    return {
      topics: [...topics].sort(),
      progressMs: Number.isFinite(progressMs)
        ? progressMs
        : DEFAULT_PROGRESS_MS,
      levels,
    };
  }

  private needsConnect(desired: Desired): boolean {
    const connected = this.connected;
    if (!connected) return true;
    if (desired.levels && !connected.levels) return true;
    if (desired.progressMs < connected.progressMs) return true;
    return desired.topics.some((topic) => !connected.topics.includes(topic));
  }

  private sync(): void {
    const desired = this.computed();
    if (!desired || !this.needsConnect(desired)) return;
    if (this.connecting) {
      this.pending = true;
      return;
    }
    void this.connect(desired);
  }

  private async connect(desired: Desired): Promise<void> {
    this.connecting = true;
    this.setStatus({ connecting: true, error: null });
    try {
      const snapshot = await this.client.connect({
        topics: desired.topics,
        progressMs: desired.progressMs,
        levels: desired.levels,
      });
      this.snapshotValue = snapshot;
      this.connected = desired;
      this.setStatus({
        connected: true,
        connecting: false,
        error: null,
        revision: snapshot.revision,
      });
    } catch (error) {
      this.connected = null;
      this.setStatus({
        connected: false,
        connecting: false,
        error: error instanceof Error ? error.message : String(error),
        revision: 0,
      });
    } finally {
      this.connecting = false;
      if (this.pending) {
        this.pending = false;
        this.sync();
      }
    }
  }

  private setStatus(patch: Partial<MediaHubStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit();
  }

  private handleEvent(event: MediaEvent): void {
    for (const listener of this.eventListeners) listener(event);
    const next = snapshotOf(this.snapshotValue, event);
    if (next === this.snapshotValue) return;
    this.snapshotValue = next;
    if (next) {
      this.statusValue = {
        ...this.statusValue,
        revision: Math.max(
          this.statusValue.revision,
          event.revision,
          next.revision,
        ),
      };
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const hubs = new WeakMap<MediaHubClient, MediaSessionHub>();

/** 每个 client 一个 Hub；Provider 重建 client 时自然换新 Hub。 */
export function mediaHubFor(client: MediaHubClient): MediaSessionHub {
  const existing = hubs.get(client);
  if (existing) return existing;
  const hub = new MediaSessionHub(client);
  hubs.set(client, hub);
  return hub;
}
