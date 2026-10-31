import type { AmbientPreset } from "./preset";

/** Rust `media::engine::ENGINE_PROTOCOL` 必须与该值一致。 */
export const ENGINE_PROTOCOL = 2 as const;

export type PlaybackSource =
  | { kind: "ambient"; preset: AmbientPreset }
  | { kind: "asset"; url: string };

export type NoiseLayer = {
  soundId: string;
  enabled: boolean;
  volume: number;
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
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "noise.sync";
      active: boolean;
      master: number;
      muted: boolean;
      layers: NoiseLayer[];
    }
  | {
      v: typeof ENGINE_PROTOCOL;
      type: "meters";
      player: boolean;
      noise: boolean;
      intervalMs: number;
    }
  | { v: typeof ENGINE_PROTOCOL; type: "engine.shutdown" };

export type PlayerStatus = "playing" | "paused" | "ended" | "error";

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
  | {
      type: "error";
      scope: "player" | "noise";
      code: string;
      message: string;
    };
