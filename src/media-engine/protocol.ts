/** Rust `media::engine::ENGINE_PROTOCOL` 必须与该值一致。 */
export const ENGINE_PROTOCOL = 3 as const;

import type { AudioBands, AudioSource } from "@/sdk/scene";

export type PlaybackSource = { kind: "asset"; url: string };

export type NoiseLayer = {
  soundId: string;
  enabled: boolean;
  volume: number;
};

export type NoiseTrackSource =
  | { kind: "procedural"; profile: string; version: number }
  | { kind: "asset"; assetKey: string; url: string };

export type NoiseTrackCommand = {
  trackId: string;
  assetId: string;
  source: NoiseTrackSource;
  volume: number;
  enabled: boolean;
  loop: boolean;
  fadeInMs: number | null;
  fadeOutMs: number | null;
  state: "playing" | "paused" | "stopped";
  /** Optional multi-source environment curve; ordinary tracks retain their existing source. */
  environment?: {
    type: string;
    intensity: number;
    anchors: Array<{
      assetId: string;
      intensity: number;
      source: NoiseTrackSource;
    }>;
  };
};

export type NoiseSessionCommand = {
  v: typeof ENGINE_PROTOCOL;
  type: "noise.session.sync";
  state: "idle" | "playing" | "paused";
  master: number;
  muted: boolean;
  tracks: NoiseTrackCommand[];
};

export type EngineCommand =
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "player.load";
      loadId: string;
      source: PlaybackSource;
      positionMs: number;
      durationMs: number | null;
      autoplay: boolean;
    }
  | { v: typeof ENGINE_PROTOCOL; type: "player.play" }
  | { v: typeof ENGINE_PROTOCOL; type: "player.pause" }
  | { v: typeof ENGINE_PROTOCOL; type: "player.stop" }
  | { v: typeof ENGINE_PROTOCOL; type: "player.seek"; positionMs: number }
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "player.volume";
      volume: number;
      muted: boolean;
    }
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "output.volume";
      volume: number;
      muted: boolean;
    }
  | NoiseSessionCommand
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "meters";
      player: boolean;
      noise: boolean;
      intervalMs: number;
    }
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "audio.analyze";
      /** 空数组 = 停止分析（保留节点，只停读取）。 */
      sources: AudioSource[];
      bands: boolean;
      intervalMs: number;
    }
  | { v: typeof ENGINE_PROTOCOL; type: "engine.shutdown" };

export type PlayerStatus = "playing" | "paused" | "ended" | "error";

/** 引擎侧的原始测量；时间戳与 normalized 由 Rust 统一赋予。 */
export type EngineAudioFrame = {
  source: AudioSource;
  active: boolean;
  level: { rms: number; peak: number };
  bands: AudioBands;
};

export type EngineEvent =
  | { type: "ready"; instanceId: string }
  | { type: "player.loaded"; loadId: string; durationMs: number | null }
  | {
      type: "player.state";
      loadId: string;
      status: PlayerStatus;
      positionMs: number;
      durationMs: number | null;
      error?: { code: string; message: string };
    }
  | { type: "player.progress"; loadId: string; positionMs: number }
  | { type: "levels"; player: number; noise: number }
  | { type: "audio.frame"; frames: EngineAudioFrame[] }
  | {
      type: "audio.status";
      available: boolean;
      reason?: "not-supported" | "inactive";
    }
  | {
      type: "error";
      scope: "player" | "noise";
      code: string;
      message: string;
    };
