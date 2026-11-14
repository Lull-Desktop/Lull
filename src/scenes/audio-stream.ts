/**
 * 壁纸顶层页面的音频响应事件流。
 *
 * Rust Audio Reactive Service 通过 Tauri 定向事件 `wallpaper-audio` 下发
 * `AudioFrame`；这里按当前窗口 label 订阅（不能用 Any，否则多屏会串台），
 * 校验载荷并缓存最新快照，供场景桥按 Manifest 授权后转发。
 *
 * 浏览器预览/单测没有 Tauri 事件系统，安全降级为 `not-supported`。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentWindowLabel, hasTauriRuntime } from "@/core/window-label";
import {
  AUDIO_PROTOCOL,
  type AudioFeature,
  type AudioFrame,
  type AudioSnapshot,
  type AudioSource,
  type AudioStatus,
  audioStatusAllFalse,
  emptyAudioSnapshot,
  isAudioFrame,
  isAudioSnapshot,
  isAudioStatus,
} from "@/sdk/scene";

/** 与 Rust `audio_reactive::model::AUDIO_EVENT` 保持一致。 */
export const WALLPAPER_AUDIO_EVENT = "wallpaper-audio";

export type WallpaperAudioConnectOptions = {
  sources: readonly AudioSource[];
  features: readonly AudioFeature[];
};

export type WallpaperAudioConnection = {
  /** 连接（含首批快照）就绪；失败也会 resolve，状态为 not-supported。 */
  readonly whenReady: Promise<void>;
  getSnapshot(): AudioSnapshot;
  getStatus(): AudioStatus;
  /** 订阅帧批次；返回同步退订函数。 */
  subscribeFrames(listener: (frames: AudioFrame[]) => void): () => void;
  /** 订阅状态变化；注册时立即回放当前状态。 */
  subscribeStatus(listener: (status: AudioStatus) => void): () => void;
  disconnect(): void;
};

type AudioEventEnvelope =
  | {
      v: typeof AUDIO_PROTOCOL;
      type: "frame";
      timestamp: number;
      sequence: number;
      frames: AudioFrame[];
    }
  | { v: typeof AUDIO_PROTOCOL; type: "status"; status: AudioStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAudioEventEnvelope(
  value: unknown,
): value is AudioEventEnvelope {
  if (!isRecord(value) || value.v !== AUDIO_PROTOCOL) return false;
  if (value.type === "frame") {
    if (
      typeof value.timestamp !== "number" ||
      !Number.isFinite(value.timestamp) ||
      typeof value.sequence !== "number" ||
      !Number.isFinite(value.sequence)
    ) {
      return false;
    }
    return Array.isArray(value.frames) && value.frames.every(isAudioFrame);
  }
  if (value.type === "status") return isAudioStatus(value.status);
  return false;
}

function readConnectResult(
  value: unknown,
): { snapshot: AudioSnapshot; status: AudioStatus } | null {
  if (!isRecord(value)) return null;
  if (!isAudioSnapshot(value.snapshot) || !isAudioStatus(value.status)) {
    return null;
  }
  return { snapshot: value.snapshot, status: value.status };
}

/** 无 Tauri（浏览器预览）时的空连接，行为与旧宿主一致：静默不可用。 */
function unavailableConnection(): WallpaperAudioConnection {
  let status = audioStatusAllFalse("not-supported");
  let snapshot = emptyAudioSnapshot();
  return {
    whenReady: Promise.resolve(),
    getSnapshot: () => snapshot,
    getStatus: () => status,
    subscribeFrames: () => () => {},
    subscribeStatus(listener) {
      listener(status);
      return () => {};
    },
    disconnect() {
      status = audioStatusAllFalse("not-supported");
      snapshot = emptyAudioSnapshot();
    },
  };
}

/**
 * 订阅宿主音频响应。
 *
 * 返回对象立即可用（快照为空、状态 inactive），`whenReady` 在 Rust 返回首批
 * 快照/状态后 resolve；期间到达的帧仍会照常分发给监听者。
 */
export function connectWallpaperAudio(
  options: WallpaperAudioConnectOptions,
): WallpaperAudioConnection {
  if (!hasTauriRuntime()) return unavailableConnection();
  const label = currentWindowLabel();
  if (!label) {
    console.error("[scene] 当前壁纸窗口没有 label，跳过音频响应订阅");
    return unavailableConnection();
  }

  let status: AudioStatus = audioStatusAllFalse("inactive");
  let snapshot = emptyAudioSnapshot();
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  // audio_connect 是否已在 Rust 侧注册成功；卸载可能发生在连接完成之前。
  let registered = false;
  const frameListeners = new Set<(frames: AudioFrame[]) => void>();
  const statusListeners = new Set<(status: AudioStatus) => void>();

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const notifyStatus = (): void => {
    for (const listener of [...statusListeners]) listener(status);
  };

  const handle = (payload: unknown): void => {
    if (disposed || !isAudioEventEnvelope(payload)) return;
    if (payload.type === "status") {
      status = payload.status;
      notifyStatus();
      return;
    }
    if (payload.frames.length === 0) return;
    const sources = { ...snapshot.sources };
    for (const frame of payload.frames) sources[frame.source] = frame;
    snapshot = {
      protocol: AUDIO_PROTOCOL,
      timestamp: payload.timestamp,
      sources,
    };
    for (const listener of [...frameListeners]) listener(payload.frames);
  };

  const connection: WallpaperAudioConnection = {
    whenReady: ready,
    getSnapshot: () => snapshot,
    getStatus: () => status,
    subscribeFrames(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    disconnect() {
      if (disposed) return;
      disposed = true;
      frameListeners.clear();
      statusListeners.clear();
      unlisten?.();
      unlisten = null;
      if (registered) {
        void invoke("audio_disconnect").catch(() => {});
      }
    },
  };

  void (async () => {
    try {
      // 先监听再注册，避免 connect 返回与首个 tick 之间丢帧。
      unlisten = await listen<unknown>(
        WALLPAPER_AUDIO_EVENT,
        (event) => handle(event.payload),
        { target: { kind: "AnyLabel", label } },
      );
      if (disposed) {
        unlisten?.();
        unlisten = null;
        return;
      }
      const result = readConnectResult(
        await invoke<unknown>("audio_connect", {
          request: {
            sources: options.sources,
            features: options.features,
          },
        }),
      );
      registered = true;
      if (disposed) return;
      if (result) {
        snapshot = result.snapshot;
        status = result.status;
      } else {
        status = audioStatusAllFalse("not-supported");
      }
    } catch (error) {
      if (!disposed) {
        status = audioStatusAllFalse("not-supported");
        console.warn("[scene] 订阅音频响应失败", error);
      }
    } finally {
      // 连接完成前就卸载：此时才具备向 Rust 退订的条件。
      if (disposed && registered) {
        void invoke("audio_disconnect").catch(() => {});
      }
      if (!disposed) notifyStatus();
      resolveReady();
    }
  })();

  return connection;
}
