/**
 * `scene.audio`：音频响应的场景侧实现。
 *
 * 只消费宿主下发的标准化 `AudioFrame`：不接触 PCM、不控制播放/音量。
 * 数据来自独立消息通道（`audio.*`），与 `frame` / `pointer` 的频率解耦。
 */
import {
  type AudioFeature,
  type AudioFrame,
  type AudioSnapshot,
  type AudioSource,
  type AudioStatus,
  type AudioSubscribeOptions,
  audioStatusAllFalse,
  emptyAudioSnapshot,
  normalizeAudioFeatures,
  normalizeAudioSources,
} from "./audio-types.js";
import {
  SCENE_PROTOCOL,
  type SceneAudioHostMessage,
  type SceneAudioPluginMessage,
} from "./protocol.js";

/** 音频响应查询快照的超时；超时返回空快照而不是让场景挂起。 */
export const AUDIO_SNAPSHOT_TIMEOUT_MS = 1000;

/** `hostApi` 从该版本起支持 `wallpaper.audio`。 */
export const AUDIO_HOST_API = 5;

export interface SceneAudioAPI {
  /** 当前快照；无数据/未授权时返回全 `null` 快照（不 reject）。 */
  getSnapshot(): Promise<AudioSnapshot>;
  /** 订阅增量帧；注册时回放缓存中匹配的帧。 */
  onData(
    callback: (frame: AudioFrame) => void,
    options?: AudioSubscribeOptions,
  ): () => void;
  /** 订阅可用性变化；注册时立即回放当前状态。 */
  onStatus(callback: (status: AudioStatus) => void): () => void;
  /** 清理监听与定时器；销毁后不再发送/接收音频消息。 */
  destroy(): void;
}

type AudioListener = {
  callback: (frame: AudioFrame) => void;
  sources: ReadonlySet<AudioSource>;
  features: ReadonlySet<AudioFeature>;
};

type PendingSnapshot = {
  resolve: (snapshot: AudioSnapshot) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** client 内部使用的扩展接口；不对外导出。 */
export type SceneAudioHandle = SceneAudioAPI & {
  handleMessage(message: SceneAudioHostMessage): void;
};

export type CreateSceneAudioApiOptions = {
  /** 发往宿主的消息；由 client 注入 transport。 */
  send: (message: SceneAudioPluginMessage) => void;
  /** 宿主 API 版本；init 之前返回 0。 */
  hostApi: () => number;
};

export function createSceneAudioApi(
  options: CreateSceneAudioApiOptions,
): SceneAudioHandle {
  let disposed = false;
  let status: AudioStatus = audioStatusAllFalse("inactive");
  let snapshot: AudioSnapshot | null = null;
  const dataListeners = new Set<AudioListener>();
  const statusListeners = new Set<(status: AudioStatus) => void>();
  const pending = new Map<string, PendingSnapshot>();
  let requestSeq = 0;
  let subscribeScheduled = false;

  const supported = (): boolean => options.hostApi() >= AUDIO_HOST_API;

  const notifyStatus = (): void => {
    for (const listener of [...statusListeners]) listener(status);
  };

  const degrade = (): void => {
    if (status.available || status.reason !== "not-supported") {
      status = audioStatusAllFalse("not-supported");
      notifyStatus();
    }
  };

  const resolvePending = (value: AudioSnapshot): void => {
    for (const [requestId, entry] of [...pending]) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.resolve(value);
    }
  };

  const flushSubscribe = (): void => {
    if (disposed || !supported()) return;
    if (dataListeners.size === 0) {
      options.send({ v: SCENE_PROTOCOL, type: "audio.unsubscribe" });
      return;
    }
    const sources = new Set<AudioSource>();
    const features = new Set<AudioFeature>();
    for (const listener of dataListeners) {
      for (const source of listener.sources) sources.add(source);
      for (const feature of listener.features) features.add(feature);
    }
    options.send({
      v: SCENE_PROTOCOL,
      type: "audio.subscribe",
      options: { sources: [...sources], features: [...features] },
    });
  };

  const scheduleSubscribe = (): void => {
    if (subscribeScheduled) return;
    subscribeScheduled = true;
    queueMicrotask(() => {
      subscribeScheduled = false;
      flushSubscribe();
    });
  };

  const updateSnapshot = (frames: readonly AudioFrame[]): void => {
    if (frames.length === 0) return;
    let latest = snapshot;
    const accepted: AudioFrame[] = [];
    for (const frame of frames) {
      if (latest && frame.timestamp < latest.timestamp) continue;
      accepted.push(frame);
      const sources = latest
        ? { ...latest.sources }
        : {
            music: null,
            noise: null,
            mix: null,
            master: null,
          };
      sources[frame.source] = frame;
      latest = {
        protocol: frame.protocol,
        timestamp: frame.timestamp,
        sources,
      };
    }
    snapshot = latest;
    for (const frame of accepted) {
      for (const listener of [...dataListeners]) {
        if (listener.sources.has(frame.source)) listener.callback(frame);
      }
    }
  };

  const api: SceneAudioHandle = {
    getSnapshot() {
      if (disposed || !supported()) {
        if (!supported()) degrade();
        return Promise.resolve(snapshot ?? emptyAudioSnapshot());
      }
      if (snapshot) return Promise.resolve(snapshot);
      const requestId = `audio-${++requestSeq}`;
      return new Promise<AudioSnapshot>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve(emptyAudioSnapshot());
        }, AUDIO_SNAPSHOT_TIMEOUT_MS);
        pending.set(requestId, { resolve, timer });
        options.send({
          v: SCENE_PROTOCOL,
          type: "audio.requestSnapshot",
          requestId,
        });
      });
    },

    onData(callback, subscribeOptions) {
      if (disposed) return () => {};
      const sources = normalizeAudioSources(subscribeOptions?.sources);
      const features = normalizeAudioFeatures(subscribeOptions?.features);
      const listener: AudioListener = {
        callback,
        sources: new Set(sources),
        features: new Set(features),
      };
      dataListeners.add(listener);
      if (!supported()) {
        degrade();
        return () => {
          dataListeners.delete(listener);
        };
      }
      scheduleSubscribe();
      // 注册时回放缓存中匹配的帧，避免场景等下一个 20Hz tick。
      if (snapshot) {
        for (const source of sources) {
          const frame = snapshot.sources[source];
          if (frame) callback(frame);
        }
      }
      return () => {
        if (!dataListeners.delete(listener)) return;
        scheduleSubscribe();
      };
    },

    onStatus(callback) {
      statusListeners.add(callback);
      callback(status);
      return () => {
        statusListeners.delete(callback);
      };
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      dataListeners.clear();
      statusListeners.clear();
      for (const [requestId, entry] of [...pending]) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
        entry.resolve(emptyAudioSnapshot());
      }
    },

    handleMessage(message) {
      if (disposed) return;
      if (message.type === "audio.init") {
        snapshot = message.snapshot;
        status = message.status;
        resolvePending(message.snapshot);
        notifyStatus();
        return;
      }
      if (message.type === "audio.frame") {
        updateSnapshot(message.frames);
        return;
      }
      if (message.type === "audio.status") {
        status = message.status;
        notifyStatus();
        return;
      }
      const entry = pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.requestId);
      snapshot = message.snapshot;
      entry.resolve(message.snapshot);
    },
  };

  return api;
}

/**
 * 场景渲染循环里的推荐插值：attack 快、release 慢，dt 使用真实帧间隔。
 *
 * 20Hz 数据直接驱动渲染会有阶梯感；把返回值直接写进视觉参数即可。
 */
export function smoothAudioValue(
  current: number,
  target: number,
  dtMs: number,
  options: { attackMs?: number; releaseMs?: number } = {},
): number {
  const attack = options.attackMs ?? 90;
  const release = options.releaseMs ?? 300;
  const from = Number.isFinite(current) ? Math.min(1, Math.max(0, current)) : 0;
  const to = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  const tau = to > from ? attack : release;
  const alpha = tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return Math.min(1, Math.max(0, from + (to - from) * alpha));
}

/** 便捷包络：持续跟踪一个 0–1 目标值。 */
export function createAudioEnvelope(
  options: { attackMs?: number; releaseMs?: number } = {},
): {
  update(target: number, dtMs: number): number;
  get value(): number;
  reset(): void;
} {
  let value = 0;
  return {
    update(target, dtMs) {
      value = smoothAudioValue(value, target, dtMs, options);
      return value;
    },
    get value() {
      return value;
    },
    reset() {
      value = 0;
    },
  };
}
